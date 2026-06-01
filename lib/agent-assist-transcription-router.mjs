import { randomUUID } from "crypto";
import { getPostgresPool } from "./postgres.mjs";
import { broadcastToKey } from "./sse.js";

const globalAny = globalThis;
if (!globalAny.__agentAssistRecentTranscriptionCache) {
  globalAny.__agentAssistRecentTranscriptionCache = new Map();
}
if (!globalAny.__agentAssistActiveTranscriptionMessages) {
  globalAny.__agentAssistActiveTranscriptionMessages = new Map();
}

const recentTranscriptionCache = globalAny.__agentAssistRecentTranscriptionCache;
const activeTranscriptionMessages = globalAny.__agentAssistActiveTranscriptionMessages;
const TRANSCRIPTION_DEDUPE_WINDOW_MS = 5000;

function safeParse(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function normalizeInteraction(row) {
  if (!row) return null;
  return {
    ...row,
    required_skills: safeParse(row.required_skills),
    routing_metadata: safeParse(row.routing_metadata),
    transfer_history: safeParse(row.transfer_history),
    tags: safeParse(row.tags),
    wrapup_codes: safeParse(row.wrapup_codes),
    metadata: safeParse(row.metadata),
  };
}

async function findInteractionByQuery(query, values) {
  const pool = getPostgresPool();
  if (!pool) return null;
  const result = await pool.query(query, values);
  return normalizeInteraction(result.rows?.[0]);
}

async function findInteractionByCallControlId(callControlId) {
  if (!callControlId) return null;
  return findInteractionByQuery(
    "SELECT * FROM cc_interactions WHERE call_control_id = $1 ORDER BY created_at DESC LIMIT 1",
    [callControlId],
  );
}

async function findInteractionByCallSessionId(callSessionId) {
  if (!callSessionId) return null;
  return findInteractionByQuery(
    "SELECT * FROM cc_interactions WHERE call_session_id = $1 ORDER BY created_at ASC LIMIT 1",
    [callSessionId],
  );
}

async function findInteractionById(id) {
  if (!id) return null;
  return findInteractionByQuery("SELECT * FROM cc_interactions WHERE id = $1", [id]);
}

function getTranscriptionLiveKey(callControlId, track) {
  return `${callControlId}:${track || "unknown"}`;
}

function getTranscriptionMessageKey(callControlId, track, isMessageFinal) {
  const liveKey = getTranscriptionLiveKey(callControlId, track);
  let messageKey = activeTranscriptionMessages.get(liveKey);
  if (!messageKey) {
    messageKey = `${liveKey}:${randomUUID()}`;
    activeTranscriptionMessages.set(liveKey, messageKey);
  }
  if (isMessageFinal) {
    activeTranscriptionMessages.delete(liveKey);
  }
  return messageKey;
}

async function broadcastAgentTranscription({ interaction, callControlId, transcriptionData, transcriptionKey }) {
  if (!interaction?.agent_username) return;
  await broadcastToKey(`contact-center:agent:${interaction.agent_username}`, {
    type: "transcription",
    interactionId: interaction.id,
    callControlId,
    transcriptionKey,
    transcription: {
      transcription_key: transcriptionKey,
      transcript: transcriptionData.transcript,
      track: transcriptionData.transcription_track,
      is_final: transcriptionData.is_final,
      speech_final: transcriptionData.speech_final,
      timestamp: new Date().toISOString(),
    },
  });
}

async function broadcastAgentTranscriptionUpdate({ interaction, callControlId, transcriptionKey, updates }) {
  if (!interaction?.agent_username || !transcriptionKey || !updates) return;
  await broadcastToKey(`contact-center:agent:${interaction.agent_username}`, {
    type: "transcription_update",
    interactionId: interaction.id,
    callControlId,
    transcriptionKey,
    updates,
  });
}

async function updateInteractionMetadata(interactionId, metadata) {
  const pool = getPostgresPool();
  if (!pool || !interactionId) return;
  await pool.query("UPDATE cc_interactions SET metadata = $2 WHERE id = $1", [
    interactionId,
    JSON.stringify(metadata || {}),
  ]);
}

async function findUserByUsername(username) {
  const pool = getPostgresPool();
  if (!pool || !username) return null;
  const result = await pool.query("SELECT * FROM users WHERE username = $1 LIMIT 1", [username]);
  return result.rows?.[0] || null;
}

const DEFAULT_TRANSLATION_VOICE = "Minimax.speech-2.8-turbo.English_magnetic_voiced_man";

async function processFinalTranscriptionEnhancements({
  interaction,
  callControlId,
  transcriptionData,
  transcriptionKey,
  assistConfig,
}) {
  const translationEnabled =
    assistConfig.assist_type === "workflows" &&
    assistConfig.enable_translation === true;
  const analysisEnabled =
    assistConfig.enable_intent_recognition === true ||
    assistConfig.enable_sentiment_analysis === true;
  const updates = {};

  if (analysisEnabled && transcriptionData.transcript) {
    const { analyzeTranscription } = await import("./agent-assist/sentiment-analysis.js");
    const analysis = await analyzeTranscription(transcriptionData.transcript);
    if (assistConfig.enable_intent_recognition === true) {
      updates.intent = analysis.intent;
      updates.tags = analysis.tags || [];
    }
    if (assistConfig.enable_sentiment_analysis === true) {
      updates.sentiment = analysis.sentiment;
      updates.sentimentScore = analysis.sentimentScore;
    }
  }

  if (translationEnabled && transcriptionData.transcript) {
    try {
      console.log("[AgentAssist] Translation enabled for interaction", interaction.id);
      const { translateText, detectLanguage } = await import("./agent-assist/translation-service.js");
      const { startChunkedSpeak } = await import("./contact-center/speak-queue.js");
      const agent = interaction.agent_username
        ? await findUserByUsername(interaction.agent_username)
        : null;
      const agentLanguage = agent?.language || "en-US";

      const metadataBase = { ...(interaction.metadata || {}) };
      let metadataChanged = false;

      if (agentLanguage && metadataBase.agent_language !== agentLanguage) {
        metadataBase.agent_language = agentLanguage;
        metadataChanged = true;
      }

      let callerLanguage = interaction.metadata?.caller_language || null;
      const detectedLanguage =
        transcriptionData.language ||
        transcriptionData.language_code ||
        transcriptionData.language_detected ||
        transcriptionData.language_id ||
        null;

      if (!callerLanguage && transcriptionData.transcription_track === "inbound") {
        if (detectedLanguage) {
          callerLanguage = detectedLanguage;
        } else {
          const detection = await detectLanguage(transcriptionData.transcript);
          if (detection?.language) {
            callerLanguage = detection.language;
          }
        }

        if (callerLanguage && metadataBase.caller_language !== callerLanguage) {
          metadataBase.caller_language = callerLanguage;
          metadataChanged = true;
        }
      }

      if (metadataChanged) {
        await updateInteractionMetadata(interaction.id, metadataBase);
      }

      const isCustomer = transcriptionData.transcription_track === "inbound";
      const sourceLanguage = isCustomer ? callerLanguage || "auto" : agentLanguage;
      const targetLanguage = isCustomer ? agentLanguage : callerLanguage;

      if (targetLanguage) {
        const translation = await translateText({
          text: transcriptionData.transcript,
          sourceLanguage,
          targetLanguage,
        });

        if (translation?.text) {
          updates.translation = {
            text: translation.text,
            sourceLanguage,
            targetLanguage,
            detectedSourceLanguage: translation.detectedSourceLanguage || null,
          };

          if (!callerLanguage && translation.detectedSourceLanguage && isCustomer) {
            if (metadataBase.caller_language !== translation.detectedSourceLanguage) {
              metadataBase.caller_language = translation.detectedSourceLanguage;
              await updateInteractionMetadata(interaction.id, metadataBase);
            }
            callerLanguage = translation.detectedSourceLanguage;
          }

          if (assistConfig.auto_send_response === true) {
            const metadata = interaction.metadata || {};
            const targetCallControlId = isCustomer
              ? metadata.agent_call_control_id
              : metadata.original_call_control_id;

            if (targetCallControlId) {
              await startChunkedSpeak(
                targetCallControlId,
                translation.text,
                DEFAULT_TRANSLATION_VOICE,
                targetLanguage
              );
            }
          }
        }
      }
    } catch (translationError) {
      console.warn("[AgentAssist] Translation processing failed:", translationError);
    }
  }

  if (Object.keys(updates).length > 0) {
    await broadcastAgentTranscriptionUpdate({
      interaction,
      callControlId,
      transcriptionKey,
      updates,
    });
  }
}

export async function routeAgentAssistTranscription(payload) {
  const callControlId = payload?.call_control_id;
  const transcriptionData = payload?.transcription_data;

  if (!callControlId || !transcriptionData) {
    return { routed: false, reason: "missing_payload" };
  }

  const track = transcriptionData.transcription_track || "unknown";
  const isProviderFinal = transcriptionData.is_final === true;
  const hasSpeechFinal = typeof transcriptionData.speech_final === "boolean";
  const isMessageFinal = hasSpeechFinal
    ? transcriptionData.speech_final === true
    : isProviderFinal;
  const dedupeKey = getTranscriptionLiveKey(callControlId, track);
  const nowMs = Date.now();

  if (isMessageFinal) {
    const lastSeen = recentTranscriptionCache.get(dedupeKey);
    if (
      lastSeen &&
      lastSeen.text === transcriptionData.transcript &&
      nowMs - lastSeen.ts < TRANSCRIPTION_DEDUPE_WINDOW_MS
    ) {
      console.log("[AgentAssist] Skipping duplicate transcription", dedupeKey);
      return { routed: false, reason: "duplicate" };
    }
    recentTranscriptionCache.set(dedupeKey, {
      text: transcriptionData.transcript,
      ts: nowMs,
    });
  }

  if (recentTranscriptionCache.size > 200) {
    for (const [key, value] of recentTranscriptionCache.entries()) {
      if (nowMs - value.ts > TRANSCRIPTION_DEDUPE_WINDOW_MS * 3) {
        recentTranscriptionCache.delete(key);
      }
    }
  }

  let interaction = await findInteractionByCallControlId(callControlId);
  if ((!interaction || !interaction.is_contact_center) && payload?.call_session_id) {
    interaction = await findInteractionByCallSessionId(payload.call_session_id);
  }
  if ((!interaction || !interaction.is_contact_center) && (payload?.interaction_id || payload?.interactionId)) {
    interaction = await findInteractionById(payload.interaction_id || payload.interactionId);
  }

  if (!interaction || !interaction.is_contact_center) {
    return { routed: false, reason: "interaction_not_found" };
  }

  const transcriptionKey = getTranscriptionMessageKey(callControlId, track, isMessageFinal);
  await broadcastAgentTranscription({
    interaction,
    callControlId,
    transcriptionData: {
      ...transcriptionData,
      is_final: isMessageFinal,
      provider_is_final: transcriptionData.is_final,
    },
    transcriptionKey,
  });

  if (isMessageFinal) {
    const assistConfig = interaction.metadata?.agent_assist_config || {};
    processFinalTranscriptionEnhancements({
      interaction,
      callControlId,
      transcriptionData: {
        ...transcriptionData,
        is_final: isMessageFinal,
        provider_is_final: transcriptionData.is_final,
      },
      transcriptionKey,
      assistConfig,
    }).catch((error) => {
      console.warn("[AgentAssist] Final transcription enhancements failed:", error);
    });
  }

  return { routed: true, interactionId: interaction.id, transcriptionKey };
}
