import { randomUUID } from "crypto";

// Shared turn-boundary-aware transcription bubble keying for Agent Assist.
//
// Bubbles are grouped per (callControlId, track). A bubble is "open" until a
// message-final transcription arrives, at which point its key is rotated so the
// next utterance on that track starts a fresh bubble.
//
// THE TURN-BOUNDARY GUARD: speech recognition (Telnyx Standalone STT / Deepgram)
// does not always emit `speech_final: true` for an utterance. When that final
// signal is lost, the opposite leg can speak (and finalize) while this leg's
// bubble is still open. Without a guard, the NEXT utterance on this leg would be
// appended to the stale open bubble — rendering a customer line above an agent
// line that actually came first, and corrupting per-turn slot analysis.
//
// To prevent this, whenever a message becomes final on one track we proactively
// close any still-open bubble on the OTHER track(s) of the same call, so a real
// conversational turn boundary always rotates the bubble key.

const globalAny = globalThis;
if (!globalAny.__agentAssistActiveTranscriptionMessages) {
  globalAny.__agentAssistActiveTranscriptionMessages = new Map();
}
const activeTranscriptionMessages = globalAny.__agentAssistActiveTranscriptionMessages;

export function getTranscriptionLiveKey(callControlId, track) {
  return `${callControlId}:${track || "unknown"}`;
}

// Normalize a track to its conversational leg ("inbound" = customer,
// everything else = agent/outbound). Used to detect a turn boundary between the
// two legs even when STT labels the agent leg with a non-"outbound" track name.
export function normalizeTranscriptionLeg(track) {
  return String(track || "").toLowerCase() === "inbound" ? "inbound" : "outbound";
}

// Close (rotate) any open bubble that belongs to a DIFFERENT conversational leg
// than `track` for the same call. Returns the live keys that were closed.
export function closeOpposingOpenBubbles(callControlId, track) {
  if (!callControlId) return [];
  const leg = normalizeTranscriptionLeg(track);
  const prefix = `${callControlId}:`;
  const closed = [];
  for (const liveKey of activeTranscriptionMessages.keys()) {
    if (!liveKey.startsWith(prefix)) continue;
    const otherTrack = liveKey.slice(prefix.length);
    if (normalizeTranscriptionLeg(otherTrack) !== leg) {
      activeTranscriptionMessages.delete(liveKey);
      closed.push(liveKey);
    }
  }
  return closed;
}

export function getTranscriptionMessageKey(callControlId, track, isMessageFinal) {
  const liveKey = getTranscriptionLiveKey(callControlId, track);
  let messageKey = activeTranscriptionMessages.get(liveKey);
  if (!messageKey) {
    messageKey = `${liveKey}:${randomUUID()}`;
    activeTranscriptionMessages.set(liveKey, messageKey);
  }
  if (isMessageFinal) {
    activeTranscriptionMessages.delete(liveKey);
    // A finalized utterance is a turn boundary: close the other leg's open
    // bubble so its next utterance does not get appended to a stale one.
    closeOpposingOpenBubbles(callControlId, track);
  }
  return messageKey;
}

// Test/maintenance helper.
export function resetTranscriptionMessageKeys() {
  activeTranscriptionMessages.clear();
}
