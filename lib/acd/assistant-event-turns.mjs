import { createHash } from "node:crypto";

const digest = value => createHash("sha256").update(value).digest("hex");
const normalize = value => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const textOf = item => typeof item?.content === "string" ? item.content : (item?.content || []).filter(p => ["text", "output_text", "input_text"].includes(p.type)).map(p => p.text || "").join("");
export const historyIdentity = (invite, message) => `ai-invite:${invite.id}:${digest(`${message.created_at}:${message.sent_at || message.created_at}`)}`;
const changed = (state, turn) => { turn.revision = state.revision = (state.revision || 0) + 1; };

export function eventTurn(invite, id, timestamp) {
  return { id, transcriptionKey: id, timestamp, transcript: "", isFinal: false, track: "assistant", callControlId: invite.provider_call_id,
    source: "telnyx_assistant_websocket", provider: "telnyx", confidence: null, parts: {} };
}

// Only assistant output enters this reducer. In particular, the stream's user
// turn is the conference mix and must never replace either human STT channel.
export function reduceAssistantEvents(invite, state, events, now = new Date().toISOString()) {
  state.turns ||= {};
  state.eventIds ||= [];
  const updated = new Set();
  for (const event of events) {
    if (event.event_id && state.eventIds.includes(event.event_id)) continue;
    if (event.event_id) state.eventIds = [...state.eventIds, event.event_id].slice(-4096);
    const type = event.type;
    const item = event.item;
    const itemId = event.item_id || item?.id;
    if (!itemId || typeof itemId !== "string" || itemId.length > 256) continue;
    const rawId = `ai-invite:${invite.id}:ws:${itemId}`;
    const id = state.aliases?.[rawId] || rawId;
    const prior = state.turns[id];
    if (type === "conversation.item.deleted") {
      if (prior) { prior.withdrawnText = prior.transcript; prior.deleted = true; prior.transcript = ""; prior.isFinal = true; changed(state, prior); updated.add(id); }
      else state.turns[id] = { ...eventTurn(invite, id, now), deleted: true, isFinal: true };
      continue;
    }
    if (type !== "response.text.delta" && !(["conversation.item.created", "response.output_item.added", "response.output_item.done"].includes(type) && item?.role === "assistant" && item.type === "message")) continue;
    if (prior?.deleted || prior?.historyKey) continue;
    const turn = state.turns[id] ||= eventTurn(invite, id, event.receivedAt || now);
    turn.startedOnStream ||= type === "response.output_item.added";
    if (type === "response.text.delta") {
      if (turn.isFinal || typeof event.delta !== "string") continue;
      const index = Number.isInteger(event.content_index) && event.content_index >= 0 && event.content_index < 100 ? event.content_index : 0;
      turn.parts[index] = `${turn.parts[index] || ""}${event.delta}`.slice(0, 64000);
      turn.transcript = Object.keys(turn.parts).sort((a, b) => Number(a) - Number(b)).map(key => turn.parts[key]).join("").slice(0, 64000);
    } else {
      const text = textOf(item).slice(0, 64000);
      // Observed on live Telnyx calls: incomplete, empty item.created arrives
      // AFTER the first delta. It must not erase the streaming buffer.
      if (!text) continue;
      turn.transcript = text;
      turn.isFinal = item.status === "completed";
      if (!turn.isFinal) turn.parts = { 0: text };
    }
    changed(state, turn); updated.add(id);
  }
  return [...updated].map(id => state.turns[id]);
}

function matchScore(turn, message, state) {
  const sentAt = Date.parse(message.sent_at || message.created_at);
  const observedAt = Date.parse(turn.timestamp);
  if (turn.startedOnStream && (state.gaps || []).some(gap => sentAt >= Date.parse(gap.start) && sentAt < Date.parse(gap.end) && observedAt >= Date.parse(gap.end))) return Infinity;
  const delta = Math.abs(Date.parse(turn.timestamp) - Date.parse(message.sent_at || message.created_at));
  if (delta > (turn.startedOnStream ? 5000 : 15000)) return Infinity;
  const a = normalize(turn.withdrawnText || turn.transcript), b = normalize(message.text);
  if (!a || !b) return Infinity;
  if (a === b) return delta;
  if ((a.startsWith(b) || b.startsWith(a)) && Math.min(a.length, b.length) >= 6) return delta + 500;
  // A reconnect can lose a middle span of deltas within the same reply.
  let common = 0;
  while (common < Math.min(a.length, b.length) && a[common] === b[common]) common++;
  if (common >= 8) return delta + 1000;
  return Infinity;
}

export function reconcileAssistantHistory(invite, state, messages) {
  state.turns ||= {};
  state.historyMap ||= {};
  state.delivered ||= {};
  const updates = [];
  const used = new Set(Object.values(state.historyMap));
  for (const message of [...messages].sort((a, b) => Date.parse(a.sent_at || a.created_at) - Date.parse(b.sent_at || b.created_at))) {
    const timestamp = message.sent_at || message.created_at;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (message.role !== "assistant" || !text || !Number.isFinite(Date.parse(timestamp))) continue;
    const key = historyIdentity(invite, message);
    let id = state.historyMap[key];
    if (!id) {
      const candidates = Object.values(state.turns).filter(t => !t.historyKey && !used.has(t.id))
        .map(turn => ({ turn, score: matchScore(turn, message, state) })).filter(c => Number.isFinite(c.score)).sort((a, b) => a.score - b.score);
      id = candidates[0]?.turn.id || key;
      state.historyMap[key] = id; used.add(id);
    }
    const turn = state.turns[id] ||= eventTurn(invite, id, timestamp);
    // History may win a race against a delayed live socket. Retain one identity
    // and tombstone the redundant live bubble, without using text alone as ID.
    if (id === key) {
      const duplicate = Object.values(state.turns).filter(t => t.id !== id && !t.deleted && !t.historyKey && !used.has(t.id))
        .map(t => ({ t, score: matchScore(t, message, state) })).filter(c => Number.isFinite(c.score)).sort((a, b) => a.score - b.score)[0]?.t;
      if (duplicate) {
        state.aliases ||= {}; state.aliases[duplicate.id] = id;
        duplicate.deleted = true; duplicate.transcript = ""; duplicate.isFinal = true;
        changed(state, duplicate); updates.push(duplicate); used.add(duplicate.id);
      }
    }
    // Tombstones win over delayed snapshots of a discarded response.
    if (turn.deleted) continue;
    const fingerprint = digest(text);
    if (state.delivered[key] === fingerprint && turn.isFinal) continue;
    Object.assign(turn, { transcript: text, timestamp, isFinal: true, historyKey: key, source: "telnyx_assistant_history", parts: {} });
    state.delivered[key] = fingerprint;
    changed(state, turn); updates.push(turn);
  }
  return updates;
}

export function publicAssistantTurn(turn) {
  const { parts, historyKey, withdrawnText, startedOnStream, ...result } = turn;
  return result;
}
