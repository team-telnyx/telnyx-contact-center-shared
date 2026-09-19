import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool, seedAgent, seedQueue } from "./helpers/acd-test-db.mjs";
import { heartbeatAgentSession } from "../lib/acd/sessions.mjs";
import { routeOne } from "../lib/acd/router.mjs";
import { actOnTextWork, completeTextWrapup } from "../lib/acd/text-lifecycle.mjs";
import { readTextDetail, readTextInteractions } from "../lib/acd/text-desktop.mjs";
import { messagingTransferTargets, transferTextWork } from "../lib/acd/text-transfer.mjs";
import { driveSaga, clearSagaDeadlineWakeups } from "../lib/acd/saga-engine.mjs";
import { saveSlaPolicies } from "../lib/acd/sla.mjs";
import { MESSAGING_CHANNELS, RELEASED_CHANNELS } from "../lib/acd/channel-registry.mjs";
import { applySmsInboxEvent, routePendingSms, syncSmsDeliveries, smsEventKey } from "../lib/sms/ingest.mjs";
import { smsSendOptions } from "../lib/sms/store.mjs";
import { smsProvider } from "../lib/sms/provider.mjs";
import { classifySmsText, normalizeInboundSms, reduceSmsDelivery, validateOutboundSmsText, normalizeE164 } from "../lib/sms/policy.mjs";
import { smsMessageStatus } from "../lib/sms/message-status.mjs";
import { persistWebhookEvent, runInboxWorkerOnce } from "../lib/acd/inbox.mjs";
import { loadAcdTimelineProjection } from "../lib/acd/history-projection.mjs";

const pool = await prepareAcdTestPool("acd_core_test_sms_channel");
await pool.query(`DROP TABLE IF EXISTS app_settings,cc_queue_wrapup_codes,cc_wrapup_codes;
  CREATE TABLE app_settings(id text PRIMARY KEY,cc_settings jsonb,updated_by text,updated_at timestamptz);
  INSERT INTO app_settings(id,cc_settings) VALUES('default','{}');
  CREATE TABLE cc_wrapup_codes(id text,name text,is_active boolean);
  CREATE TABLE cc_queue_wrapup_codes(queue_id text,wrapup_code_id text);
  INSERT INTO cc_wrapup_codes VALUES('resolved','Resolved',true);`);
after(async () => { clearSagaDeadlineWakeups(); await pool.end(); });

const CUSTOMER = "+15550001111";
async function fixture({ routing = true, sending = true, agentEnabled = true } = {}) {
  const agentId = randomUUID(), queueId = randomUUID(), numberId = randomUUID();
  const phone = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  await seedAgent(pool, agentId, { voiceReady: false });
  await seedQueue(pool, queueId, [agentId]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'sms',true,4,0.25)", [queueId]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'sms',$2,4,0.25)", [agentId, agentEnabled]);
  await heartbeatAgentSession(pool, { agentId, sessionId: randomUUID(), ready: { sms: true } });
  await pool.query("INSERT INTO cc_sms_profiles(id,name,webhook_url) VALUES('mp-cc','Contact Center','https://contact.example.com/api/webhooks/telnyx/sms') ON CONFLICT DO NOTHING");
  await pool.query(`INSERT INTO cc_sms_numbers(id,phone_number,provider_number_id,messaging_profile_id,name,queue_id,routing_enabled,sending_enabled)
    VALUES($1,$2,$3,'mp-cc','Sales line',$4,$5,$6)`, [numberId, phone, randomUUID(), queueId, routing, sending]);
  return { agentId, queueId, numberId, phone };
}
function inboundPayload(f, text, overrides = {}) {
  return { id: randomUUID(), direction: "inbound", type: "SMS", text, encoding: "GSM-7", parts: 1, messaging_profile_id: "mp-cc",
    from: { phone_number: CUSTOMER, carrier: "T-Mobile", line_type: "Wireless" }, to: [{ phone_number: f.phone, status: "webhook_delivered" }],
    received_at: new Date().toISOString(), ...overrides };
}
async function receive(f, text, overrides) {
  const payload = inboundPayload(f, text, overrides);
  const outcome = await applySmsInboxEvent(pool, { event_type: "message.received", payload });
  await routePendingSms(pool);
  const work = (await pool.query(`SELECT w.* FROM acd_work_items w JOIN cc_sms_threads t ON t.conversation_id=w.conversation_id
    WHERE t.number_id=$1 ORDER BY w.created_at DESC LIMIT 1`, [f.numberId])).rows[0];
  return { outcome, payload, work };
}
async function accept(f, work) {
  const offer = await routeOne(pool, work.id);
  assert.equal(offer.routed, true, JSON.stringify(offer));
  const detail = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "sms" });
  await actOnTextWork(pool, { workItemId: work.id, agentId: f.agentId, channel: "sms", action: "accept", commandId: randomUUID(), expectedVersion: detail.work.version, offerId: offer.offerId });
  return readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "sms" });
}
const fakeProvider = (calls = [], respond = () => ({ data: { id: `msg-${randomUUID()}`, encoding: "GSM-7", parts: 1, to: [{ status: "queued" }] } })) =>
  smsProvider(null, async (path, options) => { calls.push({ path, body: options?.body }); return respond(options?.body); });
async function send(f, detail, body, provider) {
  return actOnTextWork(pool, { workItemId: detail.work.id, agentId: f.agentId, channel: "sms", action: "send", commandId: randomUUID(), expectedVersion: detail.work.version, body },
    smsSendOptions({ provider }));
}
const smsRow = (messageId) => pool.query("SELECT * FROM cc_sms_messages WHERE message_id=$1", [messageId]).then(r => r.rows[0]);

test("SMS is a released messaging-family channel", () => {
  assert.ok(RELEASED_CHANNELS.includes("sms"));
  assert.deepEqual(MESSAGING_CHANNELS, ["chat", "email", "whatsapp", "sms"]);
});

test("policy helpers: E.164, keywords, payload normalization, monotonic delivery, outbound limits", () => {
  assert.equal(normalizeE164(" +1 (415) 555-0123 "), "+14155550123");
  assert.throws(() => normalizeE164("4155550123"));
  assert.equal(classifySmsText("stop."), "opt_out");
  assert.equal(classifySmsText("Start"), "opt_in");
  assert.equal(classifySmsText("HELP"), "help");
  assert.equal(classifySmsText("Please stop calling"), "customer");
  const normalized = normalizeInboundSms({ id: "m1", from: { phone_number: "+1555" }, to: [{ phone_number: "+1444" }], text: "hi", type: "MMS",
    media: [{ url: "https://media.telnyx.com/a.jpg", content_type: "image/jpeg", size: 10 }, { url: "http://insecure/x" }] });
  assert.deepEqual([normalized.providerId, normalized.from, normalized.to, normalized.type, normalized.media.length], ["m1", "+1555", "+1444", "MMS", 1]);
  assert.equal(reduceSmsDelivery({ status: "delivered", occurred_at: "2026-09-14T10:00:00Z" }, { status: "sent", occurredAt: "2026-09-14T10:01:00Z" }), null);
  assert.equal(reduceSmsDelivery({ status: "sent", occurred_at: "2026-09-14T10:00:00Z" }, { status: "delivered", occurredAt: "2026-09-14T10:01:00Z" })?.status, "delivered");
  assert.equal(reduceSmsDelivery({ status: "sent", occurred_at: "2026-09-14T10:00:00Z" }, { status: "sent", occurredAt: "2026-09-14T09:00:00Z" }), null);
  assert.throws(() => validateOutboundSmsText("a".repeat(1601)), /1600/);
  assert.equal(validateOutboundSmsText(" Hi ").stats.parts, 1);
  assert.equal(smsMessageStatus({ sender_role: "agent", delivery: { status: "delivered" } }).label, "Delivered");
  assert.equal(smsMessageStatus({ sender_role: "customer" }).status, "received");
});

test("heartbeat capability follows the agent SMS policy", async () => {
  const f = await fixture();
  const ready = await heartbeatAgentSession(pool, { agentId: f.agentId, sessionId: randomUUID(), ready: { sms: true } });
  assert.equal(ready.ready.sms, true);
  const other = await fixture({ agentEnabled: false });
  const disabled = await heartbeatAgentSession(pool, { agentId: other.agentId, sessionId: randomUUID(), ready: { sms: true } });
  assert.equal(disabled.ready.sms, false);
  assert.equal(disabled.chatReady, false);
});

test("inbound SMS creates one thread, one episode and reaches the agent desktop through native routing", async () => {
  const f = await fixture();
  const first = await receive(f, "Hi, is my order ready?");
  assert.equal(first.outcome, "applied");
  assert.equal(first.work.channel, "sms");
  assert.equal(first.work.state, "queued");
  assert.equal(first.work.customer_address, CUSTOMER);
  // duplicate webhook delivery is idempotent
  const duplicate = await applySmsInboxEvent(pool, { event_type: "message.received", payload: first.payload });
  assert.equal(duplicate, "applied");
  await routePendingSms(pool);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_messages WHERE work_item_id=$1", [first.work.id])).rows[0].n, 1);
  const detail = await accept(f, first.work);
  assert.equal(detail.work.state, "active");
  assert.equal(detail.customerName, CUSTOMER);
  assert.equal(detail.sms.business_number, f.phone);
  assert.equal(detail.sms.opted_out, false);
  assert.equal(detail.messages[0].delivery.status, "received");
  const feed = await readTextInteractions(pool, f.agentId);
  assert.ok(feed.interactions.some(item => item.id === first.work.id && item.channel === "sms" && item.state === "active"));
  // a second inbound message during handling appends to the same episode
  const second = await receive(f, "Order 1234");
  assert.equal(second.work.id, first.work.id);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_messages WHERE work_item_id=$1", [first.work.id])).rows[0].n, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_conversations WHERE channel='sms' AND attributes->>'business_number'=$1", [f.phone])).rows[0].n, 1);
});

test("agent reply is journaled, accepted by the provider, satisfies SLA and follows delivery webhooks monotonically", async () => {
  const f = await fixture();
  await saveSlaPolicies(pool, { revision: (await pool.query("SELECT COALESCE((cc_settings->'sla'->>'revision')::int,0) AS r FROM app_settings WHERE id='default'")).rows[0].r,
    policies: { sms: { enabled: true, thresholdSeconds: 600, targetPercentage: 90, warningPercentage: 80, clock: "24x7" } }, actor: "test" });
  const { work } = await receive(f, "Question about billing");
  const detail = await accept(f, work);
  const calls = [];
  const result = await send(f, detail, "Sure — what is your account number? 😀", fakeProvider(calls, () => ({ data: { id: "tx-msg-1", encoding: "UCS-2", parts: 1, to: [{ status: "queued" }] } })));
  assert.equal(result.status, "queued");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/messages");
  assert.deepEqual(calls[0].body, { from: f.phone, to: CUSTOMER, text: "Sure — what is your account number? 😀", type: "SMS", use_profile_webhooks: true });
  let row = await smsRow(result.message.id);
  assert.equal(row.status, "accepted");
  assert.equal(row.provider_message_id, "tx-msg-1");
  assert.equal(row.encoding, "UCS-2");
  const accepted = await pool.query("SELECT payload FROM acd_events WHERE work_item_id=$1 AND type='message_send_updated'", [work.id]);
  assert.equal(accepted.rows.length, 1);
  assert.equal(accepted.rows[0].payload.status, "accepted");
  const sla = (await pool.query("SELECT served_at,state FROM acd_sla_status WHERE work_item_id=$1", [work.id])).rows[0];
  assert.ok(sla?.served_at, "send acceptance records the SLA service evidence");
  assert.equal(sla.state, "met");
  // replaying the same command does not send twice
  await actOnTextWork(pool, { workItemId: work.id, agentId: f.agentId, channel: "sms", action: "send", commandId: result.message.client_id, expectedVersion: detail.work.version, body: "Sure — what is your account number? 😀" },
    smsSendOptions({ provider: fakeProvider(calls) }));
  assert.equal(calls.length, 1);
  // delivery evidence via webhook events
  const sent = await applySmsInboxEvent(pool, { event_type: "message.sent", occurred_at: new Date().toISOString(),
    payload: { id: "tx-msg-1", direction: "outbound", to: [{ phone_number: CUSTOMER, status: "sent" }], sent_at: new Date().toISOString() } });
  assert.equal(sent, "applied");
  assert.equal((await smsRow(result.message.id)).status, "sent");
  const finalized = await applySmsInboxEvent(pool, { event_type: "message.finalized", occurred_at: new Date().toISOString(),
    payload: { id: "tx-msg-1", direction: "outbound", to: [{ phone_number: CUSTOMER, status: "delivered" }], completed_at: new Date(Date.now() + 1000).toISOString() } });
  assert.equal(finalized, "applied");
  row = await smsRow(result.message.id);
  assert.equal(row.status, "delivered");
  assert.equal(row.next_delivery_sync_at, null);
  // a late 'sent' redelivery never regresses a delivered message
  const late = await applySmsInboxEvent(pool, { event_type: "message.sent", occurred_at: new Date().toISOString(),
    payload: { id: "tx-msg-1", direction: "outbound", to: [{ phone_number: CUSTOMER, status: "sent" }] } });
  assert.equal(late, "noop");
  assert.equal((await smsRow(result.message.id)).status, "delivered");
  const unknown = await applySmsInboxEvent(pool, { event_type: "message.finalized", payload: { id: "never-sent", direction: "outbound", to: [{ status: "delivered" }] } });
  assert.equal(unknown, "unmatched");
  const projected = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "sms" });
  assert.equal(projected.messages.at(-1).delivery.status, "delivered");
  assert.equal(projected.messages.at(-1).sender_role, "agent");
  // Delivery evidence stays on the message; the supervisor phase timeline and
  // Event Journey show routing and handling only.
  const view = (await pool.query("SELECT routing_metadata FROM acd_history_interactions WHERE id=$1", [work.id])).rows[0].routing_metadata;
  assert.ok(view.timeline.some(entry => entry.type === "message_delivery_updated"));
  assert.ok(view.timeline.every(entry => entry.source === "acd_core"), "payload fields never override the Core timeline marker");
  const timeline = (await loadAcdTimelineProjection(pool, work.id, { routingMetadata: view })).timeline.map(entry => entry.type);
  assert.ok(!timeline.some(type => ["message_delivery_updated", "message_send_updated", "text_message_created"].includes(type)), JSON.stringify(timeline));
  assert.ok(timeline.includes("connected") && timeline.includes("enqueued"));
});

test("provider rejection marks the message failed with the provider detail; a lost response is never resent", async () => {
  const f = await fixture();
  const detail = await accept(f, (await receive(f, "hello")).work);
  const rejected = await send(f, detail, "This will be rejected", smsProvider(null, async () => { throw Object.assign(new Error("Destination is blocked"), { status: 422, code: "40300" }); }));
  const failed = await smsRow(rejected.message.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error_code, "40300");
  assert.match(failed.error_detail, /blocked/);
  const events = (await pool.query("SELECT payload->>'status' AS status FROM acd_events WHERE work_item_id=$1 AND type='message_send_updated' ORDER BY id", [detail.work.id])).rows.map(r => r.status);
  assert.deepEqual(events, ["failed"]);
  const calls = [];
  const lost = await send(f, { ...detail, work: { ...detail.work, version: rejected.version } }, "Lost in transit", smsProvider(null, async (path, options) => { calls.push(options.body); throw new Error("socket hang up"); }));
  const row = await smsRow(lost.message.id);
  assert.equal(row.status, "queued");
  const command = (await pool.query("SELECT status,attempt_count FROM acd_commands WHERE saga_id=$1", [row.saga_id])).rows[0];
  assert.equal(command.status, "ambiguous");
  await driveSaga(pool, row.saga_id, { provider: smsProvider(null, async (path, options) => { calls.push(options.body); return { data: { id: "should-not-happen" } }; }) });
  assert.equal(calls.length, 1, "an ambiguous SMS command is not replayed because the messaging API has no idempotency key");
  assert.equal((await smsRow(lost.message.id)).status, "queued");
});

test("STOP blocks agent replies until START, and carrier keywords without an episode are archived", async () => {
  const f = await fixture();
  const idle = await receive(f, "STOP");
  assert.equal(idle.work, undefined);
  const archived = (await pool.query("SELECT classification,processed_at,message_id FROM cc_sms_received WHERE number_id=$1", [f.numberId])).rows[0];
  assert.equal(archived.classification, "opt_out");
  assert.ok(archived.processed_at);
  assert.equal(archived.message_id, null);
  const thread = (await pool.query("SELECT opted_out_at FROM cc_sms_threads WHERE number_id=$1", [f.numberId])).rows[0];
  assert.ok(thread.opted_out_at);
  const restart = await receive(f, "START");
  assert.equal(restart.work, undefined);
  assert.equal((await pool.query("SELECT opted_out_at FROM cc_sms_threads WHERE number_id=$1", [f.numberId])).rows[0].opted_out_at, null);
  const detail = await accept(f, (await receive(f, "I have a question")).work);
  const stop = await receive(f, "Stop");
  assert.equal(stop.work.id, detail.work.id, "STOP during handling stays visible to the agent");
  const refreshed = await readTextDetail(pool, { workItemId: detail.work.id, agentId: f.agentId, channel: "sms" });
  assert.equal(refreshed.sms.opted_out, true);
  await assert.rejects(send(f, refreshed, "Are you still there?", fakeProvider()), /STOP/);
  await receive(f, "START");
  const again = await readTextDetail(pool, { workItemId: detail.work.id, agentId: f.agentId, channel: "sms" });
  assert.equal(again.sms.opted_out, false);
  const result = await send(f, again, "Welcome back", fakeProvider());
  assert.equal((await smsRow(result.message.id)).status, "accepted");
});

test("paused sending and routing are enforced; unmanaged numbers stay out of the archive", async () => {
  const paused = await fixture({ sending: false });
  const detail = await accept(paused, (await receive(paused, "hi")).work);
  await assert.rejects(send(paused, detail, "reply", fakeProvider()), /paused/);
  const offline = await fixture({ routing: false });
  const backlog = await receive(offline, "Anyone there?");
  assert.equal(backlog.work, undefined);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cc_sms_received WHERE number_id=$1 AND processed_at IS NULL", [offline.numberId])).rows[0].n, 1);
  await pool.query("UPDATE cc_sms_numbers SET routing_enabled=true WHERE id=$1", [offline.numberId]);
  await routePendingSms(pool);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_work_items w JOIN cc_sms_threads t ON t.conversation_id=w.conversation_id WHERE t.number_id=$1", [offline.numberId])).rows[0].n, 1);
  const unmanaged = await applySmsInboxEvent(pool, { event_type: "message.received", payload: inboundPayload({ phone: "+19999999999" }, "lost") });
  assert.equal(unmanaged, "unmatched");
});

test("completion ends the episode, wrap-up defers arrivals, and later messages open a new episode on the same thread", async () => {
  const f = await fixture();
  const detail = await accept(f, (await receive(f, "First question")).work);
  await actOnTextWork(pool, { workItemId: detail.work.id, agentId: f.agentId, channel: "sms", action: "complete", commandId: randomUUID(), expectedVersion: detail.work.version });
  assert.equal((await pool.query("SELECT state FROM cc_sms_threads WHERE conversation_id=$1", [detail.work.conversation_id])).rows[0].state, "completed");
  const during = await receive(f, "One more thing");
  assert.equal(during.work.id, detail.work.id, "no second episode while wrap-up is pending");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cc_sms_received WHERE number_id=$1 AND processed_at IS NULL", [f.numberId])).rows[0].n, 1);
  const wrapup = await completeTextWrapup(pool, { workItemId: detail.work.id, expectedAgentId: f.agentId, wrapupCodeId: "resolved" });
  assert.equal(wrapup.completed, true);
  assert.ok((await pool.query("SELECT terminal_at FROM acd_work_items WHERE id=$1", [detail.work.id])).rows[0].terminal_at);
  await routePendingSms(pool);
  const episodes = (await pool.query("SELECT id,state FROM acd_work_items WHERE conversation_id=$1 ORDER BY created_at", [detail.work.conversation_id])).rows;
  assert.equal(episodes.length, 2);
  assert.equal(episodes[1].state, "queued");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cc_sms_threads WHERE conversation_id=$1", [detail.work.conversation_id])).rows[0].n, 1);
});

test("waiting for the customer keeps the assignment; transfer moves the episode to another SMS queue", async () => {
  const f = await fixture();
  const detail = await accept(f, (await receive(f, "Transfer me")).work);
  const targetQueue = randomUUID(), otherAgent = randomUUID();
  await seedAgent(pool, otherAgent, { voiceReady: false });
  await seedQueue(pool, targetQueue, [otherAgent]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'sms',true,4,0.25)", [targetQueue]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'sms',true,4,0.25)", [otherAgent]);
  await heartbeatAgentSession(pool, { agentId: otherAgent, sessionId: randomUUID(), ready: { sms: true } });
  const targets = await messagingTransferTargets(pool, { workItemId: detail.work.id, agentId: f.agentId, channel: "sms" });
  assert.ok(targets.queues.some(q => q.id === targetQueue));
  assert.ok(targets.agents.some(a => a.id === otherAgent));
  assert.equal(targets.forward, null);
  await transferTextWork(pool, { workItemId: detail.work.id, agentId: f.agentId, channel: "sms", queueId: targetQueue, expectedVersion: targets.version, commandId: randomUUID() });
  const moved = (await pool.query("SELECT state,queue_id FROM acd_work_items WHERE id=$1", [detail.work.id])).rows[0];
  assert.deepEqual([moved.state, moved.queue_id], ["queued", targetQueue]);
  await completeTextWrapup(pool, { workItemId: detail.work.id, expectedAgentId: f.agentId, wrapupCodeId: "resolved" });
  const offer = await routeOne(pool, detail.work.id);
  assert.equal(offer.agentId, otherAgent);
});

test("signed webhook rows flow through the durable inbox worker and delivery reconciliation recovers a missed receipt", async () => {
  const f = await fixture();
  const payload = inboundPayload(f, "Through the inbox");
  const eventId = smsEventKey("webhook", randomUUID());
  await persistWebhookEvent(pool, { eventId, provider: "telnyx-sms", eventType: "message.received", payload, sourceRoute: "/api/webhooks/telnyx/sms" });
  await runInboxWorkerOnce(pool, { node: "test", limit: 10, handler: row => applySmsInboxEvent(pool, row) });
  assert.equal((await pool.query("SELECT status FROM acd_webhook_events WHERE event_id=$1", [eventId])).rows[0].status, "applied");
  await routePendingSms(pool);
  const detail = await accept(f, (await pool.query("SELECT w.* FROM acd_work_items w JOIN cc_sms_threads t ON t.conversation_id=w.conversation_id WHERE t.number_id=$1", [f.numberId])).rows[0]);
  const result = await send(f, detail, "Recovered later", fakeProvider([], () => ({ data: { id: "tx-sync-1", to: [{ status: "queued" }] } })));
  await pool.query("UPDATE cc_sms_messages SET next_delivery_sync_at=now()-interval '1 second' WHERE message_id=$1", [result.message.id]);
  const requests = [];
  const synced = await syncSmsDeliveries(pool, { request: async path => { requests.push(path); return { data: { id: "tx-sync-1", to: [{ phone_number: CUSTOMER, status: "delivered" }], completed_at: new Date().toISOString() } }; } });
  assert.equal(synced, true);
  assert.deepEqual(requests, ["/messages/tx-sync-1"]);
  const row = await smsRow(result.message.id);
  assert.equal(row.status, "delivered");
  assert.equal(row.next_delivery_sync_at, null);
  assert.equal(await syncSmsDeliveries(pool, { request: async () => { throw new Error("must not be called"); } }), false);
});
