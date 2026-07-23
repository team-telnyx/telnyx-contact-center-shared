import { getPostgresPool } from "./postgres.mjs";
import { broadcastToKey } from "./sse.js";
import { normalizeLanguageCode } from "./language-code-utils.js";
import { agentAssistRuntimePayload, translationLogger, workflowLogger } from "./agent-assist/logging.mjs";
import {
  getTranscriptionLiveKey,
  getTranscriptionMessageKey,
  normalizeTranscriptionLeg,
} from "./agent-assist/transcription-turns.mjs";

const globalAny = globalThis;
if (!globalAny.__agentAssistRecentTranscriptionCache) {
  globalAny.__agentAssistRecentTranscriptionCache = new Map();
}
if (!globalAny.__agentAssistActiveTranscriptionSegments) {
  globalAny.__agentAssistActiveTranscriptionSegments = new Map();
}

const recentTranscriptionCache = globalAny.__agentAssistRecentTranscriptionCache;
const activeTranscriptionSegments = globalAny.__agentAssistActiveTranscriptionSegments;
const TRANSCRIPTION_DEDUPE_WINDOW_MS = 5000;

function compactTranscriptText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function joinTranscriptSegments(...parts) {
  return compactTranscriptText(parts.filter(Boolean).join(" "));
}

function mergeTranscriptSegment(existing, incoming) {
  const current = compactTranscriptText(existing);
  const next = compactTranscriptText(incoming);
  if (!current) return next;
  if (!next) return current;
  if (next.startsWith(current) || current.includes(next)) return next.length > current.length ? next : current;
  if (current.endsWith(next)) return current;
  return joinTranscriptSegments(current, next);
}

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
    `SELECT * FROM cc_interactions
      WHERE call_control_id = $1
         OR metadata->>'original_call_control_id' = $1
         OR metadata->>'agent_call_control_id' = $1
      ORDER BY created_at DESC
      LIMIT 1`,
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

function clearOpposingTranscriptionSegments(callControlId, track) {
  if (!callControlId) return;
  const leg = normalizeTranscriptionLeg(track);
  const prefix = `${callControlId}:`;
  for (const liveKey of activeTranscriptionSegments.keys()) {
    if (!liveKey.startsWith(prefix)) continue;
    const otherTrack = liveKey.slice(prefix.length);
    if (normalizeTranscriptionLeg(otherTrack) !== leg) {
      activeTranscriptionSegments.delete(liveKey);
    }
  }
}

function buildDisplayTranscript({ callControlId, track, transcriptionData, isMessageFinal }) {
  const liveKey = getTranscriptionLiveKey(callControlId, track);
  const transcript = compactTranscriptText(transcriptionData.transcript);
  const isProviderFinal = transcriptionData.is_final === true;
  const existingFinalSegments = activeTranscriptionSegments.get(liveKey) || "";

  if (!transcript) return existingFinalSegments;

  if (isMessageFinal) {
    const completeTranscript = mergeTranscriptSegment(existingFinalSegments, transcript);
    activeTranscriptionSegments.delete(liveKey);
    return completeTranscript;
  }

  if (isProviderFinal) {
    const updatedFinalSegments = mergeTranscriptSegment(existingFinalSegments, transcript);
    activeTranscriptionSegments.set(liveKey, updatedFinalSegments);
    return updatedFinalSegments;
  }

  return joinTranscriptSegments(existingFinalSegments, transcript);
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
      confidence: transcriptionData.confidence,
      source: transcriptionData.source,
      provider: transcriptionData.provider,
      model: transcriptionData.model,
      language: transcriptionData.language || transcriptionData.language_code || null,
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

async function resolveAgentAssistAnalysisModel(assistConfig = {}) {
  if (assistConfig.llm_model) return assistConfig.llm_model;

  const workflowId = assistConfig.workflow_id;
  if (!workflowId) return undefined;

  try {
    const pool = getPostgresPool();
    if (!pool) return undefined;
    const { rows: [workflow] } = await pool.query(
      "SELECT llm_model FROM aa_workflows WHERE id = $1",
      [workflowId],
    );
    return workflow?.llm_model || undefined;
  } catch (error) {
    workflowLogger.warn("workflow_llm_model_resolve_failed", agentAssistRuntimePayload({ error, workflowId }));
    return undefined;
  }
}

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
    const analysisModel = await resolveAgentAssistAnalysisModel(assistConfig);
    const analysis = await analyzeTranscription(transcriptionData.transcript, { model: analysisModel });
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
      translationLogger.info("translation_enabled", agentAssistRuntimePayload({ interactionId: interaction.id }));
      const { translateText } = await import("./agent-assist/translation-service.js");
      const { startChunkedSpeak } = await import("./contact-center/speak-queue.js");
      const translationModel = await resolveAgentAssistAnalysisModel(assistConfig);
      const agent = interaction.agent_username
        ? await findUserByUsername(interaction.agent_username)
        : null;
      const agentLanguage = normalizeLanguageCode(agent?.language, { fallback: "en" });

      const metadataBase = { ...(interaction.metadata || {}) };
      let metadataChanged = false;

      if (agentLanguage && metadataBase.agent_language !== agentLanguage) {
        metadataBase.agent_language = agentLanguage;
        metadataChanged = true;
      }

      const callerLanguage = normalizeLanguageCode(interaction.metadata?.caller_language, { fallback: null });

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
          model: translationModel,
        });

        if (translation?.text) {
          updates.translation = {
            text: translation.text,
            sourceLanguage,
            targetLanguage,
            detectedSourceLanguage: translation.detectedSourceLanguage || null,
          };


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
      translationLogger.warn("translation_processing_failed", agentAssistRuntimePayload({ error: translationError, interactionId: interaction.id }));
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
    const isPerLegDup =
      lastSeen &&
      lastSeen.text === transcriptionData.transcript &&
      nowMs - lastSeen.ts < TRANSCRIPTION_DEDUPE_WINDOW_MS;
    if (!isPerLegDup) {
      recentTranscriptionCache.set(dedupeKey, {
        text: transcriptionData.transcript,
        ts: nowMs,
      });
    }

    // Cross-leg dedup: same audio can arrive on two conference legs or via both
    // the standalone-STT WebSocket path and a call.transcription webhook. Key on
    // session + direction + text. Seed the key even when isPerLegDup is true so
    // that a subsequent arrival on a different conference leg (different
    // callControlId) finds the entry and is dropped by webhook-handler.js.
    if (payload?.call_session_id) {
      const crossLegKey = `session:${payload.call_session_id}:${normalizeTranscriptionLeg(track)}:${transcriptionData.transcript}`;
      const lastSeenCrossLeg = recentTranscriptionCache.get(crossLegKey);
      const crossLegExpired = !lastSeenCrossLeg || nowMs - lastSeenCrossLeg.ts >= TRANSCRIPTION_DEDUPE_WINDOW_MS;
      if (crossLegExpired) {
        // Refresh when absent OR expired: a repeated phrase after the window
        // must reset the timestamp so the next cross-leg duplicate is caught.
        recentTranscriptionCache.set(crossLegKey, { text: transcriptionData.transcript, ts: nowMs });
      }
      if (isPerLegDup || !crossLegExpired) {
        workflowLogger.debug("duplicate_transcription_skipped", agentAssistRuntimePayload({ reason: isPerLegDup ? "duplicate" : "cross_leg_duplicate" }));
        return { routed: false, reason: isPerLegDup ? "duplicate" : "cross_leg_duplicate" };
      }
    } else if (isPerLegDup) {
      workflowLogger.debug("duplicate_transcription_skipped", agentAssistRuntimePayload({ reason: "duplicate" }));
      return { routed: false, reason: "duplicate" };
    }
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
    workflowLogger.info("workflow_transcription_skipped", agentAssistRuntimePayload({
      reason: "interaction_not_found",
      callControlId,
      callSessionId: payload?.call_session_id || null,
    }));
    return { routed: false, reason: "interaction_not_found" };
  }

  // Interaction-level dedup: the same agent utterance can arrive via two
  // standalone-STT sessions with opposite direction labels — one on the
  // conference-stream leg (picks up agent audio from the mix, labeled
  // "inbound") and one on the agent's own leg (labeled "outbound"). They have
  // different callControlIds so per-leg dedup misses them; the conference-stream
  // session has no call_session_id so cross-leg dedup is skipped too.
  // Use direction-specific keys (itr:<id>:<leg>:<text>) to avoid suppressing a
  // legitimate second-speaker turn when both parties say the same short phrase
  // within the window.
  // The conference-stream duplicate arrives with the opposite direction label,
  // so we also check the other-direction key using a tight 1500ms window.
  // Same-audio duplicates from two STT sessions processing the same audio event
  // fire within tens-to-hundreds of milliseconds; a real cross-speaker exchange
  // in healthcare intake always has at least a conversational pause (>1 s) between
  // the patient finishing and the agent responding. The tight window catches
  // genuine duplicates regardless of which session arrives first or whether
  // either has a call_session_id.
  // Use the full accumulated turn (prior is_final segments merged with the
  // current chunk) so sessions that segment the same audio differently produce
  // the same dedup key.
  if (isMessageFinal && transcriptionData.transcript) {
    const itrLiveKey = getTranscriptionLiveKey(callControlId, track);
    const priorSegments = activeTranscriptionSegments.get(itrLiveKey) || "";
    const itrText = mergeTranscriptSegment(priorSegments, compactTranscriptText(transcriptionData.transcript));
    const ownLeg = normalizeTranscriptionLeg(track);
    const otherLeg = ownLeg === "inbound" ? "outbound" : "inbound";
    // Source-tagged keys: itr-r (router/standalone-STT) vs itr-w (webhook).
    const itrKeyROOwn   = `itr-r:${interaction.id}:${ownLeg}:${itrText}`;
    const itrKeyROther  = `itr-r:${interaction.id}:${otherLeg}:${itrText}`;
    const itrKeyWOwn    = `itr-w:${interaction.id}:${ownLeg}:${itrText}`;
    // itr-w:otherLeg is intentionally not checked here. When the webhook seeds
    // itr-w:outbound first, the agent-leg router session (also outbound) catches
    // it via seenWOwn and also seeds itr-r:outbound on suppression, so the
    // conference-stream copy (inbound) will find itr-r:outbound via seenROther.
    // Checking itr-w:otherLeg would risk suppressing a real customer turn on the
    // conference stream when the agent recently said the same short phrase via webhook.
    const seenROOwn  = recentTranscriptionCache.get(itrKeyROOwn);
    const seenROther = recentTranscriptionCache.get(itrKeyROther);
    const seenWOwn   = recentTranscriptionCache.get(itrKeyWOwn);
    const isDup =
      (seenROOwn  && nowMs - seenROOwn.ts  < TRANSCRIPTION_DEDUPE_WINDOW_MS) ||
      (seenROther && nowMs - seenROther.ts < 1500) ||
      (seenWOwn   && nowMs - seenWOwn.ts   < TRANSCRIPTION_DEDUPE_WINDOW_MS);
    if (isDup) {
      // Seed own-direction key when absent or expired so a delayed Telnyx webhook
      // can find itr-r:ownLeg via seenROOwn. Do not overwrite an unexpired entry:
      // refreshing its timestamp would extend the 5s window on late-arriving
      // copies and suppress real repeated phrases. An expired entry is treated
      // as absent so a phrase repeated after >5s gets a fresh anchor timestamp.
      if (!seenROOwn || nowMs - seenROOwn.ts >= TRANSCRIPTION_DEDUPE_WINDOW_MS) {
        recentTranscriptionCache.set(itrKeyROOwn, { ts: nowMs });
      }
      // Finalize this leg's state before returning so the next utterance on
      // the same callControlId/track starts fresh rather than inheriting stale
      // segments and an open bubble from the skipped turn.
      activeTranscriptionSegments.delete(itrLiveKey);
      getTranscriptionMessageKey(callControlId, track, true);
      clearOpposingTranscriptionSegments(callControlId, track);
      workflowLogger.debug("duplicate_transcription_skipped", agentAssistRuntimePayload({ reason: "interaction_duplicate" }));
      return { routed: false, reason: "interaction_duplicate" };
    }
    recentTranscriptionCache.set(itrKeyROOwn, { ts: nowMs });
  }

  const displayTranscript = buildDisplayTranscript({
    callControlId,
    track,
    transcriptionData,
    isMessageFinal,
  });
  const transcriptionKey = getTranscriptionMessageKey(callControlId, track, isMessageFinal);
  if (isMessageFinal) {
    // A finalized utterance is a conversational turn boundary. The message key
    // for the opposite leg's open bubble was already rotated inside
    // getTranscriptionMessageKey; clear its accumulated display segments too so
    // the next utterance on that leg does not inherit stale partial text.
    clearOpposingTranscriptionSegments(callControlId, track);
  }
  await broadcastAgentTranscription({
    interaction,
    callControlId,
    transcriptionData: {
      ...transcriptionData,
      transcript: displayTranscript || transcriptionData.transcript,
      is_final: isMessageFinal,
      provider_is_final: transcriptionData.is_final,
    },
    transcriptionKey,
  });

  if (isMessageFinal) {
    const assistConfig = interaction.metadata?.agent_assist_config || {};
    workflowLogger.info("workflow_transcription_routed", agentAssistRuntimePayload({
      interactionId: interaction.id,
      callControlId,
      workflowId: assistConfig.workflow_id || null,
      assistType: assistConfig.assist_type || null,
      track,
      transcriptLength: String(displayTranscript || transcriptionData.transcript || "").length,
      provider: transcriptionData.provider || null,
      language: transcriptionData.language || transcriptionData.language_code || null,
      confidence: transcriptionData.confidence,
    }));
    processFinalTranscriptionEnhancements({
      interaction,
      callControlId,
      transcriptionData: {
        ...transcriptionData,
        transcript: displayTranscript || transcriptionData.transcript,
        is_final: isMessageFinal,
        provider_is_final: transcriptionData.is_final,
      },
      transcriptionKey,
      assistConfig,
    }).catch((error) => {
      workflowLogger.warn("final_transcription_enhancements_failed", agentAssistRuntimePayload({ error, interactionId: interaction.id }));
    });
    import("./call-generator/workflow-testing.mjs").then(({ handleWorkflowTestingFinalTranscription }) => handleWorkflowTestingFinalTranscription({
      pool: getPostgresPool(),
      interaction,
      payload,
      transcriptionData: {
        ...transcriptionData,
        transcript: displayTranscript || transcriptionData.transcript,
        is_final: isMessageFinal,
        provider_is_final: transcriptionData.is_final,
      },
      assistConfig,
    })).catch((error) => {
      workflowLogger.warn("workflow_testing_transcription_reply_failed", agentAssistRuntimePayload({ error, interactionId: interaction.id }));
    });
  }

  return { routed: true, interactionId: interaction.id, transcriptionKey };
}
