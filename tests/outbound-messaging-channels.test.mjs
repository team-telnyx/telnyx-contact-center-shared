import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool, seedQueue } from "./helpers/acd-test-db.mjs";
import { ensureOutboundTestSchema } from "./helpers/acd-outbound-db.mjs";
import { runMessagingCampaignTick, sendMessagingTest, applyMessagingDeliveryUpdate } from "../lib/outbound-dialer/messaging/execution.mjs";
import { describeWhatsAppTemplate, describeEmailTemplate, listMessagingTemplates, loadMessagingTemplate, renderMessagingMessage, htmlToText, extractEmailTemplateVariables } from "../lib/outbound-dialer/messaging/templates.mjs";
import { previewMessagingMessage } from "../lib/outbound-dialer/messaging/audience.mjs";

const pool = await prepareAcdTestPool("acd_core_test_outbound_messaging_channels");
after(() => pool.end());
await ensureOutboundTestSchema(pool);
process.env.APP_BASE_URL = "https://contact.example.com";
process.env.TELNYX_WEBHOOK_PUBLIC_KEY = "test-public-key";

const queueId = randomUUID();
await seedQueue(pool, queueId, [], { engineOwner: "acd_core" });
const whatsappNumberId = randomUUID(), mailboxId = randomUUID(), pausedMailboxId = randomUUID();
await pool.query(`INSERT INTO cc_whatsapp_profiles(id,name) VALUES('wa-profile','Contact Center') ON CONFLICT DO NOTHING`);
await pool.query(`INSERT INTO cc_whatsapp_numbers(id,phone_number,phone_number_id,waba_id,messaging_profile_id,name,queue_id,routing_enabled,sending_enabled,quality_rating)
  VALUES($1,'+15550009000','pn-1','waba-1','wa-profile','Campaign WhatsApp',$2,true,true,'GREEN')`, [whatsappNumberId, queueId]);
await pool.query(`INSERT INTO cc_email_mailboxes(id,provider_inbox_id,domain_id,address,name,queue_id,routing_enabled,sending_enabled)
  VALUES($1,$2,'domain-1','campaigns@cc.example.com','Campaigns',$3,true,true)`, [mailboxId, randomUUID(), queueId]);
await pool.query(`INSERT INTO cc_email_mailboxes(id,provider_inbox_id,domain_id,address,name,queue_id,routing_enabled,sending_enabled)
  VALUES($1,$2,'domain-1','paused@cc.example.com','Paused',$3,true,false)`, [pausedMailboxId, randomUUID(), queueId]);

const WHATSAPP_TEMPLATE = {
  id: "wa-template-1", name: "order_ready", language: "en", category: "MARKETING", status: "APPROVED",
  whatsapp_business_account: { id: "waba-1" },
  components: [
    { type: "HEADER", format: "TEXT", text: "Order {{1}}", example: { header_text: ["A1"] } },
    { type: "BODY", text: "Hi {{1}}, your order is ready for pickup until {{2}}.", example: { body_text: [["Anna", "18:00"]] } },
    { type: "FOOTER", text: "Reply STOP to opt out" },
  ],
};
const EMAIL_TEMPLATE = { id: "em-template-1", name: "Order ready", subject: "{{first_name}}, your order is ready", html_body: "<p>Hi {{first_name}},</p><p>Collect order {{code}}.</p><p><a href=\"https://example.com/unsubscribe\">Unsubscribe</a></p>", text_body: "" };

const settings = {
  enabled_channels: { sms: true, whatsapp: true, email: true },
  batch: { max_messages_per_batch: 10, batch_interval_seconds: 1, max_in_flight_per_campaign: 100 },
  attempts: { max_attempts_per_contact: 2, transient_retry_minutes: 30, throttled_retry_minutes: 5, frequency_cap_retry_hours: 24 },
  safety: { auto_pause_failure_rate_percent: 100, failure_rate_window_minutes: 15, failure_rate_min_sample: 500, on_429_pause_seconds: 30, max_messages_per_campaign: 0, test_mode: { enabled: false, allowlist: [] } },
  windows: { use_callable_defaults: false, require_time_set_for: [] },
  reply: { attribution_hours: 72, pause_when_reply_queue_waiting_over: 100 },
  senders: { sms_numbers: [], whatsapp_numbers: [], email_mailboxes: [] },
  rate: { sms: { max_per_minute: 60, max_per_hour: 2000, max_per_day: 10000, per_sender_per_minute: 60, per_sender_daily: 2000 },
    whatsapp: { max_per_minute: 120, max_per_hour: 3000, max_per_day: 10000, per_sender_per_minute: 1200, unique_recipients_24h: 250, same_recipient_min_interval_seconds: 0 },
    email: { max_per_minute: 60, max_per_hour: 500, max_per_day: 1000, batch_api_size: 100 } },
  sms: { require_opt_out_footer: true, opt_out_footer_text: "Reply STOP to opt out", max_segments_per_message: 3, honor_opt_out_across_numbers: true, allow_mms: false },
  whatsapp: { allowed_template_categories: ["MARKETING", "UTILITY"], require_consent_for_marketing: false, auto_pause_on_template_pause: true },
  email: { require_unsubscribe: true, unsubscribe_group_id: "", add_list_unsubscribe_header: true, suppress_on_bounce: true, suppress_on_complaint: true, suppression_sync_minutes: 15, tracking: { opens: false, clicks: false }, default_from_name: "", default_reply_to: "" },
};
const outboundSettings = { callable_days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], callable_window: { earliest: "00:00", latest: "23:59", timezone: "UTC" }, messaging: settings };

function fakeProvider(responses = []) {
  const calls = [];
  return { calls, async send(command) {
    calls.push(command);
    const next = responses.shift();
    return typeof next === "function" ? next(command) : next || { outcome: "accepted", httpStatus: 200, response: { data: { id: `msg-${calls.length}` } } };
  } };
}

async function campaignFixture({ channel, messaging, contacts }) {
  const list = (await pool.query(`INSERT INTO outbound_contact_lists (name, status, custom_field_schema, metadata) VALUES ('Audience','validated','[]','{}') RETURNING id`)).rows[0].id;
  for (const contact of contacts) {
    await pool.query(`INSERT INTO outbound_contact_records (contact_list_id, row_data, contact_methods, validation_status) VALUES ($1,$2,$3,'valid')`,
      [list, JSON.stringify(contact.row), JSON.stringify(contact.methods)]);
  }
  const campaign = (await pool.query(`INSERT INTO outbound_campaigns (name, status, mode, channel, handler_type, contact_list_id, retry_policy, metadata)
    VALUES ($1,'running','broadcast',$2,'queue',$3,'{"maxAttempts":2}',$4) RETURNING *`,
  [`${channel} campaign`, channel, list, JSON.stringify({ messaging })])).rows[0];
  return { list, campaign };
}
const ledgerFor = async (campaignId) => (await pool.query(`SELECT * FROM outbound_attempt_ledger WHERE campaign_id=$1 ORDER BY created_at, id`, [campaignId])).rows;

test("WhatsApp template descriptors expose positional variables and the approval gate", () => {
  const template = describeWhatsAppTemplate(WHATSAPP_TEMPLATE);
  assert.equal(template.channel, "whatsapp");
  assert.equal(template.waba_id, "waba-1");
  assert.equal(template.approved, true);
  assert.deepEqual(template.variables.map((variable) => variable.key), ["header:1", "body:1", "body:2"]);
  assert.match(template.body, /Hi \{\{1\}\}, your order is ready/);
  assert.deepEqual(template.sample_values, { "header:1": "A1", "body:1": "Anna", "body:2": "18:00" });
  const pending = describeWhatsAppTemplate({ ...WHATSAPP_TEMPLATE, status: "PENDING" });
  assert.equal(pending.approved, false);
  const rendered = renderMessagingMessage({ channel: "whatsapp", template: pending, values: { "header:1": "A1", "body:1": "Anna", "body:2": "18:00" }, settings });
  assert.equal(rendered.ok, false);
  assert.equal(rendered.reason, "template_not_approved");
});

test("a WhatsApp campaign sends an approved template with runtime components", async () => {
  const messaging = {
    destination_fields: ["whatsapp:mobile"],
    sender: { whatsapp: { number_id: whatsappNumberId, waba_id: "waba-1" } },
    template: { whatsapp: { template_id: WHATSAPP_TEMPLATE.id, name: "order_ready", language: "en" } },
    variable_mapping: [
      { key: "header:1", source: "contact_field", value: "code" },
      { key: "body:1", source: "contact_field", value: "First Name" },
      { key: "body:2", source: "static", value: "18:00" },
    ],
    missing_variable_policy: "skip",
  };
  const fixture = await campaignFixture({ channel: "whatsapp", messaging,
    contacts: [{ row: { "First Name": "Anna", code: "A1" }, methods: { whatsapp: { mobile: "+15550100001" }, number: {}, email: {} } }] });
  const provider = fakeProvider();
  const summary = await runMessagingCampaignTick(pool, provider, fixture.campaign, { settings, outboundSettings, webhookUrl: "https://contact.example.com/api/webhooks/telnyx/whatsapp",
    templateRequest: async () => ({ data: WHATSAPP_TEMPLATE }) });
  assert.equal(summary.accepted, 1, JSON.stringify(summary));
  const [command] = provider.calls;
  assert.equal(command.operation, "whatsapp_send");
  assert.equal(command.endpoint, "/messages/whatsapp");
  assert.equal(command.request.from, "+15550009000");
  assert.equal(command.request.to, "+15550100001");
  assert.equal(command.request.type, "WHATSAPP");
  assert.equal(command.request.messaging_profile_id, "wa-profile");
  assert.equal(command.request.webhook_url, "https://contact.example.com/api/webhooks/telnyx/whatsapp");
  assert.equal(command.request.whatsapp_message.type, "template");
  assert.equal(command.request.whatsapp_message.template.template_id, "wa-template-1");
  assert.deepEqual(command.request.whatsapp_message.template.components, [
    { type: "header", parameters: [{ type: "text", text: "A1" }] },
    { type: "body", parameters: [{ type: "text", text: "Anna" }, { type: "text", text: "18:00" }] },
  ]);
  const [row] = await ledgerFor(fixture.campaign.id);
  assert.equal(row.message_state, "accepted");
  assert.equal(row.channel, "whatsapp");
  assert.equal(row.metadata.rendered.text, "Order A1\nHi Anna, your order is ready for pickup until 18:00.\nReply STOP to opt out");
  // Delivery evidence from the WhatsApp webhook reaches the campaign ledger.
  assert.equal(await applyMessagingDeliveryUpdate(pool, { channel: "whatsapp", providerMessageId: row.provider_message_id, status: "delivered" }), "applied");
  assert.equal((await ledgerFor(fixture.campaign.id))[0].message_state, "delivered");
});

test("a WhatsApp campaign refuses a template category the workspace disallows", async () => {
  const utilityOnly = { ...settings, whatsapp: { ...settings.whatsapp, allowed_template_categories: ["UTILITY"] } };
  const rendered = renderMessagingMessage({ channel: "whatsapp", template: describeWhatsAppTemplate(WHATSAPP_TEMPLATE), values: { "header:1": "A1", "body:1": "Anna", "body:2": "18:00" }, settings: utilityOnly });
  assert.equal(rendered.ok, false);
  assert.equal(rendered.reason, "template_category_not_allowed");
});

test("email template descriptors extract named variables and refuse Liquid logic", () => {
  const template = describeEmailTemplate(EMAIL_TEMPLATE);
  assert.deepEqual(template.variables.map((variable) => variable.key), ["first_name", "code"]);
  assert.equal(template.body, "Hi {{first_name}},\n\nCollect order {{code}}.\n\nUnsubscribe");
  assert.equal(describeEmailTemplate({ ...EMAIL_TEMPLATE, text_body: "Plain {{first_name}}" }).body, "Plain {{first_name}}");
  assert.deepEqual(extractEmailTemplateVariables("{{ a }} {{b}} {{a}}"), ["a", "b"]);
  assert.equal(htmlToText("<p>One</p><ul><li>Two</li></ul>"), "One\n\n- Two");
  const liquid = describeEmailTemplate({ ...EMAIL_TEMPLATE, html_body: "{% if vip %}<p>Hi</p>{% endif %}" });
  assert.equal(liquid.uses_liquid_logic, true);
  const rendered = renderMessagingMessage({ channel: "email", template: liquid, values: { first_name: "Anna", code: "A1" }, settings });
  assert.equal(rendered.ok, false);
  assert.equal(rendered.reason, "template_uses_liquid_logic");
});

test("email rendering enforces the workspace unsubscribe policy", () => {
  const withoutLink = describeEmailTemplate({ ...EMAIL_TEMPLATE, html_body: "<p>Hi {{first_name}}</p>", text_body: "Hi {{first_name}}" });
  const required = renderMessagingMessage({ channel: "email", template: withoutLink, values: { first_name: "Anna" }, settings });
  assert.equal(required.ok, false);
  assert.equal(required.reason, "unsubscribe_required");
  const grouped = renderMessagingMessage({ channel: "email", template: withoutLink, values: { first_name: "Anna" }, settings: { ...settings, email: { ...settings.email, unsubscribe_group_id: "group-1" } } });
  assert.equal(grouped.ok, true);
  assert.equal(grouped.unsubscribe_group_id, "group-1");
  const optional = renderMessagingMessage({ channel: "email", template: withoutLink, values: { first_name: "Anna" }, settings: { ...settings, email: { ...settings.email, require_unsubscribe: false } } });
  assert.equal(optional.ok, true);
  const mapped = renderMessagingMessage({ channel: "email", template: describeEmailTemplate({ ...EMAIL_TEMPLATE, html_body: "<p>Hi {{first_name}}</p><a href=\"{{unsubscribe_url}}\">Stop</a>", text_body: "" }),
    values: { first_name: "Anna", unsubscribe_url: "https://example.com/u/anna" }, settings });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.headers["List-Unsubscribe"], "<https://example.com/u/anna>");
  assert.equal(mapped.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("an email campaign sends the rendered subject and bodies from the configured mailbox", async () => {
  const messaging = {
    destination_fields: ["email:primary"],
    sender: { email: { mailbox_id: mailboxId, from_name: "Telnyx Store", reply_to: "replies@cc.example.com" } },
    template: { email: { template_id: EMAIL_TEMPLATE.id, subject_override: "Pick up {{code}} today" } },
    variable_mapping: [{ key: "first_name", source: "contact_field", value: "First Name" }, { key: "code", source: "contact_field", value: "code" }],
    missing_variable_policy: "skip",
  };
  const fixture = await campaignFixture({ channel: "email", messaging,
    contacts: [{ row: { "First Name": "Anna", code: "A1" }, methods: { email: { primary: "anna@example.com" }, number: {}, whatsapp: {} } }] });
  const provider = fakeProvider();
  const summary = await runMessagingCampaignTick(pool, provider, fixture.campaign, { settings, outboundSettings, webhookUrl: null, templateRequest: async () => ({ data: EMAIL_TEMPLATE }) });
  assert.equal(summary.accepted, 1, JSON.stringify(summary));
  const [command] = provider.calls;
  assert.equal(command.operation, "email_send");
  assert.equal(command.endpoint, "/email_messages");
  assert.equal(command.request.from, "Telnyx Store <campaigns@cc.example.com>");
  assert.deepEqual(command.request.to, ["anna@example.com"]);
  assert.equal(command.request.subject, "Pick up A1 today");
  assert.match(command.request.html_body, /Collect order A1/);
  assert.match(command.request.text_body, /Collect order A1/);
  assert.equal(command.request.reply_to, "replies@cc.example.com");
  const [row] = await ledgerFor(fixture.campaign.id);
  assert.equal(row.message_state, "accepted");
  assert.equal(row.metadata.rendered.subject, "Pick up A1 today");
  // A bounce recorded against the campaign message fails that contact.
  assert.equal(await applyMessagingDeliveryUpdate(pool, { channel: "email", providerMessageId: row.provider_message_id, status: "bounced", errorCode: "30003" }), "applied");
  assert.equal((await ledgerFor(fixture.campaign.id))[0].message_state, "failed_permanent");
});

test("a paused mailbox and an allowlist keep a campaign from sending", async () => {
  const messaging = {
    destination_fields: ["email:primary"],
    sender: { email: { mailbox_id: pausedMailboxId } },
    template: { email: { template_id: EMAIL_TEMPLATE.id } },
    variable_mapping: [{ key: "first_name", source: "contact_field", value: "First Name" }, { key: "code", source: "contact_field", value: "code" }],
    missing_variable_policy: "send_blank",
  };
  const fixture = await campaignFixture({ channel: "email", messaging,
    contacts: [{ row: { "First Name": "Bob", code: "B2" }, methods: { email: { primary: "bob@example.com" }, number: {}, whatsapp: {} } }] });
  const provider = fakeProvider();
  const summary = await runMessagingCampaignTick(pool, provider, fixture.campaign, { settings, outboundSettings, templateRequest: async () => ({ data: EMAIL_TEMPLATE }) });
  assert.equal(provider.calls.length, 0);
  assert.equal(summary.paused, "missing_sender", "a mailbox that stopped allowing sending pauses the campaign before any claim");
  assert.equal((await pool.query("SELECT status FROM outbound_campaigns WHERE id=$1", [fixture.campaign.id])).rows[0].status, "paused");
  // The same guard applies to a mailbox the workspace allowlist excludes.
  await pool.query("UPDATE cc_sms_numbers SET sending_enabled=sending_enabled");
  const allowlisted = { ...settings, senders: { ...settings.senders, email_mailboxes: ["someone-else@cc.example.com"] } };
  const second = await campaignFixture({ channel: "email", messaging: { ...messaging, sender: { email: { mailbox_id: mailboxId } } },
    contacts: [{ row: { "First Name": "Cara", code: "C3" }, methods: { email: { primary: "cara@example.com" }, number: {}, whatsapp: {} } }] });
  const blocked = await runMessagingCampaignTick(pool, fakeProvider(), second.campaign, { settings: allowlisted, outboundSettings, templateRequest: async () => ({ data: EMAIL_TEMPLATE }) });
  assert.equal(blocked.paused, "missing_sender");
});

test("provider-hosted template catalogues are listed through the channel adapters", async () => {
  const whatsappRequests = [], emailRequests = [];
  const whatsapp = await listMessagingTemplates(pool, "whatsapp", { request: async (path) => { whatsappRequests.push(path); return { data: [WHATSAPP_TEMPLATE, { ...WHATSAPP_TEMPLATE, id: "wa-2", name: "draft_one", status: "PENDING" }] }; } });
  assert.match(whatsappRequests[0], /^\/whatsapp\/message_templates\?/);
  assert.deepEqual(whatsapp.map((template) => template.id), ["wa-template-1"], "only approved templates can start a campaign");
  const email = await listMessagingTemplates(pool, "email", { request: async (path) => { emailRequests.push(path); return { data: [EMAIL_TEMPLATE] }; } });
  assert.match(emailRequests[0], /^\/email_templates\?/);
  assert.deepEqual(email.map((template) => template.id), ["em-template-1"]);
  const loaded = await loadMessagingTemplate(pool, "email", "em-template-1", { request: async () => ({ data: EMAIL_TEMPLATE }) });
  assert.equal(loaded.subject, EMAIL_TEMPLATE.subject);
});
