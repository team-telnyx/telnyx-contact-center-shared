import { normalizeLanguageCode } from "../language-code-utils.js";
import { getPostgresPool } from "../postgres.mjs";
import { buildTelnyxV2Url } from "../telnyx.js";
import {
  cancelQueue,
  advanceQueue,
  isTranscriptionSuppressed,
  resumeTranscriptionIfPaused,
} from "../contact-center/speak-queue.js";
import {
  cancelQueueAudioSession,
  isQueuePositionClientState,
  markQueuePositionStarted,
  resumeQueueMedia,
} from "../contact-center/queue-audio-service.js";
import { routeAgentAssistTranscription } from "../agent-assist-transcription-router.mjs";
import {
  startTelnyxSttMediaStream,
  startTelnyxSttTranscription,
  stopTelnyxSttTranscription,
} from "../telnyx-stt-handler.mjs";
import {
  findInteractionViewByCallControlId,
  findInteractionViewByCallSessionId,
} from "./work-item-repository.mjs";
import { isAcdAgentMediaEvent } from "../contact-center/acd-media-leg.mjs";

function decodeClientState(value) {
  if (!value || typeof value !== "string") return {};
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded
      : {};
  } catch {
    return {};
  }
}

async function findCoreInteraction(pool, payload) {
  const callControlId = payload?.call_control_id || null;
  const callSessionId = payload?.call_session_id || null;
  const byLeg = callControlId
    ? await findInteractionViewByCallControlId(pool, callControlId)
    : null;
  if (byLeg || !callSessionId) return byLeg;
  return findInteractionViewByCallSessionId(pool, callSessionId);
}

async function linkAiConversation(pool, interaction, payload) {
  const conversationId =
    payload?.conversation_id || payload?.conversationId || payload?.conversation?.id || null;
  const aiCallControlId = interaction?.metadata?.ai_call_control_id || null;
  if (!conversationId || !aiCallControlId) {
    return { handled: true, linked: false };
  }

  const apiKey = process.env.TELNYX_API_KEY;
  if (apiKey) {
    const url = buildTelnyxV2Url(`/ai/conversations/${encodeURIComponent(conversationId)}`);
    const current = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });
    if (!current.ok) throw new Error(`AI conversation lookup returned HTTP ${current.status}`);
    const body = await current.json();
    const metadata = body?.data?.metadata && typeof body.data.metadata === "object"
      ? body.data.metadata
      : {};
    const updated = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        metadata: { ...metadata, call_control_id: String(aiCallControlId) },
      }),
    });
    if (!updated.ok) throw new Error(`AI conversation update returned HTTP ${updated.status}`);
  }

  await pool.query(
    `UPDATE acd_work_items
        SET attributes = attributes || jsonb_build_object('ai_conversation_id', $2::text),
            version = version + 1
      WHERE id = $1`,
    [interaction.id, String(conversationId)],
  );
  return { handled: true, linked: true, workItemId: interaction.id };
}

function transcriptionConfig(interaction, payload, streamSessions) {
  const metadata = interaction?.metadata || {};
  const customerCallControlId = metadata.original_call_control_id || interaction.call_control_id || null;
  let streamCallControlId = null;
  let config = null;

  if (streamSessions instanceof Map && streamSessions.size > 0) {
    if (customerCallControlId && streamSessions.has(customerCallControlId)) {
      streamCallControlId = customerCallControlId;
      config = streamSessions.get(customerCallControlId)?.clientState?.telnyx_stt_config || null;
    }
    if (!config) {
      for (const [candidateCallControlId, session] of streamSessions) {
        const candidate = session?.clientState?.telnyx_stt_config;
        if (!candidate?.enabled) continue;
        if (
          session?.interactionId &&
          String(session.interactionId) !== String(interaction.id)
        ) {
          continue;
        }
        streamCallControlId = candidateCallControlId;
        config = candidate;
        break;
      }
    }
  }

  if (!config && metadata.telnyx_stt_config?.enabled) {
    config = metadata.telnyx_stt_config;
    streamCallControlId = customerCallControlId || payload?.call_control_id || null;
  }
  if (!config) {
    const stateConfig = decodeClientState(payload?.client_state)?.telnyx_stt_config;
    if (stateConfig?.enabled) {
      config = stateConfig;
      streamCallControlId = customerCallControlId || payload?.call_control_id || null;
    }
  }
  return { config, streamCallControlId };
}

async function startAgentAssist(pool, interaction, payload) {
  const agentTransportCallControlId = payload?.call_control_id || null;
  const agentUsername = interaction?.agent_username || null;
  if (!agentTransportCallControlId || !agentUsername) return false;

  const { config, streamCallControlId } = transcriptionConfig(
    interaction,
    payload,
    globalThis.__telnyxSttStreamSessions,
  );
  if (!config?.enabled || !streamCallControlId) return false;

  const tracks = config.transcription_tracks || "both";
  const starts = [];
  if (["inbound", "both"].includes(tracks)) {
    starts.push(
      startTelnyxSttTranscription(
        streamCallControlId,
        { ...config, transcription_tracks: "inbound" },
        interaction.id,
        agentUsername,
        {
          mediaTrack: "inbound",
          outputTrack: "inbound",
          callSessionId: payload?.call_session_id || null,
        },
      ),
    );
  }
  if (["outbound", "both"].includes(tracks)) {
    const user = (
      await pool.query("SELECT language FROM users WHERE username = $1 LIMIT 1", [agentUsername])
    ).rows[0];
    const agentLanguage = normalizeLanguageCode(user?.language, {
      fallback: normalizeLanguageCode(config.language, { fallback: "en" }),
    });
    const outboundConfig = {
      ...config,
      transcription_tracks: "outbound",
      language: agentLanguage,
    };
    starts.push(
      startTelnyxSttMediaStream(
        agentTransportCallControlId,
        outboundConfig,
        interaction.id,
        agentUsername,
        {
          // The legacy-proven topology exposes the WebRTC microphone as the
          // inbound physical track of the transferred transport leg. Request
          // both tracks from Telnyx, but bind only inbound -> logical agent so
          // customer/hold media cannot create duplicate transcript messages.
          streamTrack: "both_tracks",
          mediaTrack: "inbound",
          outputTrack: "outbound",
          // Avoid the PCMA -> PCMU media-fork failure observed after cutover.
          // The media WebSocket start frame performs a second authoritative
          // codec check before opening the standalone STT provider socket.
          streamCodec: payload?.codec || config.stream_codec || "PCMU",
          sampleRate: payload?.sampling_rate || config.sample_rate || 8000,
          callSessionId: payload?.call_session_id || null,
        },
      ),
    );
  }
  await Promise.allSettled(starts);
  return starts.length > 0;
}

async function stopAgentAssist(pool, interaction, payload) {
  const legResult = await pool.query(
    `SELECT provider_call_id
       FROM acd_legs
      WHERE work_item_id = $1 AND provider_call_id IS NOT NULL`,
    [interaction.id],
  );
  const callControlIds = new Set([
    payload?.call_control_id,
    ...legResult.rows.map((row) => row.provider_call_id),
  ].filter(Boolean));
  await Promise.allSettled(
    [...callControlIds].map((callControlId) => stopTelnyxSttTranscription(callControlId)),
  );
}

async function handleSpeakEvent(eventType, payload) {
  const callControlId = payload?.call_control_id || null;
  if (!callControlId) return { handled: false };

  if (eventType === "call.speak.started") {
    const started = await markQueuePositionStarted(callControlId, payload?.client_state);
    return { handled: Boolean(started), queueAudio: Boolean(started) };
  }
  if (eventType !== "call.speak.ended") return { handled: false };

  if (isQueuePositionClientState(payload?.client_state)) {
    const resumed = await resumeQueueMedia(callControlId, payload.client_state);
    if (resumed?.matched && resumed.retryable) {
      const error = new Error("Queue audio playback resume is retryable");
      error.code = "QUEUE_AUDIO_RESUME_RETRYABLE";
      throw error;
    }
    if (resumed?.matched && (resumed.resumed || resumed.terminal)) {
      await resumeTranscriptionIfPaused(callControlId);
      return {
        handled: true,
        queueAudio: true,
        resumed: resumed.resumed === true,
        terminal: resumed.terminal === true,
      };
    }
  }

  const advanced = await advanceQueue(callControlId);
  if (!advanced) await resumeTranscriptionIfPaused(callControlId);
  return { handled: advanced, speakQueue: advanced };
}

/**
 * Replay adapter-only media effects after the durable Core event is applied.
 * This function never mutates call lifecycle, ownership, assignment or agent
 * capacity; those changes belong exclusively to the ACD worker and sagas.
 */
export async function handleAcdMediaEvent(eventType, payload = {}) {
  const callControlId = payload?.call_control_id || null;

  if (["call.speak.started", "call.speak.ended"].includes(eventType)) {
    return handleSpeakEvent(eventType, payload);
  }

  if (eventType === "call.transcription") {
    if (callControlId && isTranscriptionSuppressed(callControlId)) {
      return { handled: true, suppressed: true };
    }
    return routeAgentAssistTranscription(payload);
  }

  if (eventType === "call.conversation.created") {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Database unavailable for ACD conversation event");
    const interaction = await findCoreInteraction(pool, payload);
    if (!interaction) return { handled: false, reason: "work_item_not_found" };
    return linkAiConversation(pool, interaction, payload);
  }

  if (!["call.answered", "call.hangup"].includes(eventType)) {
    return { handled: false };
  }

  const pool = getPostgresPool();
  if (!pool) throw new Error("Database unavailable for ACD media event");
  const interaction = await findCoreInteraction(pool, payload);
  if (!interaction) return { handled: false, reason: "work_item_not_found" };

  if (eventType === "call.answered") {
    if (!isAcdAgentMediaEvent(interaction, payload)) {
      return { handled: true, workItemId: interaction.id, mediaSkipped: true };
    }
    const started = await startAgentAssist(pool, interaction, payload);
    return { handled: true, workItemId: interaction.id, transcriptionStarted: started };
  }

  cancelQueue(callControlId);
  cancelQueueAudioSession(callControlId);
  await stopAgentAssist(pool, interaction, payload);
  return { handled: true, workItemId: interaction.id };
}
