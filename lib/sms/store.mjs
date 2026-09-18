import { appendEvent } from "../acd/events.mjs";
import { defineSaga, startSaga } from "../acd/saga-engine.mjs";
import { appendTextMessage } from "../acd/text-lifecycle.mjs";
import { smsError, smsProvider } from "./provider.mjs";
import { validateOutboundSmsText } from "./policy.mjs";

async function markSend(db, ctx, status) {
  const failure = (await db.query(`SELECT response,http_status FROM acd_commands WHERE saga_id=$1 AND status IN ('failed','ambiguous')
    ORDER BY created_at DESC LIMIT 1`, [ctx.saga.id])).rows[0];
  await db.query(`UPDATE cc_sms_messages SET status=$2,occurred_at=now(),error_code=COALESCE($3,error_code),error_detail=COALESCE($4,error_detail),next_delivery_sync_at=NULL WHERE message_id=$1`,
    [ctx.data.messageId, status, failure?.response?.code ? String(failure.response.code) : null,
      failure?.response?.error ? String(failure.response.error).slice(0, 300) : null]);
  await appendEvent(db, { workItemId: ctx.workItem.id, type: "message_send_updated", actor: "sms", payload: { message_id: ctx.data.messageId, status } });
}

// Durable SMS send. The provider call happens outside the transaction; the
// journaled command is never replayed after an uncertain outcome because the
// messaging API has no idempotency key (see provider.mjs).
defineSaga("sms_send", {
  initialStep: "send",
  steps: {
    send: {
      async guard(db, ctx) {
        const allowed = await db.query(`SELECT 1 FROM acd_text_assignments a
          JOIN cc_sms_threads t ON t.conversation_id=$3 JOIN cc_sms_numbers n ON n.id=t.number_id AND n.sending_enabled
          WHERE a.work_item_id=$1 AND a.agent_id=$2 AND a.state='active' AND t.opted_out_at IS NULL`,
        [ctx.workItem.id, ctx.data.agentId, ctx.workItem.conversation_id]);
        return allowed.rowCount ? null : "rejected";
      },
      cmd: ctx => ({ operation: "sms_send", endpoint: "/messages", request: ctx.data.payload }),
      // dedupeWindowMs -1: never resend a command whose outcome was lost.
      dedupeWindowMs: -1, deadlineMs: 5 * 60 * 1000, onDeadline: "uncertain", onFailure: "rejected", on: { accepted: "succeeded" },
      async onAccepted(db, { saga, response }) {
        const data = response.data || {};
        await db.query(`UPDATE cc_sms_messages SET provider_message_id=$2,status='accepted',encoding=COALESCE($3,encoding),parts=COALESCE($4,parts),
          occurred_at=now(),next_delivery_sync_at=now()+interval '2 minutes' WHERE message_id=$1`,
        [saga.data.messageId, String(data.id), data.encoding || null, Number.isInteger(data.parts) ? data.parts : null]);
        await db.query(`UPDATE cc_sms_threads SET last_outbound_at=now() WHERE conversation_id=(SELECT conversation_id FROM acd_messages WHERE id=$1)`, [saga.data.messageId]);
        await appendEvent(db, { workItemId: saga.work_item_id, type: "message_send_updated", actor: "sms",
          payload: { message_id: saga.data.messageId, status: "accepted", provider_message_id: String(data.id) } });
      },
    },
    rejected: { run: async (db, ctx) => { await markSend(db, ctx, "failed"); return "failed"; } },
    uncertain: { run: async (db, ctx) => { await markSend(db, ctx, "ambiguous"); return "failed"; } },
  },
});

// `sendHandler` for actOnTextWork: runs inside the command transaction after
// ownership, version and replay checks. Returns the saga to drive after commit.
export async function sendAgentSmsInTransaction(tx, { work, agentId, commandId, body }) {
  const { text, stats } = validateOutboundSmsText(body);
  const thread = (await tx.query(`SELECT t.*,n.phone_number,n.sending_enabled FROM cc_sms_threads t JOIN cc_sms_numbers n ON n.id=t.number_id
    WHERE t.conversation_id=$1 FOR UPDATE OF t`, [work.conversation_id])).rows[0];
  if (!thread) throw smsError("This conversation has no SMS thread", 409);
  if (!thread.sending_enabled) throw smsError("Sending is paused for this number. Ask an administrator to allow agent replies.", 409);
  if (thread.opted_out_at) throw smsError("The customer opted out with STOP. Replies stay blocked until they text START.", 409);
  const message = await appendTextMessage(tx, { work, senderRole: "agent", senderId: agentId, clientId: commandId, body: text });
  const payload = { from: thread.phone_number, to: thread.customer_address, text, type: "SMS", use_profile_webhooks: true };
  const started = await startSaga(tx, { type: "sms_send", workItemId: work.id, conflictKey: `sms:${message.id}`,
    data: { messageId: message.id, agentId, payload }, actor: agentId });
  await tx.query(`INSERT INTO cc_sms_messages(message_id,number_id,direction,status,encoding,parts,saga_id) VALUES($1,$2,'outbound','queued',$3,$4,$5)`,
    [message.id, thread.number_id, stats.encoding, stats.parts, started.sagaId]);
  return { message: { ...message, delivery: { status: "queued", direction: "outbound", encoding: stats.encoding, parts: stats.parts } }, sagaId: started.sagaId, status: "queued" };
}

export const smsSendOptions = ({ provider = smsProvider() } = {}) => ({ sendHandler: sendAgentSmsInTransaction, sendProvider: provider });
