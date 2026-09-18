import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool, seedQueue } from "./helpers/acd-test-db.mjs";
import { ensureOutboundTestSchema } from "./helpers/acd-outbound-db.mjs";
import { smsAdminAction, smsAdminResource } from "../lib/sms/admin.mjs";
import { applySmsDeliveryUpdate, routePendingSms } from "../lib/sms/ingest.mjs";
import { claimMessagingBatch, completeMessagingCampaignIfExhausted, markMessagingReplied, messagingMaxAttempts, pollMessagingDelivery, replyBacklogExceeded, runMessagingCampaignTick, sendMessagingTest, sweepStalledMessagingSends, syncMessagingDeliveries, tickOutboundMessaging, whatsappWabaMismatch } from "../lib/outbound-dialer/messaging/execution.mjs";
import { messagingSettingsFrom } from "../lib/outbound-dialer/messaging/settings.mjs";
import { validateMessagingAudience, previewMessagingMessage, loadSampleContact } from "../lib/outbound-dialer/messaging/audience.mjs";
import { OUTBOUND_MESSAGE_STATES } from "../lib/outbound-dialer/messaging/schema.mjs";

const pool = await prepareAcdTestPool("acd_core_test_outbound_messaging");
after(() => pool.end());
await ensureOutboundTestSchema(pool);
await pool.query(`DELETE FROM cc_sms_templates`);
process.env.APP_BASE_URL = "https://contact.example.com";
process.env.TELNYX_WEBHOOK_PUBLIC_KEY = "test-public-key";

const queueId = randomUUID();
await seedQueue(pool, queueId, [], { engineOwner: "acd_core" });
await pool.query(`INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'sms',true,4,0.25) ON CONFLICT DO NOTHING`, [queueId]);
const numberId = randomUUID();
await pool.query(`INSERT INTO cc_sms_numbers(id,phone_number,name,queue_id,routing_enabled,sending_enabled) VALUES($1,'+15550001000','Campaign line',$2,true,true)`, [numberId, queueId]);
const secondNumberId = randomUUID();
await pool.query(`INSERT INTO cc_sms_numbers(id,phone_number,name,queue_id,routing_enabled,sending_enabled) VALUES($1,'+15550002000','Second line',$2,true,true)`, [secondNumberId, queueId]);

const baseSettings = { max_lines: 20, allowed_numbers: ["+15550001111"], callable_days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], callable_window: { earliest: "00:00", latest: "23:59", timezone: "UTC" },
  messaging: { enabled_channels: { sms: true }, batch: { max_messages_per_batch: 10, batch_interval_seconds: 1, max_in_flight_per_campaign: 100 }, sms: { opt_out_footer_text: "Reply STOP to opt out", max_segments_per_message: 3 }, safety: { failure_rate_min_sample: 1000 } } };
async function setSettings(patch = {}) {
  const settings = { ...baseSettings, ...patch, messaging: { ...baseSettings.messaging, ...(patch.messaging || {}) } };
  await pool.query(`UPDATE outbound_settings SET settings=$1::jsonb WHERE id='default'`, [JSON.stringify(settings)]);
  return settings;
}
beforeEach(async () => { await setSettings(); });

function fakeProvider(responses = []) {
  const calls = [];
  return { calls, async send(command) { calls.push(command); const next = responses.shift(); return typeof next === "function" ? next(command) : next || { outcome: "accepted", httpStatus: 200, response: { data: { id: `msg-${calls.length}`, encoding: "GSM-7", parts: 1 } } }; } };
}

async function template(overrides = {}) {
  const saved = await smsAdminAction(pool, { action: "save_template", name: `Promo ${randomUUID().slice(0, 8)}`, body: "Hi {{first_name}}, your code is {{code}}", category: "marketing", language: "en", ...overrides }, "admin");
  return saved.result;
}

async function fixture({ contacts = [{ "First Name": "Anna", Mobile: "+15550100001", code: "A1" }, { "First Name": "Bob", Mobile: "+15550100002", code: "B2" }], mapping, templateId, config = {}, status = "running" } = {}) {
  const list = (await pool.query(`INSERT INTO outbound_contact_lists (name, status, custom_field_schema, metadata) VALUES ('Audience', 'validated', '[{"name":"Mobile","type":"phone"}]', '{"csv_import_settings":{"column_mappings":{"Mobile":["number:mobile"]},"selected_columns":["First Name","Mobile","code"]}}') RETURNING id`)).rows[0].id;
  for (const contact of contacts) {
    await pool.query(`INSERT INTO outbound_contact_records (contact_list_id, row_data, contact_methods, validation_status) VALUES ($1,$2,$3,$4)`,
      [list, JSON.stringify(contact), JSON.stringify({ number: { mobile: contact.Mobile }, email: {}, whatsapp: {} }), contact.__status || "valid"]);
  }
  const templateRow = templateId ? { id: templateId } : await template();
  const messaging = { destination_fields: ["number:mobile"], sender: { sms: { number_ids: [numberId], strategy: "round_robin" } }, template: { sms: { template_id: templateRow.id } },
    variable_mapping: mapping || [{ key: "first_name", source: "contact_field", value: "First Name" }, { key: "code", source: "contact_field", value: "code" }], missing_variable_policy: "skip", ...config };
  const campaign = (await pool.query(`INSERT INTO outbound_campaigns (name, status, mode, channel, handler_type, contact_list_id, retry_policy, metadata)
    VALUES ('SMS promo', $1, 'broadcast', 'sms', 'queue', $2, '{"maxAttempts":2}', $3) RETURNING *`, [status, list, JSON.stringify({ messaging })])).rows[0];
  return { list, campaign, template: templateRow };
}
const ledgerFor = async (campaignId) => (await pool.query(`SELECT * FROM outbound_attempt_ledger WHERE campaign_id=$1 ORDER BY created_at, id`, [campaignId])).rows;
const reload = async (id) => (await pool.query(`SELECT * FROM outbound_campaigns WHERE id=$1`, [id])).rows[0];

test("schema upgrade adds message state and email/broadcast to the outbound enums", async () => {
  const columns = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='outbound_attempt_ledger' AND column_name IN ('message_state','to_address','sender_address','provider_message_id','delivery_sync_at')`)).rows.map((r) => r.column_name).sort();
  assert.deepEqual(columns, ["delivery_sync_at", "message_state", "provider_message_id", "sender_address", "to_address"]);
  const inserted = (await pool.query(`INSERT INTO outbound_campaigns (name, status, mode, channel) VALUES ('email draft','draft','broadcast','email') RETURNING channel, mode`)).rows[0];
  assert.deepEqual(inserted, { channel: "email", mode: "broadcast" });
  await assert.rejects(pool.query(`INSERT INTO outbound_attempt_ledger (campaign_id, status, channel, message_state) SELECT id, 'claimed', 'sms', 'bogus' FROM outbound_campaigns LIMIT 1`), /message_state/);
  assert.ok(OUTBOUND_MESSAGE_STATES.includes("replied"));
});

test("SMS templates are stored locally with extracted variables and protected while campaigns use them", async () => {
  const created = await template({ name: "Welcome", body: "Welcome {{ first_name }}! Order {{order}}" });
  assert.deepEqual(created.variables, ["first_name", "order"]);
  await assert.rejects(smsAdminAction(pool, { action: "save_template", name: "Welcome", body: "dup" }, "admin"), /already exists/);
  const listed = await smsAdminResource(pool, new URLSearchParams({ resource: "templates" }));
  assert.ok(listed.data.some((row) => row.id === created.id && row.campaign_count === 0));
  const { campaign } = await fixture({ templateId: created.id, status: "ready" });
  await assert.rejects(smsAdminAction(pool, { action: "archive_template", id: created.id }, "admin"), /active campaign/);
  // An edit reaches every message the campaign has not claimed yet, so it is
  // blocked on the same terms as archiving and deletion.
  await assert.rejects(smsAdminAction(pool, { action: "save_template", id: created.id, name: "Welcome", body: "Rewritten {{first_name}}", version: created.version }, "admin"), /active campaign/);
  assert.equal((await pool.query(`SELECT body FROM cc_sms_templates WHERE id=$1`, [created.id])).rows[0].body, created.body, "the stored template is unchanged");
  await pool.query(`UPDATE outbound_campaigns SET status='stopped' WHERE id=$1`, [campaign.id]);
  const archived = await smsAdminAction(pool, { action: "archive_template", id: created.id }, "admin");
  assert.equal(archived.result.status, "archived");
  const updated = await smsAdminAction(pool, { action: "save_template", id: created.id, name: "Welcome", body: "Hello {{first_name}}", version: archived.result.version, status: "active" }, "admin");
  assert.deepEqual(updated.result.variables, ["first_name"]);
  await assert.rejects(smsAdminAction(pool, { action: "save_template", id: created.id, name: "Welcome", body: "x", version: 1 }, "admin"), /Refresh and retry/);
});

test("a broadcast tick claims, renders with the footer, sends through the provider and records acceptance", async () => {
  const { campaign } = await fixture();
  const provider = fakeProvider();
  const summary = await runMessagingCampaignTick(pool, provider, campaign, { webhookUrl: "https://contact.example.com/api/webhooks/telnyx/sms" });
  assert.equal(summary.claimed, 2);
  assert.equal(summary.accepted, 2);
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0].operation, "sms_send");
  assert.equal(provider.calls[0].request.from, "+15550001000");
  assert.equal(provider.calls[0].request.to, "+15550100001");
  assert.equal(provider.calls[0].request.text, "Hi Anna, your code is A1\nReply STOP to opt out");
  assert.equal(provider.calls[0].request.webhook_url, "https://contact.example.com/api/webhooks/telnyx/sms");
  const ledger = (await ledgerFor(campaign.id)).sort((a, b) => a.to_address.localeCompare(b.to_address));
  assert.deepEqual(ledger.map((row) => row.message_state), ["accepted", "accepted"]);
  assert.deepEqual(ledger.map((row) => row.status), ["dialing", "dialing"]);
  assert.deepEqual(ledger.map((row) => row.provider_message_id).sort(), ["msg-1", "msg-2"]);
  assert.equal(ledger[0].sender_address, "+15550001000");
  assert.ok(ledger[0].delivery_sync_at);
  assert.equal(ledger[0].metadata.rendered.parts, 1);
  const runtime = (await reload(campaign.id)).metadata.messaging_runtime;
  assert.ok(runtime.next_batch_at);
  // The next tick waits for the batch interval, then finds nothing left and completes the campaign.
  const waiting = await runMessagingCampaignTick(pool, provider, await reload(campaign.id), {});
  assert.equal(waiting.waiting, "batch_interval");
  await pool.query(`UPDATE outbound_campaigns SET metadata = metadata || '{"messaging_runtime":{}}' WHERE id=$1`, [campaign.id]);
  await pool.query(`UPDATE outbound_attempt_ledger SET message_state='delivered', status='completed' WHERE campaign_id=$1`, [campaign.id]);
  const done = await runMessagingCampaignTick(pool, provider, await reload(campaign.id), {});
  assert.equal(done.completed, true);
  assert.equal((await reload(campaign.id)).status, "stopped");
});

test("delivery webhooks for campaign messages fall through the SMS adapter to the ledger, and replies mark the message", async () => {
  const { campaign } = await fixture({ contacts: [{ "First Name": "Cara", Mobile: "+15550100003", code: "C3" }] });
  await runMessagingCampaignTick(pool, fakeProvider([{ outcome: "accepted", httpStatus: 200, response: { data: { id: "prov-1", parts: 1 } } }]), campaign, { webhookUrl: null });
  assert.equal(await applySmsDeliveryUpdate(pool, { providerMessageId: "prov-1", status: "sent", occurredAt: new Date().toISOString(), source: "message.sent" }), "applied");
  assert.equal(await applySmsDeliveryUpdate(pool, { providerMessageId: "prov-1", status: "delivered", occurredAt: new Date().toISOString(), source: "message.finalized" }), "applied");
  assert.equal(await applySmsDeliveryUpdate(pool, { providerMessageId: "prov-1", status: "sent", occurredAt: new Date().toISOString(), source: "late" }), "noop");
  assert.equal(await applySmsDeliveryUpdate(pool, { providerMessageId: "unknown", status: "sent", source: "x" }), "unmatched");
  let [row] = await ledgerFor(campaign.id);
  assert.equal(row.message_state, "delivered");
  assert.equal(row.status, "completed");
  assert.equal(row.delivery_sync_at, null);
  assert.equal(await markMessagingReplied(pool, { channel: "sms", address: "+15550100003" }), 1);
  [row] = await ledgerFor(campaign.id);
  assert.equal(row.message_state, "replied");
  assert.equal(await markMessagingReplied(pool, { channel: "sms", address: "+15550100003" }), 0);
});

test("suppression gates: DNC, opted-out customers, consent and test-mode allowlist never reach the provider", async () => {
  const dnc = (await pool.query(`INSERT INTO outbound_dnc_lists (name, status, match_strategy) VALUES ('Blocked','active','phone') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO outbound_dnc_entries (dnc_list_id, value_type, original_value, normalized_value) VALUES ($1,'phone','+15550100011','15550100011')`, [dnc]);
  const conversation = randomUUID();
  await pool.query(`INSERT INTO acd_conversations(id,channel,customer_name) VALUES($1,'sms','Opted')`, [conversation]);
  await pool.query(`INSERT INTO cc_sms_threads(conversation_id,number_id,customer_address,opted_out_at) VALUES($1,$2,'+15550100012',now())`, [conversation, secondNumberId]);
  const { campaign } = await fixture({
    contacts: [
      { "First Name": "Dnc", Mobile: "+15550100011", code: "1", consent: "yes" },
      { "First Name": "Stop", Mobile: "+15550100012", code: "2", consent: "yes" },
      { "First Name": "NoConsent", Mobile: "+15550100013", code: "3", consent: "no" },
      { "First Name": "NoNumber", Mobile: "", code: "4", consent: "yes" },
      { "First Name": "Ok", Mobile: "+15550100015", code: "5", consent: "yes" },
      { "First Name": "NoVar", Mobile: "+15550100016", consent: "yes" },
    ],
    config: { consent: { field: "consent", accepted_values: ["yes"] } },
  });
  await pool.query(`UPDATE outbound_campaigns SET metadata = metadata || $2::jsonb WHERE id=$1`, [campaign.id, JSON.stringify({ dnc_list_id: dnc })]);
  const provider = fakeProvider();
  const summary = await runMessagingCampaignTick(pool, provider, await reload(campaign.id), { webhookUrl: null });
  assert.equal(summary.claimed, 6);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.suppressed, 5);
  assert.deepEqual(provider.calls.map((call) => call.request.to), ["+15550100015"]);
  const reasons = Object.fromEntries((await ledgerFor(campaign.id)).map((row) => [row.to_address || row.metadata.reason_code, row.metadata.reason_code]));
  assert.equal(reasons["+15550100011"], "dnc_match");
  assert.equal(reasons["+15550100012"], "opted_out");
  assert.equal(reasons["+15550100013"], "consent_missing");
  assert.equal(reasons["+15550100016"], "missing_variables");
  assert.equal(reasons.missing_destination, "missing_destination");

  await setSettings({ messaging: { ...baseSettings.messaging, safety: { failure_rate_min_sample: 1000, test_mode: { enabled: true, allowlist: ["+1 555 010 0022"] } } } });
  const guarded = await fixture({ contacts: [{ "First Name": "Allowed", Mobile: "+15550100022", code: "x" }, { "First Name": "Blocked", Mobile: "+15550100023", code: "y" }] });
  const testProvider = fakeProvider();
  const guardedSummary = await runMessagingCampaignTick(pool, testProvider, guarded.campaign, { webhookUrl: null });
  assert.equal(guardedSummary.accepted, 1);
  assert.deepEqual(testProvider.calls.map((call) => call.request.to), ["+15550100022"]);
  assert.equal((await ledgerFor(guarded.campaign.id)).find((row) => row.to_address === "+15550100023").metadata.reason_code, "test_mode_allowlist");
});

test("provider rejections: throttling backs the campaign off, transient failures retry later, sender problems pause the campaign", async () => {
  const throttledFixture = await fixture({ contacts: [{ "First Name": "A", Mobile: "+15550100031", code: "1" }, { "First Name": "B", Mobile: "+15550100032", code: "2" }] });
  const throttled = fakeProvider([{ outcome: "ambiguous", httpStatus: 429, response: { error: "Too many requests" } }]);
  const summary = await runMessagingCampaignTick(pool, throttled, throttledFixture.campaign, { webhookUrl: null });
  assert.equal(throttled.calls.length, 1, "the batch stops sending after a 429");
  assert.equal(summary.throttled, 2);
  const rows = await ledgerFor(throttledFixture.campaign.id);
  assert.deepEqual(rows.map((row) => row.message_state), ["throttled", "throttled"]);
  assert.deepEqual(rows.map((row) => row.status), ["cancelled", "cancelled"]);
  assert.ok(rows[0].metadata.next_retry_at);
  const runtime = (await reload(throttledFixture.campaign.id)).metadata.messaging_runtime;
  assert.ok(Date.parse(runtime.throttle_until) > Date.now());
  assert.equal((await runMessagingCampaignTick(pool, throttled, await reload(throttledFixture.campaign.id), {})).waiting, "throttled");

  const transientFixture = await fixture({ contacts: [{ "First Name": "T", Mobile: "+15550100033", code: "3" }] });
  await runMessagingCampaignTick(pool, fakeProvider([{ outcome: "failed", httpStatus: 422, response: { error: "T-Mobile daily limit", code: "40016" } }]), transientFixture.campaign, { webhookUrl: null });
  const [transient] = await ledgerFor(transientFixture.campaign.id);
  assert.equal(transient.message_state, "failed_transient");
  assert.equal(transient.status, "failed");
  assert.equal(transient.metadata.retry_eligible, true);
  assert.ok(Date.parse(transient.metadata.next_retry_at) > Date.now());
  assert.equal((await claimMessagingBatch(pool, transientFixture.campaign, null, 5)).length, 0, "contacts with a scheduled retry are not reclaimed early");

  const senderFixture = await fixture({ contacts: [{ "First Name": "S", Mobile: "+15550100034", code: "4" }] });
  const paused = await runMessagingCampaignTick(pool, fakeProvider([{ outcome: "failed", httpStatus: 422, response: { error: "Unregistered 10DLC", code: "40010" } }]), senderFixture.campaign, { webhookUrl: null });
  assert.equal(paused.paused, "sender_problem");
  const pausedCampaign = await reload(senderFixture.campaign.id);
  assert.equal(pausedCampaign.status, "paused");
  assert.equal(pausedCampaign.metadata.messaging_runtime.auto_paused_reason, "sender_problem");
  assert.equal(pausedCampaign.metadata.event_timeline[0].type, "pause");

  const stopFixture = await fixture({ contacts: [{ "First Name": "X", Mobile: "+15550100035", code: "5" }] });
  await runMessagingCampaignTick(pool, fakeProvider([{ outcome: "failed", httpStatus: 422, response: { error: "STOP", code: "40300" } }]), stopFixture.campaign, { webhookUrl: null });
  const [stopped] = await ledgerFor(stopFixture.campaign.id);
  assert.equal(stopped.metadata.reason_code, "opted_out");
  const again = await fixture({ contacts: [{ "First Name": "X", Mobile: "+15550100035", code: "6" }] });
  const learned = await runMessagingCampaignTick(pool, fakeProvider(), again.campaign, { webhookUrl: null });
  assert.equal(learned.suppressed, 1, "a provider STOP rejection suppresses later campaigns to the same number");
});

test("pacing budget honours per-minute limits, in-flight caps and sender capacity across ticks", async () => {
  // Rate windows are installation-wide, so earlier tests must not count here.
  await pool.query(`DELETE FROM outbound_attempt_ledger`);
  await setSettings({ messaging: { ...baseSettings.messaging, rate: { sms: { max_per_minute: 3, max_per_hour: 100, max_per_day: 1000, per_sender_per_minute: 2, per_sender_daily: 100 } } } });
  const { campaign } = await fixture({ contacts: Array.from({ length: 5 }, (_, i) => ({ "First Name": `P${i}`, Mobile: `+1555010004${i}`, code: String(i) })), config: { sender: { sms: { number_ids: [numberId, secondNumberId], strategy: "round_robin" } } } });
  const provider = fakeProvider();
  const first = await runMessagingCampaignTick(pool, provider, campaign, { webhookUrl: null });
  assert.equal(first.budget, 3);
  assert.equal(first.accepted, 3);
  assert.deepEqual([...new Set(provider.calls.map((call) => call.request.from))].sort(), ["+15550001000", "+15550002000"], "round robin spreads sends across senders");
  await pool.query(`UPDATE outbound_campaigns SET metadata = metadata || '{"messaging_runtime":{}}' WHERE id=$1`, [campaign.id]);
  const second = await runMessagingCampaignTick(pool, provider, await reload(campaign.id), { webhookUrl: null });
  assert.equal(second.budget, 0);
  assert.equal(second.limitedBy, "max_per_minute");
  assert.equal(provider.calls.length, 3);
});

test("audience validation and previews explain what the runner would do before the campaign starts", async () => {
  const { campaign, list } = await fixture({ contacts: [
    { "First Name": "Anna", Mobile: "+15550100051", code: "A" },
    { "First Name": "Bez", Mobile: "", code: "B" },
    { "First Name": "NoCode", Mobile: "+15550100053" },
  ], status: "ready" });
  const validation = await validateMessagingAudience(pool, { campaign, outboundSettings: await setSettings() });
  assert.equal(validation.counts.total, 3);
  assert.equal(validation.counts.sendable, 1);
  assert.equal(validation.counts.missing_destination, 1);
  assert.equal(validation.counts.missing_variables, 1);
  assert.deepEqual(validation.missing_by_variable, { code: 1 });
  assert.equal(validation.problems.length, 2);
  const contact = await loadSampleContact(pool, { contactListId: list, offset: 0 });
  const preview = await previewMessagingMessage(pool, { campaign, contact, outboundSettings: await setSettings(), senderAddress: "+15550001000" });
  assert.equal(preview.ok, true);
  assert.equal(preview.text, "Hi Anna, your code is A\nReply STOP to opt out");
  assert.equal(preview.destination.address, "+15550100051");
  assert.equal(preview.segments.parts, 1);
  const noCode = await previewMessagingMessage(pool, { campaign, contact: await loadSampleContact(pool, { contactListId: list, offset: 2 }), outboundSettings: await setSettings() });
  assert.equal(noCode.ok, false);
  assert.ok(noCode.warnings.some((warning) => /No value for: code/.test(warning)));

  // Test mode suppresses everything off the allowlist at send time, so the
  // estimate has to say so instead of promising the whole list.
  const testModeSettings = await setSettings({ messaging: { ...baseSettings.messaging, safety: { ...baseSettings.messaging.safety, test_mode: { enabled: true, allowlist: ["+15550100099"] } } } });
  const gated = await validateMessagingAudience(pool, { campaign, outboundSettings: testModeSettings });
  assert.equal(gated.counts.sendable, 0);
  // Both contacts that have a number are gated; suppression runs before
  // rendering at send time, and the estimate follows the same order.
  assert.equal(gated.counts.test_mode_allowlist, 2);
  assert.equal(gated.ok, false);
  assert.ok(gated.problems.some((problem) => problem.reason === "test_mode_allowlist"));
  const gatedPreview = await previewMessagingMessage(pool, { campaign, contact, outboundSettings: testModeSettings, senderAddress: "+15550001000" });
  assert.ok(gatedPreview.warnings.some((warning) => /Test mode/.test(warning)));
  await setSettings();
});

test("test sends go out immediately without touching the audience", async () => {
  const { campaign } = await fixture({ contacts: [{ "First Name": "Anna", Mobile: "+15550100061", code: "Z" }] });
  const provider = fakeProvider();
  const result = await sendMessagingTest(pool, provider, { campaign, to: "+1 555 010 0099", contact: await loadSampleContact(pool, { contactListId: campaign.contact_list_id }) , webhookUrl: null });
  assert.equal(result.accepted, true);
  assert.equal(result.text, "Hi Anna, your code is Z\nReply STOP to opt out");
  assert.equal(provider.calls[0].request.to, "+15550100099");
  const rows = await ledgerFor(campaign.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempt_reason, "test_send");
  assert.equal(rows[0].contact_record_id, null);
  assert.equal((await claimMessagingBatch(pool, campaign, null, 5)).length, 1, "the real contact is still claimable after a test send");
});

test("worker tick runs every running messaging campaign and sweeps stale sends", async () => {
  await pool.query(`UPDATE outbound_campaigns SET status='stopped' WHERE status='running'`);
  const { campaign } = await fixture({ contacts: [{ "First Name": "W", Mobile: "+15550100071", code: "w" }] });
  await pool.query(`INSERT INTO outbound_attempt_ledger (campaign_id, status, channel, message_state, lease_expires_at, metadata) VALUES ($1,'claimed','sms','sending', now() - interval '1 minute', '{}')`, [campaign.id]);
  const swept = await sweepStalledMessagingSends(pool);
  assert.equal(swept.unconfirmed, 1);
  const results = await tickOutboundMessaging(pool, fakeProvider(), { node: "test" });
  const mine = results.find((entry) => entry.campaignId === campaign.id);
  assert.equal(mine.accepted, 1);
  await setSettings({ messaging: { ...baseSettings.messaging, enabled_channels: { sms: false } } });
  const other = await fixture({ contacts: [{ "First Name": "D", Mobile: "+15550100072", code: "d" }] });
  const disabled = await tickOutboundMessaging(pool, fakeProvider(), { node: "test" });
  assert.equal(disabled.find((entry) => entry.campaignId === other.campaign.id).paused, "channel_disabled");
  assert.equal((await reload(other.campaign.id)).status, "paused");
});

test("inbound SMS routing marks campaign messages as replied", async () => {
  const { campaign } = await fixture({ contacts: [{ "First Name": "R", Mobile: "+15550100081", code: "r" }] });
  await runMessagingCampaignTick(pool, fakeProvider([{ outcome: "accepted", httpStatus: 200, response: { data: { id: "prov-reply-1", parts: 1 } } }]), campaign, { webhookUrl: null });
  await pool.query(`INSERT INTO cc_sms_received(number_id,provider_message_id,customer_address,payload,classification) VALUES($1,'in-1','+15550100081',$2::jsonb,'customer')`,
    [numberId, JSON.stringify({ providerId: "in-1", from: "+15550100081", to: "+15550001000", text: "Yes please", type: "SMS", media: [] })]);
  assert.equal(await routePendingSms(pool), true);
  const [row] = await ledgerFor(campaign.id);
  assert.equal(row.message_state, "replied");
  assert.equal(await completeMessagingCampaignIfExhausted(pool, await reload(campaign.id)).then((r) => r.completed), true);
});

test("pausing a campaign mid-batch stops the send and releases the rows it had already claimed", async () => {
  await pool.query(`DELETE FROM outbound_attempt_ledger`);
  const contacts = Array.from({ length: 4 }, (_, index) => ({ "First Name": `P${index}`, Mobile: `+1555011000${index}`, code: `C${index}` }));
  const paused = await fixture({ contacts });
  // The supervisor pauses while the first message is with the provider.
  const provider = { calls: [], async send(command) {
    this.calls.push(command);
    if (this.calls.length === 1) await pool.query(`UPDATE outbound_campaigns SET status='paused' WHERE id=$1`, [paused.campaign.id]);
    return { outcome: "accepted", httpStatus: 200, response: { data: { id: `pause-${this.calls.length}`, parts: 1 } } };
  } };
  const summary = await runMessagingCampaignTick(pool, provider, paused.campaign, { webhookUrl: null });
  assert.equal(summary.claimed, 4);
  assert.equal(provider.calls.length, 1, "the rest of the batch is not sent after the pause");
  assert.equal(summary.stopped, "paused");
  assert.equal(summary.cancelled, 3);
  const rows = await ledgerFor(paused.campaign.id);
  assert.equal(rows.filter((row) => row.message_state === "accepted").length, 1);
  assert.equal(rows.filter((row) => row.message_state === "cancelled").length, 3, "unsent claims are released instead of left reserved");
  assert.equal(rows.filter((row) => row.metadata.reason_code === "campaign_paused").length, 3);
  // Released rows no longer hold pacing budget, and their contacts come back.
  await pool.query(`UPDATE outbound_campaigns SET status='running' WHERE id=$1`, [paused.campaign.id]);
  assert.equal((await claimMessagingBatch(pool, await reload(paused.campaign.id), null, 10)).length, 3);
});

test("the messaging attempt limit, reply attribution and the reply backlog hold each bound the runner", async () => {
  await pool.query(`DELETE FROM outbound_attempt_ledger`);
  // Dialer → Settings caps attempts below the campaign's own retry policy.
  await setSettings({ messaging: { ...baseSettings.messaging, attempts: { max_attempts_per_contact: 1 } } });
  const capped = await fixture({ contacts: [{ "First Name": "A", Mobile: "+15550100201", code: "A" }] });
  assert.equal(await messagingMaxAttempts(pool, capped.campaign), 1, "the tighter of the campaign policy and the messaging setting wins");
  await runMessagingCampaignTick(pool, fakeProvider([{ outcome: "failed", httpStatus: 422, response: { error: "gateway", code: "40018" } }]), capped.campaign, { webhookUrl: null });
  await pool.query(`UPDATE outbound_attempt_ledger SET metadata = metadata - 'next_retry_at' WHERE campaign_id=$1`, [capped.campaign.id]);
  assert.equal((await claimMessagingBatch(pool, capped.campaign, null, 5)).length, 0, "the messaging limit is enforced even though the campaign allows two attempts");
  await setSettings();

  // Only the newest message from the number that received the reply is marked.
  await pool.query(`DELETE FROM outbound_attempt_ledger`);
  const replied = await fixture({ contacts: [{ "First Name": "R", Mobile: "+15550100202", code: "R" }] });
  const rowFor = async (sender, ago) => (await pool.query(
    `INSERT INTO outbound_attempt_ledger (campaign_id, contact_record_id, status, channel, handler_type, claim_key, message_state, to_address, sender_address, created_at)
     VALUES ($1, NULL, 'dialing', 'sms', 'queue', $2, 'delivered', '+15550100202', $3, NOW() - ($4::text || ' minutes')::interval) RETURNING *`,
    [replied.campaign.id, randomUUID(), sender, String(ago)])).rows[0];
  const older = await rowFor("+15550001000", 30);
  const newer = await rowFor("+15550001000", 5);
  const otherLine = await rowFor("+15550002000", 1);
  assert.equal(await markMessagingReplied(pool, { channel: "sms", address: "+15550100202", receivedBy: "+15550001000" }), 1);
  const states = Object.fromEntries((await ledgerFor(replied.campaign.id)).map((row) => [row.id, row.message_state]));
  assert.equal(states[newer.id], "replied");
  assert.equal(states[older.id], "delivered", "an earlier message to the same contact keeps its own outcome");
  assert.equal(states[otherLine.id], "delivered", "a message sent from another number is not attributed to this reply");

  // Replies waiting in the queue hold the next batch.
  const waitingNow = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_work_items WHERE channel='sms' AND direction='inbound' AND state IN ('open','queued') AND terminal_at IS NULL`)).rows[0].n);
  const settings = messagingSettingsFrom({ messaging: { reply: { pause_when_reply_queue_waiting_over: waitingNow + 2 } } });
  assert.equal(await replyBacklogExceeded(pool, "sms", settings), null, "a backlog at or under the limit does not hold the campaign");
  const workItems = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of workItems) {
    await pool.query(`INSERT INTO acd_work_items (id, channel, direction, state, queue_id, enqueued_at) VALUES ($1,'sms','inbound','queued',$2,now())`, [id, queueId]);
  }
  assert.deepEqual(await replyBacklogExceeded(pool, "sms", settings), { waiting: waitingNow + 3, limit: waitingNow + 2 });
  const held = await fixture({ contacts: [{ "First Name": "H", Mobile: "+15550100203", code: "H" }] });
  await setSettings({ messaging: { ...baseSettings.messaging, reply: { pause_when_reply_queue_waiting_over: waitingNow + 2 } } });
  const provider = fakeProvider();
  const summary = await runMessagingCampaignTick(pool, provider, held.campaign, { webhookUrl: null });
  assert.equal(summary.waiting, "reply_backlog");
  assert.equal(provider.calls.length, 0, "nothing is sent while the inbound backlog is over the limit");
  assert.equal((await reload(held.campaign.id)).status, "running", "the campaign waits rather than being paused");
  await pool.query(`DELETE FROM acd_work_items WHERE id = ANY($1::uuid[])`, [workItems]);
});

test("delivery reconciliation polls every channel it drains and writes a message off only after the last poll", async () => {
  await pool.query(`DELETE FROM outbound_attempt_ledger`);
  const polled = await fixture({ contacts: [{ "First Name": "D", Mobile: "+15550100301", code: "D" }] });
  await runMessagingCampaignTick(pool, fakeProvider(), polled.campaign, { webhookUrl: null });
  const [accepted] = await ledgerFor(polled.campaign.id);
  assert.equal(accepted.message_state, "accepted");
  assert.ok(accepted.delivery_sync_at, "an accepted message joins the reconciliation queue");

  // Four polls return nothing; the fifth carries the delivery and must be used.
  const answers = [null, null, null, null, { data: { id: accepted.provider_message_id, to: [{ status: "delivered" }], completed_at: new Date().toISOString() } }];
  const requests = { sms: async () => answers.shift() ?? { data: { id: accepted.provider_message_id, to: [{ status: "queued" }] } } };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await pool.query(`UPDATE outbound_attempt_ledger SET delivery_sync_at = now() - interval '1 minute' WHERE id=$1 AND delivery_sync_at IS NOT NULL`, [accepted.id]);
    await syncMessagingDeliveries(pool, { requests });
  }
  const [reconciled] = await ledgerFor(polled.campaign.id);
  assert.equal(reconciled.message_state, "delivered", "the fifth poll still decides the outcome");
  assert.equal(reconciled.delivery_sync_attempts, 5);

  // A channel with no adapter must neither burn attempts nor be written off.
  await pool.query(`UPDATE outbound_attempt_ledger SET message_state='accepted', status='dialing', delivery_sync_at=now() - interval '1 minute', delivery_sync_attempts=4 WHERE id=$1`, [accepted.id]);
  await syncMessagingDeliveries(pool, { requests: {} });
  const [untouched] = await ledgerFor(polled.campaign.id);
  assert.equal(untouched.message_state, "accepted");
  assert.equal(untouched.delivery_sync_attempts, 4, "the attempt is given back when no query was made");
  assert.equal(untouched.delivery_sync_at, null, "and the row leaves a queue that cannot serve it");

  // Email delivery evidence lives on the recipients sub-resource.
  const emailPoll = await pollMessagingDelivery("email", async (path) => {
    assert.match(path, /\/email_messages\/msg-1\/recipients/);
    return { data: [{ status: "queued" }, { status: "bounced", failed_at: "2026-09-15T10:00:00Z", error_evidence: { code: "30005", message: "mailbox full" } }] };
  }, "msg-1");
  assert.deepEqual(emailPoll, { status: "bounced", occurredAt: "2026-09-15T10:00:00Z", errorCode: "30005", errorDetail: "mailbox full" });
  assert.equal(await pollMessagingDelivery("email", async () => ({ data: [{ status: "queued" }] }), "msg-2"), null);
});

test("a WhatsApp template may only be paired with a number from its own business account", () => {
  const template = { id: "t1", name: "Promo", waba_id: "waba-1" };
  assert.equal(whatsappWabaMismatch("whatsapp", template, [{ address: "+15550001000", waba_id: "waba-1" }]), null);
  assert.equal(whatsappWabaMismatch("sms", template, [{ address: "+15550001000", waba_id: "waba-9" }]), null, "only WhatsApp pairs templates with accounts");
  assert.equal(whatsappWabaMismatch("whatsapp", { id: "t2", name: "Promo" }, [{ address: "+1", waba_id: "waba-9" }]), null, "a template without an account is not checked");
  const mismatch = whatsappWabaMismatch("whatsapp", template, [{ address: "+15550009000", waba_id: "waba-9" }]);
  assert.match(String(mismatch), /waba-1/);
  assert.match(String(mismatch), /\+15550009000/);
});
