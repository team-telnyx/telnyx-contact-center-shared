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

  return { routed: true, interactionId: interaction.id, transcriptionKey };
}
