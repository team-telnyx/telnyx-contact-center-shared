import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { prepareAcdTestPool, seedAgent, seedQueue } from "./helpers/acd-test-db.mjs";
import { heartbeatAgentSession } from "../lib/acd/sessions.mjs";
import { routeOne } from "../lib/acd/router.mjs";
import { actOnTextWork, completeTextWrapup } from "../lib/acd/text-lifecycle.mjs";
import { readTextDetail, readTextInteractions } from "../lib/acd/text-desktop.mjs";
import { messagingTransferTargets, transferTextWork } from "../lib/acd/text-transfer.mjs";
import { driveSaga, clearSagaDeadlineWakeups } from "../lib/acd/saga-engine.mjs";
import { saveSlaPolicies } from "../lib/acd/sla.mjs";
import { readConversationPreview } from "../lib/acd/conversation-preview.mjs";
import { applyWhatsAppInboxEvent, routePendingWhatsApp, stageWhatsAppMedia, syncWhatsAppDeliveries, whatsappEventKey } from "../lib/whatsapp/ingest.mjs";
import { whatsappSendOptions, prepareWhatsAppTemplateSend } from "../lib/whatsapp/store.mjs";
import { whatsappProvider } from "../lib/whatsapp/provider.mjs";
import { verifyWhatsAppMediaToken } from "../lib/whatsapp/media.mjs";
import { persistWebhookEvent, runInboxWorkerOnce } from "../lib/acd/inbox.mjs";
import { loadAcdTimelineProjection } from "../lib/acd/history-projection.mjs";

const pool = await prepareAcdTestPool("acd_core_test_whatsapp_channel");
await pool.query(`DROP TABLE IF EXISTS app_settings,cc_queue_wrapup_codes,cc_wrapup_codes;
  CREATE TABLE app_settings(id text PRIMARY KEY,cc_settings jsonb,updated_by text,updated_at timestamptz);
  INSERT INTO app_settings(id,cc_settings) VALUES('default','{}');
  CREATE TABLE cc_wrapup_codes(id text,name text,is_active boolean);
  CREATE TABLE cc_queue_wrapup_codes(queue_id text,wrapup_code_id text);
  INSERT INTO cc_wrapup_codes VALUES('resolved','Resolved',true);`);
after(async () => { clearSagaDeadlineWakeups(); await pool.end(); });
beforeEach(() => { process.env.APP_BASE_URL = "https://contact.example.com"; process.env.TELNYX_WEBHOOK_PUBLIC_KEY = "primary-key"; process.env.NEXTAUTH_SECRET = "test-secret"; delete process.env.TELNYX_WEBHOOK_BASE_URL; });

const CUSTOMER = "+15550001111";
async function fixture({ routing = true, sending = true, agentEnabled = true } = {}) {
  const agentId = randomUUID(), queueId = randomUUID(), numberId = randomUUID();
  const phone = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  await seedAgent(pool, agentId, { voiceReady: false });
  await seedQueue(pool, queueId, [agentId]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'whatsapp',true,4,0.25)", [queueId]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'whatsapp',$2,4,0.25)", [agentId, agentEnabled]);
  await heartbeatAgentSession(pool, { agentId, sessionId: randomUUID(), ready: { whatsapp: true } });
  await pool.query("INSERT INTO cc_whatsapp_profiles(id,name,webhook_url) VALUES('mp-wa','Contact Center WhatsApp','https://contact.example.com/api/webhooks/telnyx/whatsapp') ON CONFLICT DO NOTHING");
  await pool.query(`INSERT INTO cc_whatsapp_numbers(id,phone_number,phone_number_id,waba_id,display_name,messaging_profile_id,name,queue_id,routing_enabled,sending_enabled)
    VALUES($1,$2,$3,'waba-1','Support','mp-wa','Support WhatsApp',$4,$5,$6)`, [numberId, phone, `pn-${numberId.slice(0, 8)}`, queueId, routing, sending]);
  return { agentId, queueId, numberId, phone };
}
function inboundPayload(f, text, overrides = {}) {
  return { id: randomUUID(), direction: "inbound", type: "WHATSAPP", text, messaging_profile_id: "mp-wa",
    from: { phone_number: CUSTOMER, display_name: "Anna Nowak" }, to: [{ phone_number: f.phone, status: "webhook_delivered" }],
    whatsapp_message: text ? { type: "text", text: { body: text }, id: `wamid.${randomUUID()}` } : undefined,
    received_at: new Date().toISOString(), ...overrides };
}
async function receive(f, text, overrides) {
  const payload = inboundPayload(f, text, overrides);
  const outcome = await applyWhatsAppInboxEvent(pool, { event_type: "message.received", payload });
  await routePendingWhatsApp(pool);
  const work = (await pool.query(`SELECT w.* FROM acd_work_items w JOIN cc_whatsapp_threads t ON t.conversation_id=w.conversation_id
    WHERE t.number_id=$1 ORDER BY w.created_at DESC LIMIT 1`, [f.numberId])).rows[0];
  return { outcome, payload, work };
}
async function accept(f, work) {
  const offer = await routeOne(pool, work.id);
  assert.equal(offer.routed, true, JSON.stringify(offer));
  const detail = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "whatsapp" });
  await actOnTextWork(pool, { workItemId: work.id, agentId: f.agentId, channel: "whatsapp", action: "accept", commandId: randomUUID(), expectedVersion: detail.work.version, offerId: offer.offerId });
  return readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "whatsapp" });
}
const fakeProvider = (calls = [], respond = () => ({ data: { id: `wa-${randomUUID()}`, to: [{ status: "queued" }] } })) =>
  whatsappProvider(null, async (path, options) => { calls.push({ path, body: options?.body }); return respond(options?.body); });
async function send(f, detail, body, provider, extra = {}, options = {}) {
  return actOnTextWork(pool, { workItemId: detail.work.id, agentId: f.agentId, channel: "whatsapp", action: "send", commandId: randomUUID(), expectedVersion: detail.work.version, body, ...extra },
    { ...whatsappSendOptions({ provider }), ...options });
}
const waRow = (messageId) => pool.query("SELECT * FROM cc_whatsapp_messages WHERE message_id=$1", [messageId]).then(r => r.rows[0]);
const file = (name, type, text) => { const bytes = Buffer.from(text); return { name, content_type: type, bytes, byte_size: bytes.length, content_hash: createHash("sha256").update(bytes).digest("hex"), kind: type.startsWith("image/") ? "image" : "document" }; };

test("heartbeat capability follows the agent WhatsApp policy", async () => {
  const f = await fixture();
  const ready = await heartbeatAgentSession(pool, { agentId: f.agentId, sessionId: randomUUID(), ready: { whatsapp: true } });
  assert.equal(ready.ready.whatsapp, true);
  const other = await fixture({ agentEnabled: false });
  const disabled = await heartbeatAgentSession(pool, { agentId: other.agentId, sessionId: randomUUID(), ready: { whatsapp: true } });
  assert.equal(disabled.ready.whatsapp, false);
});

test("inbound WhatsApp creates one thread and episode, carries the customer's WhatsApp name and reaches the agent desktop", async () => {
  const f = await fixture();
  const first = await receive(f, "Hi, is my order ready?");
  assert.equal(first.outcome, "applied");
  assert.equal(first.work.channel, "whatsapp");
  assert.equal(first.work.state, "queued");
  assert.equal(first.work.customer_address, CUSTOMER);
  const duplicate = await applyWhatsAppInboxEvent(pool, { event_type: "message.received", payload: first.payload });
  assert.equal(duplicate, "applied");
  await routePendingWhatsApp(pool);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_messages WHERE work_item_id=$1", [first.work.id])).rows[0].n, 1);
  const detail = await accept(f, first.work);
  assert.equal(detail.work.state, "active");
  assert.equal(detail.customerName, "Anna Nowak");
  assert.equal(detail.whatsapp.business_number, f.phone);
  assert.equal(detail.whatsapp.window.open, true);
  assert.ok(detail.whatsapp.mediaPolicy.mimeTypes.includes("image/jpeg"));
  assert.equal(detail.messages[0].delivery.status, "received");
  assert.equal(detail.messages[0].delivery.provider, "whatsapp");
  const feed = await readTextInteractions(pool, f.agentId);
  assert.ok(feed.interactions.some(item => item.id === first.work.id && item.channel === "whatsapp" && item.state === "active" && item.from_name === "Anna Nowak"));
  const second = await receive(f, "Order 1234");
  assert.equal(second.work.id, first.work.id);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_messages WHERE work_item_id=$1", [first.work.id])).rows[0].n, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_conversations WHERE channel='whatsapp' AND attributes->>'business_number'=$1", [f.phone])).rows[0].n, 1);
  const preview = await readConversationPreview(pool, { workItemId: first.work.id, readerId: "supervisor", supervisor: true }).catch(() => null);
  if (preview) { assert.equal(preview.whatsapp.customer_name, "Anna Nowak"); assert.equal(preview.messages[0].delivery.provider, "whatsapp"); }
});

test("inbound media is downloaded outside the routing lock and attached to the message; failures still route", async () => {
  const f = await fixture();
  const payload = inboundPayload(f, "", { whatsapp_message: { type: "image", image: { url: "https://media.telnyx.com/photo.jpg", mime_type: "image/jpeg", caption: "My receipt" } } });
  assert.equal(await applyWhatsAppInboxEvent(pool, { event_type: "message.received", payload }), "applied");
  assert.equal(await routePendingWhatsApp(pool), false, "routing waits for the media download");
  const bytes = Buffer.from("fake-jpeg-bytes");
  const downloads = [];
  assert.equal(await stageWhatsAppMedia(pool, { credentials: { apiKey: "k" }, download: async (url, options) => { downloads.push({ url, apiKey: options.apiKey }); return { bytes, contentType: "image/jpeg", contentHash: createHash("sha256").update(bytes).digest("hex") }; } }), true);
  assert.deepEqual(downloads, [{ url: "https://media.telnyx.com/photo.jpg", apiKey: "k" }]);
  assert.equal(await routePendingWhatsApp(pool), true);
  const work = (await pool.query(`SELECT w.* FROM acd_work_items w JOIN cc_whatsapp_threads t ON t.conversation_id=w.conversation_id WHERE t.number_id=$1`, [f.numberId])).rows[0];
  const detail = await accept(f, work);
  assert.equal(detail.messages[0].body, "My receipt");
  assert.equal(detail.messages[0].attachments.length, 1);
  assert.equal(detail.messages[0].attachments[0].content_type, "image/jpeg");
  assert.match(detail.messages[0].attachments[0].url, new RegExp(`^/api/contact-center/whatsapp/${work.id}/attachments/`));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cc_whatsapp_media")).rows[0].n, 0, "staged bytes are released after routing");
  // a media download that keeps failing routes the message with a note after three attempts
  const broken = inboundPayload(f, "", { whatsapp_message: { type: "document", document: { url: "https://media.telnyx.com/missing.pdf", mime_type: "application/pdf", filename: "missing.pdf" } } });
  await applyWhatsAppInboxEvent(pool, { event_type: "message.received", payload: broken });
  for (let attempt = 0; attempt < 3; attempt++) {
    await pool.query("UPDATE cc_whatsapp_received SET route_after=now() WHERE provider_message_id=$1", [broken.id]);
    assert.equal(await stageWhatsAppMedia(pool, { credentials: { apiKey: "k" }, download: async () => { throw new Error("HTTP 404"); } }), true);
  }
  const state = (await pool.query("SELECT media_state,media_error FROM cc_whatsapp_received WHERE provider_message_id=$1", [broken.id])).rows[0];
  assert.deepEqual([state.media_state, state.media_error], ["failed", "HTTP 404"]);
  assert.equal(await routePendingWhatsApp(pool), true);
  const refreshed = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "whatsapp" });
  assert.equal(refreshed.messages.at(-1).body, "[Document: missing.pdf] (media could not be downloaded)");
  assert.equal(refreshed.messages.at(-1).delivery.content.media.state, "failed");
});

test("a number mapped without a messaging profile cannot send and says what to fix", async () => {
  const f = await fixture();
  const { work } = await receive(f, "Hello?");
  const detail = await accept(f, work);
  await pool.query("UPDATE cc_whatsapp_numbers SET messaging_profile_id=NULL WHERE id=$1", [f.numberId]);
  const calls = [];
  await assert.rejects(send(f, detail, "Hi", fakeProvider(calls, () => ({ data: { id: "wa-never" } }))), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /not connected to a Contact Center messaging profile/);
    return true;
  });
  assert.equal(calls.length, 0, "nothing reaches Telnyx without a sending profile");
});

test("agent text reply is journaled, accepted, satisfies SLA and follows sent → delivered → read monotonically", async () => {
  const f = await fixture();
  await saveSlaPolicies(pool, { revision: (await pool.query("SELECT COALESCE((cc_settings->'sla'->>'revision')::int,0) AS r FROM app_settings WHERE id='default'")).rows[0].r,
    policies: { whatsapp: { enabled: true, thresholdSeconds: 600, targetPercentage: 90, warningPercentage: 80, clock: "24x7" } }, actor: "test" });
  const { work } = await receive(f, "Question about billing");
  const detail = await accept(f, work);
  const calls = [];
  const result = await send(f, detail, "Sure — what is your account number? 😀", fakeProvider(calls, () => ({ data: { id: "wa-msg-1", to: [{ status: "queued" }] } })));
  assert.equal(result.status, "queued");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/messages/whatsapp");
  // The number's Contact Center profile is the sending profile: Telnyx rejects
  // WhatsApp-only numbers without `messaging_profile_id` (error 40305).
  assert.deepEqual(calls[0].body, { from: f.phone, to: CUSTOMER, type: "WHATSAPP", messaging_profile_id: "mp-wa", whatsapp_message: { type: "text", text: { body: "Sure — what is your account number? 😀", preview_url: false } }, webhook_url: "https://contact.example.com/api/webhooks/telnyx/whatsapp" });
  let row = await waRow(result.message.id);
  assert.deepEqual([row.status, row.provider_message_id, row.kind], ["accepted", "wa-msg-1", "text"]);
  const sla = (await pool.query("SELECT served_at,state FROM acd_sla_status WHERE work_item_id=$1", [work.id])).rows[0];
  assert.ok(sla?.served_at, "send acceptance records the SLA service evidence");
  assert.equal(sla.state, "met");
  await actOnTextWork(pool, { workItemId: work.id, agentId: f.agentId, channel: "whatsapp", action: "send", commandId: result.message.client_id, expectedVersion: detail.work.version, body: "Sure — what is your account number? 😀" },
    whatsappSendOptions({ provider: fakeProvider(calls) }));
  assert.equal(calls.length, 1, "replaying the same command does not send twice");
  assert.equal(await applyWhatsAppInboxEvent(pool, { event_type: "message.sent", occurred_at: new Date().toISOString(), payload: { id: "wa-msg-1", direction: "outbound", type: "WHATSAPP", to: [{ phone_number: CUSTOMER, status: "sent" }], sent_at: new Date().toISOString() } }), "applied");
  assert.equal((await waRow(result.message.id)).status, "sent");
  assert.equal(await applyWhatsAppInboxEvent(pool, { event_type: "message.delivered", occurred_at: new Date().toISOString(), payload: { id: "wa-msg-1", direction: "outbound", to: [{ status: "delivered" }], completed_at: new Date(Date.now() + 1000).toISOString() } }), "applied");
  row = await waRow(result.message.id);
  assert.deepEqual([row.status, row.next_delivery_sync_at], ["delivered", null]);
  assert.equal(await applyWhatsAppInboxEvent(pool, { event_type: "message.read", occurred_at: new Date().toISOString(), payload: { id: "wa-msg-1", direction: "outbound", to: [{ status: "read" }], read_at: new Date(Date.now() + 2000).toISOString() } }), "applied");
  assert.equal((await waRow(result.message.id)).status, "read");
  assert.equal(await applyWhatsAppInboxEvent(pool, { event_type: "message.sent", occurred_at: new Date().toISOString(), payload: { id: "wa-msg-1", direction: "outbound", to: [{ status: "sent" }] } }), "noop");
  assert.equal(await applyWhatsAppInboxEvent(pool, { event_type: "message.finalized", payload: { id: "never-sent", direction: "outbound", to: [{ status: "delivered" }] } }), "unmatched");
  const projected = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "whatsapp" });
  assert.equal(projected.messages.at(-1).delivery.status, "read");
  const view = (await pool.query("SELECT routing_metadata FROM acd_history_interactions WHERE id=$1", [work.id])).rows[0].routing_metadata;
  assert.ok(view.timeline.every(entry => entry.source === "acd_core"));
  const timeline = (await loadAcdTimelineProjection(pool, work.id, { routingMetadata: view })).timeline.map(entry => entry.type);
  assert.ok(!timeline.some(type => ["message_delivery_updated", "message_send_updated", "text_message_created"].includes(type)), JSON.stringify(timeline));
});

test("media replies become one WhatsApp message per file with signed public links; the caption rides on the first", async () => {
  const f = await fixture();
  const detail = await accept(f, (await receive(f, "Can you send the invoice?")).work);
  const calls = [];
  const result = await send(f, detail, "Here you go", fakeProvider(calls), {}, { attachments: [file("invoice.pdf", "application/pdf", "%PDF-1.7 fake"), file("photo.jpg", "image/jpeg", "\xff\xd8\xff fake")] });
  assert.equal(result.messages.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.whatsapp_message.type, "document");
  assert.deepEqual([calls[0].body.whatsapp_message.document.caption, calls[0].body.whatsapp_message.document.filename], ["Here you go", "invoice.pdf"]);
  assert.equal(calls[1].body.whatsapp_message.type, "image");
  assert.equal(calls[1].body.whatsapp_message.image.caption, undefined);
  const link = new URL(calls[0].body.whatsapp_message.document.link);
  const attachmentId = link.pathname.split("/").pop();
  assert.equal(verifyWhatsAppMediaToken(attachmentId, link.searchParams.get("exp"), link.searchParams.get("sig")), true);
  const stored = (await pool.query("SELECT f.name,f.content_type,w.direction FROM acd_text_attachments f JOIN cc_whatsapp_messages w ON w.message_id=f.message_id WHERE f.id=$1", [attachmentId])).rows[0];
  assert.deepEqual([stored.name, stored.content_type, stored.direction], ["invoice.pdf", "application/pdf", "outbound"]);
  const refreshed = await readTextDetail(pool, { workItemId: detail.work.id, agentId: f.agentId, channel: "whatsapp" });
  const agentMessages = refreshed.messages.filter(m => m.sender_role === "agent");
  assert.deepEqual(agentMessages.map(m => [m.body, m.attachments.length, m.delivery.status, m.delivery.kind]), [["Here you go", 1, "accepted", "document"], ["photo.jpg", 1, "accepted", "image"]]);
  // a long caption becomes its own text message ahead of the files
  const long = "x".repeat(1100);
  const longResult = await send(f, { ...detail, work: { ...detail.work, version: result.version } }, long, fakeProvider(calls), {}, { attachments: [file("a.jpg", "image/jpeg", "jpg")] });
  assert.equal(longResult.messages.length, 2);
  assert.equal(calls[2].body.whatsapp_message.type, "text");
  assert.equal(calls[3].body.whatsapp_message.type, "image");
});

test("agent sends a location: validated, journaled in the inbound shape and delivered as a WhatsApp location", async () => {
  const f = await fixture();
  const { work } = await receive(f, "Where are you?");
  const detail = await accept(f, work);
  const calls = [];
  await assert.rejects(send(f, detail, "", fakeProvider(calls), { location: { latitude: 95, longitude: 21 } }), /Latitude/);
  assert.equal(calls.length, 0);
  const fresh = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "whatsapp" });
  const result = await send(f, fresh, "", fakeProvider(calls, () => ({ data: { id: "wa-loc-1" } })), { location: { latitude: " 52.2297 ", longitude: "21.0122", name: " Telnyx office ", address: "Nowy Świat 1, Warszawa" } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.whatsapp_message, { type: "location", location: { latitude: "52.2297", longitude: "21.0122", name: "Telnyx office", address: "Nowy Świat 1, Warszawa" } });
  const row = await waRow(result.message.id);
  const location = { latitude: "52.2297", longitude: "21.0122", name: "Telnyx office", address: "Nowy Świat 1, Warszawa" };
  assert.deepEqual([row.kind, row.content.location, result.message.body], ["location", location, "[Location: Telnyx office, Nowy Świat 1, Warszawa]"]);
  const view = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "whatsapp" });
  assert.deepEqual(view.messages.at(-1).delivery.content.location, location, "the bubble gets the same shape as an inbound location");
});

test("agent sends contact cards built from the Contacts directory", async () => {
  const f = await fixture();
  await pool.query(`INSERT INTO contacts(id,display_name,first_name,last_name,phone,mobile) VALUES('ct-anna','','Anna','Nowak','+48 22 123 45 67','+48600000001'),('ct-gone','Gone','Gone',NULL,NULL,NULL) ON CONFLICT (id) DO NOTHING`);
  await pool.query("UPDATE contacts SET deleted_at=now() WHERE id='ct-gone'");
  const { work } = await receive(f, "Who should I call?");
  const detail = await accept(f, work);
  const calls = [];
  await assert.rejects(send(f, detail, "", fakeProvider(calls), { contactIds: ["ct-anna", "ct-gone"] }), /no longer exist/);
  const fresh = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "whatsapp" });
  const result = await send(f, fresh, "", fakeProvider(calls, () => ({ data: { id: "wa-ct-1" } })), { contactIds: ["ct-anna"] });
  assert.deepEqual(calls[0].body.whatsapp_message, { type: "contacts", contacts: [{ name: { formatted_name: "Anna Nowak", first_name: "Anna", last_name: "Nowak" },
    phones: [{ phone: "+48600000001", type: "CELL", wa_id: "48600000001" }, { phone: "+48221234567", type: "MAIN", wa_id: "48221234567" }] }] });
  const row = await waRow(result.message.id);
  assert.deepEqual([row.kind, row.content.contacts, result.message.body], ["contacts", [{ name: "Anna Nowak", phones: ["+48600000001", "+48221234567"], emails: [], company: "" }], "[Contact: Anna Nowak]"]);
});

test("reactions: the customer's reaction lands on the agent's bubble and the agent can react to the customer's message", async () => {
  const f = await fixture();
  const { work } = await receive(f, "Hello, my order is late");
  const detail = await accept(f, work);
  const calls = [];
  const sent = await send(f, detail, "So what is your problem I can help with?", fakeProvider(calls, () => ({ data: { id: "tx-agent-1" } })));
  // Telnyx names the target of a reaction by its own id of our message.
  const reaction = await receive(f, "", { whatsapp_message: { type: "reaction", reaction: { message_id: "tx-agent-1", emoji: "😮" }, id: `wamid.${randomUUID()}` } });
  assert.equal(reaction.work.id, work.id, "a reaction during a live episode joins it");
  let view = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "whatsapp" });
  assert.equal(view.messages.some((m) => m.delivery?.kind === "reaction"), false, "the reaction is not a bubble of its own");
  assert.deepEqual(view.messages.find((m) => m.id === sent.message.id).delivery.reactions.map((r) => [r.emoji, r.sender_role]), [["😮", "customer"]]);
  // The agent reacts to the customer's message; the provider gets that message's Telnyx id.
  const customerMessage = view.messages.find((m) => m.sender_role === "customer");
  const reacted = await send(f, view, "", fakeProvider(calls, () => ({ data: { id: "tx-agent-2" } })), { reaction: { messageId: customerMessage.id, emoji: "👍" } });
  assert.deepEqual(calls.at(-1).body.whatsapp_message, { type: "reaction", reaction: { message_id: customerMessage.delivery.provider_message_id, emoji: "👍" } });
  assert.equal(reacted.message.body, "Reacted 👍");
  view = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "whatsapp" });
  assert.deepEqual(view.messages.find((m) => m.id === customerMessage.id).delivery.reactions.map((r) => [r.emoji, r.sender_role]), [["👍", "agent"]]);
  assert.equal(view.messages.some((m) => m.id === reacted.message.id), false, "the agent's reaction is folded onto the customer bubble");
  await assert.rejects(send(f, view, "", fakeProvider(calls), { reaction: { messageId: sent.message.id, emoji: "👍" } }), /customer's messages only/);
  view = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "whatsapp" });
  await assert.rejects(send(f, view, "", fakeProvider(calls), { reaction: { messageId: customerMessage.id, emoji: "not-an-emoji" } }), /single emoji/);
});

test("a closed 24-hour window blocks free-form replies but allows approved templates", async () => {
  const f = await fixture();
  const detail = await accept(f, (await receive(f, "Hello")).work);
  await pool.query("UPDATE cc_whatsapp_threads SET last_inbound_at=now()-interval '25 hours' WHERE conversation_id=$1", [detail.work.conversation_id]);
  const closed = await readTextDetail(pool, { workItemId: detail.work.id, agentId: f.agentId, channel: "whatsapp" });
  assert.equal(closed.whatsapp.window.open, false);
  await assert.rejects(send(f, closed, "Are you there?", fakeProvider()), /24-hour/);
  const template = { id: "tpl-1", name: "order_update", language: "en_US", category: "UTILITY", status: "APPROVED", components: [{ type: "BODY", text: "Hi {{1}}, order {{2}} shipped." }] };
  assert.throws(() => prepareWhatsAppTemplateSend({ ...template, status: "PENDING" }, {}), /approved/);
  assert.throws(() => prepareWhatsAppTemplateSend(template, { "body:1": "Anna" }), /Body \{\{2\}\}/);
  const resolved = prepareWhatsAppTemplateSend(template, { "body:1": "Anna", "body:2": "1234" });
  assert.equal(resolved.text, "Hi Anna, order 1234 shipped.");
  const calls = [];
  const result = await send(f, closed, resolved.text, fakeProvider(calls), { template: resolved });
  assert.equal(result.status, "queued");
  assert.deepEqual(calls[0].body.whatsapp_message, { type: "template", template: { template_id: "tpl-1", components: [{ type: "body", parameters: [{ type: "text", text: "Anna" }, { type: "text", text: "1234" }] }] } });
  const row = await waRow(result.message.id);
  assert.deepEqual([row.kind, row.content.template.name, result.message.body], ["template", "order_update", "Hi Anna, order 1234 shipped."]);
});

test("provider rejection marks the message failed with the provider detail; a lost response is never resent", async () => {
  const f = await fixture();
  const detail = await accept(f, (await receive(f, "hello")).work);
  const rejected = await send(f, detail, "This will be rejected", whatsappProvider(null, async () => { throw Object.assign(new Error("Recipient is not on WhatsApp"), { status: 422, code: "40310" }); }));
  const failed = await waRow(rejected.message.id);
  assert.deepEqual([failed.status, failed.error_code], ["failed", "40310"]);
  assert.match(failed.error_detail, /not on WhatsApp/);
  const calls = [];
  const lost = await send(f, { ...detail, work: { ...detail.work, version: rejected.version } }, "Lost in transit", whatsappProvider(null, async (path, options) => { calls.push(options.body); throw new Error("socket hang up"); }));
  const row = await waRow(lost.message.id);
  assert.equal(row.status, "queued");
  assert.equal((await pool.query("SELECT status FROM acd_commands WHERE saga_id=$1", [row.saga_id])).rows[0].status, "ambiguous");
  await driveSaga(pool, row.saga_id, { provider: whatsappProvider(null, async (path, options) => { calls.push(options.body); return { data: { id: "should-not-happen" } }; }) });
  assert.equal(calls.length, 1, "an ambiguous send is not replayed because the API has no idempotency key");
});

test("paused sending and routing are enforced; unmanaged numbers and idle reactions stay out of the queue", async () => {
  const paused = await fixture({ sending: false });
  const detail = await accept(paused, (await receive(paused, "hi")).work);
  await assert.rejects(send(paused, detail, "reply", fakeProvider()), /paused/);
  const offline = await fixture({ routing: false });
  const backlog = await receive(offline, "Anyone there?");
  assert.equal(backlog.work, undefined);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cc_whatsapp_received WHERE number_id=$1 AND processed_at IS NULL", [offline.numberId])).rows[0].n, 1);
  await pool.query("UPDATE cc_whatsapp_numbers SET routing_enabled=true WHERE id=$1", [offline.numberId]);
  await routePendingWhatsApp(pool);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_work_items w JOIN cc_whatsapp_threads t ON t.conversation_id=w.conversation_id WHERE t.number_id=$1", [offline.numberId])).rows[0].n, 1);
  assert.equal(await applyWhatsAppInboxEvent(pool, { event_type: "message.received", payload: inboundPayload({ phone: "+19999999999" }, "lost") }), "unmatched");
  const idle = await fixture();
  const reaction = await receive(idle, "", { whatsapp_message: { type: "reaction", reaction: { message_id: "wamid.x", emoji: "👍" } } });
  assert.equal(reaction.work, undefined, "a reaction without a live episode is archived");
  assert.ok((await pool.query("SELECT processed_at FROM cc_whatsapp_received WHERE number_id=$1", [idle.numberId])).rows[0].processed_at);
});

test("completion ends the episode, wrap-up defers arrivals, and later messages open a new episode on the same thread", async () => {
  const f = await fixture();
  const detail = await accept(f, (await receive(f, "First question")).work);
  await actOnTextWork(pool, { workItemId: detail.work.id, agentId: f.agentId, channel: "whatsapp", action: "complete", commandId: randomUUID(), expectedVersion: detail.work.version });
  assert.equal((await pool.query("SELECT state FROM cc_whatsapp_threads WHERE conversation_id=$1", [detail.work.conversation_id])).rows[0].state, "completed");
  const during = await receive(f, "One more thing");
  assert.equal(during.work.id, detail.work.id, "no second episode while wrap-up is pending");
  const wrapup = await completeTextWrapup(pool, { workItemId: detail.work.id, expectedAgentId: f.agentId, wrapupCodeId: "resolved" });
  assert.equal(wrapup.completed, true);
  await routePendingWhatsApp(pool);
  const episodes = (await pool.query("SELECT id,state FROM acd_work_items WHERE conversation_id=$1 ORDER BY created_at", [detail.work.conversation_id])).rows;
  assert.equal(episodes.length, 2);
  assert.equal(episodes[1].state, "queued");
});

test("transfer moves the episode to another WhatsApp queue", async () => {
  const f = await fixture();
  const detail = await accept(f, (await receive(f, "Transfer me")).work);
  const targetQueue = randomUUID(), otherAgent = randomUUID();
  await seedAgent(pool, otherAgent, { voiceReady: false });
  await seedQueue(pool, targetQueue, [otherAgent]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'whatsapp',true,4,0.25)", [targetQueue]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'whatsapp',true,4,0.25)", [otherAgent]);
  await heartbeatAgentSession(pool, { agentId: otherAgent, sessionId: randomUUID(), ready: { whatsapp: true } });
  const targets = await messagingTransferTargets(pool, { workItemId: detail.work.id, agentId: f.agentId, channel: "whatsapp" });
  assert.ok(targets.queues.some(q => q.id === targetQueue));
  await transferTextWork(pool, { workItemId: detail.work.id, agentId: f.agentId, channel: "whatsapp", queueId: targetQueue, expectedVersion: targets.version, commandId: randomUUID() });
  const moved = (await pool.query("SELECT state,queue_id FROM acd_work_items WHERE id=$1", [detail.work.id])).rows[0];
  assert.deepEqual([moved.state, moved.queue_id], ["queued", targetQueue]);
  await completeTextWrapup(pool, { workItemId: detail.work.id, expectedAgentId: f.agentId, wrapupCodeId: "resolved" });
  assert.equal((await routeOne(pool, detail.work.id)).agentId, otherAgent);
});

test("signed webhook rows flow through the durable inbox worker and delivery reconciliation recovers a missed receipt", async () => {
  const f = await fixture();
  const payload = inboundPayload(f, "Through the inbox");
  const eventId = whatsappEventKey("webhook", randomUUID());
  await persistWebhookEvent(pool, { eventId, provider: "telnyx-whatsapp", eventType: "message.received", payload, sourceRoute: "/api/webhooks/telnyx/whatsapp" });
  await runInboxWorkerOnce(pool, { node: "test", limit: 10, handler: row => applyWhatsAppInboxEvent(pool, row) });
  assert.equal((await pool.query("SELECT status FROM acd_webhook_events WHERE event_id=$1", [eventId])).rows[0].status, "applied");
  await routePendingWhatsApp(pool);
  const detail = await accept(f, (await pool.query("SELECT w.* FROM acd_work_items w JOIN cc_whatsapp_threads t ON t.conversation_id=w.conversation_id WHERE t.number_id=$1", [f.numberId])).rows[0]);
  const result = await send(f, detail, "Recovered later", fakeProvider([], () => ({ data: { id: "wa-sync-1", to: [{ status: "queued" }] } })));
  await pool.query("UPDATE cc_whatsapp_messages SET next_delivery_sync_at=now()-interval '1 second' WHERE message_id=$1", [result.message.id]);
  const requests = [];
  assert.equal(await syncWhatsAppDeliveries(pool, { request: async path => { requests.push(path); return { data: { id: "wa-sync-1", to: [{ phone_number: CUSTOMER, status: "delivered" }], completed_at: new Date().toISOString() } }; } }), true);
  assert.deepEqual(requests, ["/messages/wa-sync-1"]);
  const row = await waRow(result.message.id);
  assert.deepEqual([row.status, row.next_delivery_sync_at], ["delivered", null]);
  assert.equal(await syncWhatsAppDeliveries(pool, { request: async () => { throw new Error("must not be called"); } }), false);
});
