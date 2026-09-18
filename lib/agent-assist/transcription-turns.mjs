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

// THE SINGLE SOURCE OF TRUTH FOR UTTERANCE FINALITY.
//
// The same STT event reaches the transcript through two independent paths: the
// standalone-STT websocket router and the `call.transcription` webhook. Both
// rotate bubble keys through the shared `activeTranscriptionMessages` map, so
// if they disagree about whether an event is final, one path deletes the shared
// key while the other is still treating the bubble as open — the next event
// then mints a fresh UUID and the same utterance is rendered twice.
//
// Only the deleting path runs the per-leg `recentTranscriptionCache` check
// (it is gated on finality), so the duplicate produced by a disagreement slips
// past dedup entirely. Both callers MUST derive finality from here rather than
// re-deriving it locally, or the two paths will drift apart again.
//
// `speech_final` is the utterance boundary when the provider sends it;
// `is_final` is only the fallback for providers that omit it.
export function isUtteranceFinal(transcriptionData) {
  if (!transcriptionData) return false;
  const hasSpeechFinal = typeof transcriptionData.speech_final === "boolean";
  return hasSpeechFinal
    ? transcriptionData.speech_final === true
    : transcriptionData.is_final === true;
}

// THE SINGLE SOURCE OF TRUTH FOR CROSS-SOURCE DEDUP TEXT (an earlier fix, same
// pattern as isUtteranceFinal above). The router and the webhook suppress each
// other's copy of an utterance through shared `itr-*` cache keys that embed
// the utterance text — so both sides MUST build that text identically. They
// did not: the router seeded keys with RAW text ("Sara Thompson.") while the
// webhook looked up NORMALIZED text ("sara thompson"), so the cross-source
// check could never match real speech and every bypass miss rendered the
// utterance twice. Any future keying change must go through here.
export function normalizeTranscriptForDedup(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+$/, "")
    .trim();
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
