import { widgetAiRequest } from "../widgets/ai-provider.js";
import { broadcastToKey } from "../sse.js";
import { reconcileAssistantHistory, historyIdentity } from "./assistant-event-turns.mjs";
import { withInvitationTranscript, publishAssistantTurns } from "./assistant-event-store.mjs";
import { invitationSipTarget } from "./assistant-invite-transcription.mjs";
import { contactCenterRuntimeLogger } from "../runtime-logging.mjs";


export function assistantHistoryTurns(invite, messages) {
  return messages.flatMap(message => {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const timestamp = message.sent_at || message.created_at;
    if (message.role !== "assistant" || !text || !Number.isFinite(Date.parse(timestamp))) return [];
    // Telnyx returns newest-first history with no message IDs. Original
    // timestamps identify a turn without using its shifting page position.
    const id = historyIdentity(invite, message);
    return [{ id, transcriptionKey: id, timestamp, transcript: text, isFinal: true,
      track: "assistant", callControlId: invite.provider_call_id,
      source: "telnyx_assistant_history", provider: "telnyx", confidence: null }];
  });
}

export async function collectInvitationTranscript(invite, request = widgetAiRequest) {
  const state = invite.transcript_state || {};
  let conversationId = state.conversationId;
  if (!conversationId) {
    const target = invitationSipTarget(invite);
    const query = new URLSearchParams({ "metadata->to": `eq.${target}`, "page[size]": "2" });
    const response = await request(`/ai/conversations?${query}`);
    const matches = (response.data || []).filter(c => c.metadata?.to === target && c.metadata?.assistant_id === invite.assistant_id);
    if (matches.length !== 1) return null; // Never guess from a recent conversation.
    conversationId = matches[0].id;
  }
  const messages = [];
  for (let page = 1; ; page++) {
    const response = await request(`/ai/conversations/${encodeURIComponent(conversationId)}/messages?page[number]=${page}&page[size]=100`);
    if (!Array.isArray(response.data)) throw new Error("Invalid assistant transcript response.");
    messages.push(...response.data);
    if (page >= Number(response.meta?.total_pages || 1)) break;
    // A voice invitation is limited to one hour. Do not let malformed provider
    // pagination monopolize a worker; retry without advancing its checkpoint.
    if (page >= 100) throw new Error("Assistant transcript pagination exceeded its limit.");
  }
  const next = structuredClone({ ...state, conversationId });
  const turns = reconcileAssistantHistory(invite, next, messages);
  return { turns, state: next, messages, conversationId };
}

export async function syncAssistantInviteTranscripts(pool, { request = widgetAiRequest, broadcast = broadcastToKey } = {}) {
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (await lock.query("SELECT pg_try_advisory_lock(814027) AS locked")).rows[0].locked;
    if (!locked) return;
    const rows = (await pool.query(`SELECT i.*,u.username FROM acd_assistant_invites i JOIN users u ON u.id=i.agent_id
      WHERE i.transcript_state->>'enabled'='true' AND i.provider_call_id IS NOT NULL
        AND (i.ended_at IS NULL OR i.ended_at>now()-interval '24 hours')
        AND (i.transcript_next_poll_at IS NULL OR i.transcript_next_poll_at<=now())
      ORDER BY i.transcript_next_poll_at NULLS FIRST,i.created_at LIMIT 5`)).rows;
    await Promise.all(rows.map(async invite => {
      // Separate from invitation cleanup: a slow transcript API must never
      // delay removing AI or ending the human call.
      await pool.query("UPDATE acd_assistant_invites SET transcript_next_poll_at=now()+interval '5 seconds' WHERE id=$1", [invite.id]);
      try {
        const result = await collectInvitationTranscript(invite, request);
        if (!result) return;
        const committed = await withInvitationTranscript(pool, invite.id, async (latest, state, db) => {
          if (state.conversationId && state.conversationId !== result.conversationId) throw new Error("Conversation identity changed");
          state.conversationId = result.conversationId;
          const turns = reconcileAssistantHistory(latest, state, result.messages);
          state.lastHistoryAt = new Date().toISOString();
          state.historyPassesAfterEnd = latest.ended_at ? (state.historyPassesAfterEnd || 0) + 1 : 0;
          const settled = !Object.values(state.turns || {}).some(t => !t.isFinal && !t.deleted && t.transcript);
          // The provider publishes history late. Keep reconciling after hangup,
          // including across process restarts; an outage cannot clear the checkpoint.
          if (latest.ended_at && Date.now() - new Date(latest.ended_at).getTime() > 180000 && settled && state.historyPassesAfterEnd >= 3) state.enabled = false;
          const healthy = state.ws?.connected && Date.now() - Date.parse(state.ws.lastSeenAt) < 45000;
          await db.query("UPDATE acd_assistant_invites SET transcript_next_poll_at=now()+($2 * interval '1 second') WHERE id=$1", [invite.id, healthy ? 15 : 5]);
          return turns;
        });
        await publishAssistantTurns(committed, broadcast);
      } catch (error) {
        // Retry the unchanged durable checkpoint, including briefly after
        // hangup because the provider can publish the last turn late.
        await pool.query("UPDATE acd_assistant_invites SET transcript_next_poll_at=now()+interval '15 seconds' WHERE id=$1", [invite.id]);
        contactCenterRuntimeLogger.warn("assistant_transcript_retry", { inviteId: invite.id, workItemId: invite.work_item_id, error: error.message });
      }
    }));
  } finally { if (locked) await lock.query("SELECT pg_advisory_unlock(814027)"); lock.release(); }
}
