import { randomUUID, createHash } from "node:crypto";
import { persistWebhookEvent } from "../acd/inbox.mjs";
import { appendEvent } from "../acd/events.mjs";
import { createWorkItem, applyTransition, openSegment } from "../acd/lifecycle.mjs";
import { normalizeInboundWhatsApp, describeWhatsAppContent, reduceWhatsAppDelivery, outboundStatusFromWhatsAppPayload, WHATSAPP_SYNC_DONE_STATUSES } from "./policy.mjs";
import { whatsappRequest, whatsappId, resolveWhatsAppCredentials } from "./provider.mjs";
import { downloadWhatsAppMedia, whatsappMediaFilename, MAX_INBOUND_MEDIA_BYTES } from "./media.mjs";
import { applyMessagingDeliveryUpdate, markMessagingReplied } from "../outbound-dialer/messaging/execution.mjs";

export const whatsappEventKey = (scope, id) => `whatsapp:${createHash("sha256").update(JSON.stringify([scope, id])).digest("hex")}`;
const DELIVERY_SYNC_ATTEMPTS = 5;
const MEDIA_ATTEMPTS = 3;
export const WHATSAPP_STATUS_EVENTS = Object.freeze(["message.sent", "message.delivered", "message.read", "message.failed", "message.undeliverable", "message.finalized"]);

// Durable inbox handler for `telnyx-whatsapp` rows. Inbound messages land in
// the staging archive; media is downloaded by `stageWhatsAppMedia` and routing
// happens in `routePendingWhatsApp` under the routing lock.
export async function applyWhatsAppInboxEvent(pool, row) {
  const payload = row.payload || {};
  if (row.event_type === "message.received") {
    let inbound;
    try { inbound = normalizeInboundWhatsApp(payload); } catch { return "noop"; }
    const number = (await pool.query("SELECT id FROM cc_whatsapp_numbers WHERE phone_number=$1", [inbound.to])).rows[0];
    if (!number) return "unmatched";
    await pool.query(`INSERT INTO cc_whatsapp_received(number_id,provider_message_id,customer_address,payload,classification,received_at,media_state)
      VALUES($1,$2,$3,$4::jsonb,'customer',COALESCE($5::timestamptz,now()),$6) ON CONFLICT DO NOTHING`,
      [number.id, inbound.providerId, inbound.from, JSON.stringify(inbound), inbound.receivedAt, inbound.media ? "pending" : "none"]);
    return "applied";
  }
  if (WHATSAPP_STATUS_EVENTS.includes(row.event_type)) {
    if (payload.direction && payload.direction !== "outbound") return "noop";
    if (!payload.id) return "noop";
    const update = outboundStatusFromWhatsAppPayload(row.event_type, payload);
    return applyWhatsAppDeliveryUpdate(pool, { providerMessageId: String(payload.id), ...update,
      occurredAt: update.occurredAt || row.occurred_at || null, source: row.event_type });
  }
  return "noop";
}

// Monotonic per-message delivery state shared by webhooks and reconciliation.
export async function applyWhatsAppDeliveryUpdate(pool, { providerMessageId, status, occurredAt, errorCode = null, errorDetail = null, source = "webhook" }) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const message = (await db.query(`SELECT s.*,m.work_item_id FROM cc_whatsapp_messages s JOIN acd_messages m ON m.id=s.message_id
      WHERE s.provider_message_id=$1 AND s.direction='outbound' FOR UPDATE OF s`, [providerMessageId])).rows[0];
    if (!message) {
      await db.query("COMMIT");
      // Campaign messages live on the outbound attempt ledger, not in the agent thread tables.
      return applyMessagingDeliveryUpdate(pool, { channel: "whatsapp", providerMessageId, status, occurredAt, errorCode, errorDetail, source });
    }
    const next = reduceWhatsAppDelivery(message, { status, occurredAt: occurredAt || new Date().toISOString() });
    if (!next) { await db.query("COMMIT"); return "noop"; }
    await db.query(`UPDATE cc_whatsapp_messages SET status=$2,occurred_at=$3,error_code=COALESCE($4,error_code),error_detail=COALESCE($5,error_detail),
      next_delivery_sync_at=CASE WHEN $2=ANY($6::text[]) THEN NULL ELSE next_delivery_sync_at END WHERE message_id=$1`,
      [message.message_id, next.status, next.occurredAt, errorCode, errorDetail, WHATSAPP_SYNC_DONE_STATUSES]);
    await appendEvent(db, { workItemId: message.work_item_id, type: "message_delivery_updated", actor: "whatsapp-provider",
      payload: { message_id: message.message_id, status: next.status, provider_event: source } });
    await db.query("COMMIT");
    return "applied";
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

// Download one pending inbound media file outside the routing lock. The bytes
// wait in `cc_whatsapp_media` until routing copies them onto the message.
export async function stageWhatsAppMedia(pool, { download = downloadWhatsAppMedia, credentials = null } = {}) {
  const db = await pool.connect();
  let claimed;
  try {
    await db.query("BEGIN");
    claimed = (await db.query(`SELECT r.number_id,r.provider_message_id,r.payload,r.media_attempts FROM cc_whatsapp_received r
      WHERE r.processed_at IS NULL AND r.media_state='pending' AND r.route_after<=now() ORDER BY r.received_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (!claimed) { await db.query("COMMIT"); return false; }
    await db.query(`UPDATE cc_whatsapp_received SET media_attempts=media_attempts+1,route_after=now()+interval '45 seconds' WHERE number_id=$1 AND provider_message_id=$2`,
      [claimed.number_id, claimed.provider_message_id]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
  const key = [claimed.number_id, claimed.provider_message_id];
  const media = claimed.payload?.media;
  try {
    if (!media?.url) throw new Error("Inbound message has no media URL");
    const resolved = credentials || await resolveWhatsAppCredentials();
    const file = await download(media.url, { apiKey: resolved.apiKey, maxBytes: MAX_INBOUND_MEDIA_BYTES });
    const contentType = file.contentType || media.contentType || "application/octet-stream";
    const name = whatsappMediaFilename({ kind: media.kind, filename: media.filename, contentType, providerMessageId: claimed.provider_message_id });
    await pool.query(`INSERT INTO cc_whatsapp_media(number_id,provider_message_id,kind,name,content_type,bytes,byte_size,content_hash,caption,source_url)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(number_id,provider_message_id) DO UPDATE SET kind=EXCLUDED.kind,name=EXCLUDED.name,content_type=EXCLUDED.content_type,
        bytes=EXCLUDED.bytes,byte_size=EXCLUDED.byte_size,content_hash=EXCLUDED.content_hash,caption=EXCLUDED.caption,source_url=EXCLUDED.source_url,downloaded_at=now()`,
      [...key, media.kind, name, contentType, file.bytes, file.bytes.length, file.contentHash, media.caption || null, media.url]);
    await pool.query("UPDATE cc_whatsapp_received SET media_state='ready',media_error=NULL,route_after=now() WHERE number_id=$1 AND provider_message_id=$2", key);
  } catch (error) {
    const exhausted = claimed.media_attempts + 1 >= MEDIA_ATTEMPTS;
    await pool.query(`UPDATE cc_whatsapp_received SET media_state=CASE WHEN $3 THEN 'failed' ELSE 'pending' END,media_error=$4,
      route_after=CASE WHEN $3 THEN now() ELSE now()+interval '45 seconds' END WHERE number_id=$1 AND provider_message_id=$2`,
      [...key, exhausted, String(error?.message || error).slice(0, 300)]);
  }
  return true;
}

async function customerDisplayName(db, address, profileName) {
  if (profileName) return profileName;
  try {
    const contact = (await db.query(`SELECT display_name,first_name,last_name FROM contacts WHERE phone=$1 OR mobile=$1 LIMIT 1`, [address])).rows[0];
    const name = contact && (contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(" "));
    if (name?.trim()) return name.trim().slice(0, 120);
  } catch { /* contacts are optional for WhatsApp identity */ }
  return address;
}

// One pending inbound message per call, under the routing lock. Thread identity
// is (business number, customer number); an episode is one ACD work item.
export async function routePendingWhatsApp(pool) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(741901,5)");
    const pending = (await db.query(`SELECT r.*,n.queue_id,n.phone_number,n.name AS number_name FROM cc_whatsapp_received r
      JOIN cc_whatsapp_numbers n ON n.id=r.number_id AND n.routing_enabled
      JOIN cc_queues q ON q.id=n.queue_id AND q.enabled
      JOIN cc_queue_channels qc ON qc.queue_id=q.id AND qc.channel='whatsapp' AND qc.enabled
      WHERE r.processed_at IS NULL AND r.route_after<=now() AND r.media_state<>'pending' ORDER BY r.received_at
      FOR UPDATE OF r SKIP LOCKED LIMIT 1`)).rows[0];
    if (!pending) { await db.query("COMMIT"); return false; }
    const inbound = pending.payload;
    const key = [pending.number_id, pending.provider_message_id];
    let thread = (await db.query("SELECT * FROM cc_whatsapp_threads WHERE number_id=$1 AND customer_address=$2 FOR UPDATE", [pending.number_id, pending.customer_address])).rows[0];
    if (!thread) {
      const conversationId = randomUUID();
      const customerName = await customerDisplayName(db, pending.customer_address, inbound.profileName);
      await db.query(`INSERT INTO acd_conversations(id,channel,customer_name,attributes) VALUES($1,'whatsapp',$2,$3::jsonb)`,
        [conversationId, customerName, JSON.stringify({ customer_number: pending.customer_address, business_number: pending.phone_number, number_name: pending.number_name })]);
      thread = (await db.query(`INSERT INTO cc_whatsapp_threads(conversation_id,number_id,customer_address,customer_name) VALUES($1,$2,$3,$4) RETURNING *`,
        [conversationId, pending.number_id, pending.customer_address, inbound.profileName || null])).rows[0];
    } else if (inbound.profileName && inbound.profileName !== thread.customer_name) {
      await db.query("UPDATE cc_whatsapp_threads SET customer_name=$2 WHERE conversation_id=$1", [thread.conversation_id, inbound.profileName]);
      await db.query("UPDATE acd_conversations SET customer_name=$2 WHERE id=$1 AND customer_name IN ($3,COALESCE($4,$3))", [thread.conversation_id, inbound.profileName, pending.customer_address, thread.customer_name]);
    }
    // Campaign attribution never blocks routing: an error rolls back to the savepoint only.
    await db.query("SAVEPOINT messaging_reply");
    try { await markMessagingReplied(db, { channel: "whatsapp", address: pending.customer_address, receivedBy: pending.phone_number }); await db.query("RELEASE SAVEPOINT messaging_reply"); }
    catch { await db.query("ROLLBACK TO SAVEPOINT messaging_reply"); }
    let work = (await db.query("SELECT * FROM acd_work_items WHERE conversation_id=$1 AND terminal_at IS NULL FOR UPDATE", [thread.conversation_id])).rows[0];
    // Only final wrap-up ends the episode. A transferred agent may still be
    // dispositioning while the destination receives new customer messages.
    if (work && (await db.query(`SELECT 1 FROM acd_text_assignments a JOIN acd_segments s ON s.id=a.segment_id
      WHERE a.work_item_id=$1 AND a.state='wrapup' AND s.outcome IS DISTINCT FROM 'transferred'`, [work.id])).rowCount) {
      await db.query("UPDATE cc_whatsapp_received SET route_after=now()+interval '2 seconds' WHERE number_id=$1 AND provider_message_id=$2", key);
      await db.query("COMMIT"); return true;
    }
    // A reaction without a live episode is not a request for help; archive it
    // instead of opening work for an agent.
    if (!work && inbound.kind === "reaction") {
      await db.query("UPDATE cc_whatsapp_received SET processed_at=now() WHERE number_id=$1 AND provider_message_id=$2", key);
      await db.query("COMMIT"); return true;
    }
    if (!work) {
      const queue = (await db.query("SELECT * FROM cc_queues WHERE id=$1", [pending.queue_id])).rows[0];
      work = await createWorkItem(db, { channel: "whatsapp", direction: "inbound", queueId: pending.queue_id, conversationId: thread.conversation_id,
        customerAddress: pending.customer_address, requiredSkills: queue.skill_requirements || {},
        attributes: { customer_number: pending.customer_address, business_number: pending.phone_number, number_name: pending.number_name }, actor: "whatsapp" });
      await applyTransition(db, { workItemId: work.id, to: "queued", eventType: "work_item_queued", patch: { enqueuedAt: new Date().toISOString() }, actor: "whatsapp" });
      await openSegment(db, { workItemId: work.id, kind: "queue_wait", queueId: pending.queue_id });
    }
    const messageId = randomUUID();
    const staged = pending.media_state === "ready" ? (await db.query("SELECT kind,name,content_type,byte_size,caption FROM cc_whatsapp_media WHERE number_id=$1 AND provider_message_id=$2", key)).rows[0] : null;
    let body = describeWhatsAppContent(inbound);
    if (staged && !inbound.text) body = staged.caption || staged.name;
    if (pending.media_state === "failed") body = `${body} (media could not be downloaded)`;
    await db.query(`INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body,created_at)
      VALUES($1,$2,$3,'customer',$4,$5,$6,COALESCE($7::timestamptz,now()))`,
      [messageId, thread.conversation_id, work.id, pending.customer_address, inbound.providerId, body, inbound.receivedAt]);
    const content = { media: inbound.media ? { kind: inbound.media.kind, content_type: inbound.media.contentType, filename: inbound.media.filename, caption: inbound.media.caption,
      state: pending.media_state, error: pending.media_error || null } : null, location: inbound.location, contacts: inbound.contacts, interactive_reply: inbound.interactiveReply,
      reaction: inbound.reaction, context: inbound.context };
    await db.query(`INSERT INTO cc_whatsapp_messages(message_id,number_id,direction,provider_message_id,wamid,status,kind,content,occurred_at)
      VALUES($1,$2,'inbound',$3,$4,'received',$5,$6::jsonb,COALESCE($7::timestamptz,now()))`,
      [messageId, pending.number_id, inbound.providerId, inbound.wamid, inbound.kind, JSON.stringify(content), inbound.receivedAt]);
    if (staged) {
      await db.query(`INSERT INTO acd_text_attachments(id,message_id,conversation_id,name,content_type,bytes,byte_size,content_hash)
        SELECT $1,$2,$3,name,content_type,bytes,byte_size,content_hash FROM cc_whatsapp_media WHERE number_id=$4 AND provider_message_id=$5`,
        [randomUUID(), messageId, thread.conversation_id, ...key]);
      await db.query("DELETE FROM cc_whatsapp_media WHERE number_id=$1 AND provider_message_id=$2", key);
    }
    await db.query(`UPDATE cc_whatsapp_threads SET state='open',last_inbound_at=GREATEST(COALESCE(last_inbound_at,'epoch'::timestamptz),COALESCE($2::timestamptz,now())) WHERE conversation_id=$1`,
      [thread.conversation_id, inbound.receivedAt]);
    await db.query("UPDATE cc_whatsapp_received SET message_id=$3,processed_at=now() WHERE number_id=$1 AND provider_message_id=$2", [...key, messageId]);
    await appendEvent(db, { workItemId: work.id, type: "text_message_created", actor: "whatsapp",
      payload: { message_id: messageId, conversation_id: thread.conversation_id, sender_role: "customer", kind: inbound.kind } });
    await db.query("COMMIT"); return true;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

// Recover missed delivery webhooks from the message resource. Bounded attempts
// keep an unconfirmed message from polling forever.
export async function syncWhatsAppDeliveries(pool, { request = whatsappRequest } = {}) {
  const db = await pool.connect();
  let message;
  try {
    await db.query("BEGIN");
    message = (await db.query(`SELECT s.* FROM cc_whatsapp_messages s WHERE s.direction='outbound' AND s.provider_message_id IS NOT NULL
      AND s.next_delivery_sync_at IS NOT NULL AND s.next_delivery_sync_at<=now() ORDER BY s.next_delivery_sync_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (!message) { await db.query("COMMIT"); return false; }
    const exhausted = message.delivery_sync_attempts + 1 >= DELIVERY_SYNC_ATTEMPTS;
    await db.query(`UPDATE cc_whatsapp_messages SET delivery_sync_attempts=delivery_sync_attempts+1,
      next_delivery_sync_at=CASE WHEN $2 THEN NULL ELSE now()+interval '2 minutes' END WHERE message_id=$1`, [message.message_id, exhausted]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
  const result = await request(`/messages/${whatsappId(message.provider_message_id)}`);
  const data = result?.data;
  if (!data?.id) return true;
  const recipient = Array.isArray(data.to) ? data.to[0] : null;
  const status = recipient?.status || data.delivery_status || null;
  if (!status || status === "queued") return true;
  const error = Array.isArray(data.errors) && data.errors[0] ? data.errors[0] : null;
  await applyWhatsAppDeliveryUpdate(pool, { providerMessageId: String(data.id), status,
    occurredAt: data.completed_at || data.sent_at || null, errorCode: error?.code ? String(error.code) : null,
    errorDetail: error?.detail || error?.title || null, source: "message-sync" });
  return true;
}

export { persistWebhookEvent };
