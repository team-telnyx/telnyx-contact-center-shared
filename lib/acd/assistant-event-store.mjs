import { widgetAiRequest } from "../widgets/ai-provider.js";
import { broadcastToKey } from "../sse.js";
import { persistAgentAssistTranscriptionsInTransaction } from "../agent-assist/transcription-persistence.mjs";
import { publicAssistantTurn, reduceAssistantEvents } from "./assistant-event-turns.mjs";

// Keep the same work-item -> invitation lock ordering as call control.
export async function withInvitationTranscript(pool, inviteId, change) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT id FROM acd_work_items WHERE id=(SELECT work_item_id FROM acd_assistant_invites WHERE id=$1) FOR UPDATE", [inviteId]);
    const invite = (await db.query(`SELECT i.*,u.username FROM acd_assistant_invites i JOIN users u ON u.id=i.agent_id WHERE i.id=$1 FOR UPDATE OF i`, [inviteId])).rows[0];
    if (!invite) { await db.query("COMMIT"); return null; }
    const state = invite.transcript_state || {};
    const turns = await change(invite, state, db);
    if (turns === null) { await db.query("COMMIT"); return null; }
    const visible = (turns || []).filter(t => t.transcript || t.deleted).map(publicAssistantTurn);
    if (visible.length) await persistAgentAssistTranscriptionsInTransaction(db, { workItemId: invite.work_item_id, transcriptions: visible });
    await db.query("UPDATE acd_assistant_invites SET transcript_state=$2::jsonb WHERE id=$1", [inviteId, JSON.stringify(state)]);
    await db.query("COMMIT");
    return { invite, turns: visible };
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

export async function publishAssistantTurns(result, broadcast = broadcastToKey) {
  if (!result) return;
  for (const turn of result.turns) await broadcast(`contact-center:agent:${result.invite.username}`, {
    type: "transcription", interactionId: result.invite.work_item_id, callControlId: result.invite.provider_call_id,
    transcriptionKey: turn.id, transcription: {
      transcription_key: turn.id, transcript: turn.transcript, timestamp: turn.timestamp,
      track: "assistant", is_final: turn.isFinal, speech_final: turn.isFinal,
      deleted: turn.deleted === true, revision: turn.revision,
      source: turn.source, provider: turn.provider,
    },
  });
}

export async function bindAssistantConversation(pool, session, connectionId, request = widgetAiRequest) {
  const connectedAt = new Date().toISOString();
  if (!session?.conversation_id || !session?.assistant_id) throw new Error("Missing conversation identity");
  const response = await request(`/ai/conversations/${encodeURIComponent(session.conversation_id)}`);
  const conversation = response.data || response;
  const target = conversation.metadata?.to;
  const id = typeof target === "string" ? target.split("@")[0] : "";
  if (!/^[a-f0-9-]{36}$/i.test(id) || conversation.metadata?.assistant_id !== session.assistant_id || target !== `${id}@${session.assistant_id}.sip.telnyx.com`) throw new Error("Unrecognized assistant conversation");
  const result = await withInvitationTranscript(pool, id, async (invite, state, db) => {
    if (!state.enabled || invite.assistant_id !== session.assistant_id || (state.conversationId && state.conversationId !== session.conversation_id) || (invite.ended_at && Date.now() - new Date(invite.ended_at).getTime() > 300000)) throw new Error("Conversation does not belong to this invitation");
    if (Date.parse(state.ws?.connectedAt) > Date.parse(connectedAt)) throw new Error("A newer socket already owns this conversation");
    if (state.ws?.connectionId) state.gaps = [...(state.gaps || []), { start: state.ws.disconnectedAt || state.ws.lastSeenAt, end: connectedAt }].slice(-100);
    state.conversationId = session.conversation_id;
    state.ws = { connectionId, connected: true, connectedAt, lastSeenAt: new Date().toISOString(), connections: (state.ws?.connections || 0) + 1 };
    await db.query("UPDATE acd_assistant_invites SET transcript_next_poll_at=now() WHERE id=$1", [id]);
    return [];
  });
  if (!result) throw new Error("Unknown invitation");
  return id;
}

export async function acceptAssistantEvents(pool, inviteId, connectionId, events, broadcast = broadcastToKey) {
  const result = await withInvitationTranscript(pool, inviteId, async (invite, state, db) => {
    if (!state.enabled || state.ws?.connectionId !== connectionId) return null;
    state.ws.lastSeenAt = new Date().toISOString();
    if (events.some(e => e.type === "session.ended" || e.type === "telnyx.call.hangup")) {
      state.ws.connected = false;
      await db.query("UPDATE acd_assistant_invites SET transcript_next_poll_at=now() WHERE id=$1", [inviteId]);
    }
    return reduceAssistantEvents(invite, state, events);
  });
  await publishAssistantTurns(result, broadcast);
}

export async function disconnectAssistantEvents(pool, inviteId, connectionId) {
  await withInvitationTranscript(pool, inviteId, async (_invite, state, db) => {
    if (state.ws?.connectionId !== connectionId) return null;
    state.ws.connected = false;
    state.ws.disconnectedAt = new Date().toISOString();
    await db.query("UPDATE acd_assistant_invites SET transcript_next_poll_at=now() WHERE id=$1", [inviteId]);
    return [];
  });
}
