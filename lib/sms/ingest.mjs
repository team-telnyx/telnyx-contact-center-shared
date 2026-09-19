import { randomUUID, createHash } from "node:crypto";
import { persistWebhookEvent } from "../acd/inbox.mjs";
import { appendEvent } from "../acd/events.mjs";
import { createWorkItem, applyTransition, openSegment } from "../acd/lifecycle.mjs";
import { normalizeInboundSms, classifySmsText, reduceSmsDelivery, outboundStatusFromPayload, SMS_TERMINAL_STATUSES } from "./policy.mjs";
import { smsRequest, smsId } from "./provider.mjs";
import { applyMessagingDeliveryUpdate, markMessagingReplied } from "../outbound-dialer/messaging/execution.mjs";

export const smsEventKey = (scope, id) => `sms:${createHash("sha256").update(JSON.stringify([scope, id])).digest("hex")}`;
const DELIVERY_SYNC_ATTEMPTS = 5;

// Durable inbox handler for `telnyx-sms` rows. Inbound messages land in the
// staging archive; routing happens in `routePendingSms` under the routing lock.
export async function applySmsInboxEvent(pool, row) {
  const payload = row.payload || {};
  if (row.event_type === "message.received") {
    let inbound;
    try { inbound = normalizeInboundSms(payload); } catch { return "noop"; }
    const number = (await pool.query("SELECT id FROM cc_sms_numbers WHERE phone_number=$1", [inbound.to])).rows[0];
    if (!number) return "unmatched";
    await pool.query(`INSERT INTO cc_sms_received(number_id,provider_message_id,customer_address,payload,classification,received_at)
      VALUES($1,$2,$3,$4::jsonb,$5,COALESCE($6::timestamptz,now())) ON CONFLICT DO NOTHING`,
      [number.id, inbound.providerId, inbound.from, JSON.stringify(inbound), classifySmsText(inbound.text), inbound.receivedAt]);
    return "applied";
  }
  if (["message.sent", "message.finalized"].includes(row.event_type)) {
    if (payload.direction && payload.direction !== "outbound") return "noop";
    if (!payload.id) return "noop";
    const update = outboundStatusFromPayload(row.event_type, payload);
    return applySmsDeliveryUpdate(pool, { providerMessageId: String(payload.id), ...update,
      occurredAt: update.occurredAt || row.occurred_at || null, source: row.event_type });
  }
  return "noop";
}

// Monotonic per-message delivery state shared by webhooks and reconciliation.
export async function applySmsDeliveryUpdate(pool, { providerMessageId, status, occurredAt, errorCode = null, errorDetail = null, source = "webhook" }) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const message = (await db.query(`SELECT s.*,m.work_item_id FROM cc_sms_messages s JOIN acd_messages m ON m.id=s.message_id
      WHERE s.provider_message_id=$1 AND s.direction='outbound' FOR UPDATE OF s`, [providerMessageId])).rows[0];
    if (!message) {
      await db.query("COMMIT");
      // Campaign messages live on the outbound attempt ledger, not in the agent thread tables.
      return applyMessagingDeliveryUpdate(pool, { channel: "sms", providerMessageId, status, occurredAt, errorCode, errorDetail, source });
    }
    const next = reduceSmsDelivery(message, { status, occurredAt: occurredAt || new Date().toISOString() });
    if (!next) { await db.query("COMMIT"); return "noop"; }
    await db.query(`UPDATE cc_sms_messages SET status=$2,occurred_at=$3,error_code=COALESCE($4,error_code),error_detail=COALESCE($5,error_detail),
      next_delivery_sync_at=CASE WHEN $2=ANY($6::text[]) THEN NULL ELSE next_delivery_sync_at END WHERE message_id=$1`,
      [message.message_id, next.status, next.occurredAt, errorCode, errorDetail, SMS_TERMINAL_STATUSES]);
    await appendEvent(db, { workItemId: message.work_item_id, type: "message_delivery_updated", actor: "sms-provider",
      payload: { message_id: message.message_id, status: next.status, provider_event: source } });
    await db.query("COMMIT");
    return "applied";
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

async function customerDisplayName(db, address) {
  try {
    const contact = (await db.query(`SELECT display_name,first_name,last_name FROM contacts WHERE phone=$1 OR mobile=$1 LIMIT 1`, [address])).rows[0];
    const name = contact && (contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(" "));
    if (name?.trim()) return name.trim().slice(0, 120);
  } catch { /* contacts are optional for SMS identity */ }
  return address;
}

// One pending inbound message per call, under the routing lock. Thread identity
// is (business number, customer number); an episode is one ACD work item.
export async function routePendingSms(pool) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(741901,5)");
    const pending = (await db.query(`SELECT r.*,n.queue_id,n.phone_number,n.name AS number_name FROM cc_sms_received r
      JOIN cc_sms_numbers n ON n.id=r.number_id AND n.routing_enabled
      JOIN cc_queues q ON q.id=n.queue_id AND q.enabled
      JOIN cc_queue_channels qc ON qc.queue_id=q.id AND qc.channel='sms' AND qc.enabled
      WHERE r.processed_at IS NULL AND r.route_after<=now() ORDER BY r.received_at
      FOR UPDATE OF r SKIP LOCKED LIMIT 1`)).rows[0];
    if (!pending) { await db.query("COMMIT"); return false; }
    const inbound = pending.payload;
    let thread = (await db.query("SELECT * FROM cc_sms_threads WHERE number_id=$1 AND customer_address=$2 FOR UPDATE",
      [pending.number_id, pending.customer_address])).rows[0];
    if (!thread) {
      const conversationId = randomUUID();
      await db.query(`INSERT INTO acd_conversations(id,channel,customer_name,attributes) VALUES($1,'sms',$2,$3::jsonb)`,
        [conversationId, await customerDisplayName(db, pending.customer_address),
          JSON.stringify({ customer_number: pending.customer_address, business_number: pending.phone_number, number_name: pending.number_name })]);
      thread = (await db.query(`INSERT INTO cc_sms_threads(conversation_id,number_id,customer_address) VALUES($1,$2,$3) RETURNING *`,
        [conversationId, pending.number_id, pending.customer_address])).rows[0];
    }
    if (pending.classification === "customer") {
      // Campaign attribution never blocks routing: an error rolls back to the savepoint only.
      await db.query("SAVEPOINT messaging_reply");
      try { await markMessagingReplied(db, { channel: "sms", address: pending.customer_address, receivedBy: pending.phone_number }); await db.query("RELEASE SAVEPOINT messaging_reply"); }
      catch { await db.query("ROLLBACK TO SAVEPOINT messaging_reply"); }
    }
    if (pending.classification === "opt_out") await db.query("UPDATE cc_sms_threads SET opted_out_at=now() WHERE conversation_id=$1", [thread.conversation_id]);
    if (pending.classification === "opt_in") await db.query("UPDATE cc_sms_threads SET opted_out_at=NULL WHERE conversation_id=$1", [thread.conversation_id]);
    let work = (await db.query("SELECT * FROM acd_work_items WHERE conversation_id=$1 AND terminal_at IS NULL FOR UPDATE", [thread.conversation_id])).rows[0];
    // Only final wrap-up ends the episode. A transferred agent may still be
    // dispositioning while the destination receives new customer messages.
    if (work && (await db.query(`SELECT 1 FROM acd_text_assignments a JOIN acd_segments s ON s.id=a.segment_id
      WHERE a.work_item_id=$1 AND a.state='wrapup' AND s.outcome IS DISTINCT FROM 'transferred'`, [work.id])).rowCount) {
      await db.query("UPDATE cc_sms_received SET route_after=now()+interval '2 seconds' WHERE number_id=$1 AND provider_message_id=$2",
        [pending.number_id, pending.provider_message_id]);
      await db.query("COMMIT"); return true;
    }
    // Carrier keywords without a live episode are provider-handled auto-replies;
    // archive them instead of opening work for an agent.
    if (!work && pending.classification !== "customer") {
      await db.query("UPDATE cc_sms_received SET processed_at=now() WHERE number_id=$1 AND provider_message_id=$2", [pending.number_id, pending.provider_message_id]);
      await db.query("COMMIT"); return true;
    }
    if (!work) {
      const queue = (await db.query("SELECT * FROM cc_queues WHERE id=$1", [pending.queue_id])).rows[0];
      work = await createWorkItem(db, { channel: "sms", direction: "inbound", queueId: pending.queue_id, conversationId: thread.conversation_id,
        customerAddress: pending.customer_address, requiredSkills: queue.skill_requirements || {},
        attributes: { customer_number: pending.customer_address, business_number: pending.phone_number, number_name: pending.number_name }, actor: "sms" });
      await applyTransition(db, { workItemId: work.id, to: "queued", eventType: "work_item_queued", patch: { enqueuedAt: new Date().toISOString() }, actor: "sms" });
      await openSegment(db, { workItemId: work.id, kind: "queue_wait", queueId: pending.queue_id });
    }
    const messageId = randomUUID();
    const body = inbound.text?.trim() || (inbound.media?.length ? `[${inbound.type} media: ${inbound.media.length} file${inbound.media.length === 1 ? "" : "s"}]` : "");
    await db.query(`INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body,created_at)
      VALUES($1,$2,$3,'customer',$4,$5,$6,COALESCE($7::timestamptz,now()))`,
      [messageId, thread.conversation_id, work.id, pending.customer_address, inbound.providerId, body, inbound.receivedAt]);
    await db.query(`INSERT INTO cc_sms_messages(message_id,number_id,direction,provider_message_id,status,encoding,parts,media,occurred_at)
      VALUES($1,$2,'inbound',$3,'received',$4,$5,$6::jsonb,COALESCE($7::timestamptz,now()))`,
      [messageId, pending.number_id, inbound.providerId, inbound.encoding, inbound.parts, JSON.stringify(inbound.media || []), inbound.receivedAt]);
    await db.query("UPDATE cc_sms_threads SET state='open',last_inbound_at=now() WHERE conversation_id=$1", [thread.conversation_id]);
    await db.query("UPDATE cc_sms_received SET message_id=$3,processed_at=now() WHERE number_id=$1 AND provider_message_id=$2", [pending.number_id, pending.provider_message_id, messageId]);
    await appendEvent(db, { workItemId: work.id, type: "text_message_created", actor: "sms",
      payload: { message_id: messageId, conversation_id: thread.conversation_id, sender_role: "customer", classification: pending.classification } });
    await db.query("COMMIT"); return true;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

// Recover missed delivery webhooks from the message resource (available for 10
// days). Bounded attempts keep an unconfirmed message from polling forever.
export async function syncSmsDeliveries(pool, { request = smsRequest } = {}) {
  const db = await pool.connect();
  let message;
  try {
    await db.query("BEGIN");
    message = (await db.query(`SELECT s.* FROM cc_sms_messages s WHERE s.direction='outbound' AND s.provider_message_id IS NOT NULL
      AND s.next_delivery_sync_at IS NOT NULL AND s.next_delivery_sync_at<=now() ORDER BY s.next_delivery_sync_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (!message) { await db.query("COMMIT"); return false; }
    const exhausted = message.delivery_sync_attempts + 1 >= DELIVERY_SYNC_ATTEMPTS;
    await db.query(`UPDATE cc_sms_messages SET delivery_sync_attempts=delivery_sync_attempts+1,
      next_delivery_sync_at=CASE WHEN $2 THEN NULL ELSE now()+interval '2 minutes' END WHERE message_id=$1`, [message.message_id, exhausted]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
  const result = await request(`/messages/${smsId(message.provider_message_id)}`);
  const data = result?.data;
  if (!data?.id) return true;
  const recipient = Array.isArray(data.to) ? data.to[0] : null;
  if (!recipient?.status || recipient.status === "queued") return true;
  const error = Array.isArray(data.errors) && data.errors[0] ? data.errors[0] : null;
  await applySmsDeliveryUpdate(pool, { providerMessageId: String(data.id), status: recipient.status,
    occurredAt: data.completed_at || data.sent_at || null, errorCode: error?.code ? String(error.code) : null,
    errorDetail: error?.detail || error?.title || null, source: "message-sync" });
  return true;
}

export { persistWebhookEvent };
