import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { campaignSaveRequirements, campaignSaveRequirementsMessage, campaignRequiresQueueTarget } from "../lib/outbound-dialer/campaign-validation.js";
import { effectiveMessagingPacing, messagingDestinationOptions, normalizeMessagingCampaignConfig } from "../lib/outbound-dialer/messaging/campaign-config.mjs";
import { OUTBOUND_CAMPAIGN_MODES, OUTBOUND_CHANNELS, isOutboundMessagingChannel } from "../lib/outbound-dialer/schema.js";

const smsCampaign = (overrides = {}) => ({
  name: "Autumn promo", channel: "sms", mode: "broadcast", contact_list_id: "list-1",
  metadata: { messaging: { destination_fields: ["number:mobile"], sender: { sms: { number_ids: ["n1"] } }, template: { sms: { template_id: "t1" } }, variable_mapping: [{ key: "first_name", source: "contact_field", value: "Imię" }] } },
  ...overrides,
});

test("schema exposes email and broadcast for messaging campaigns", () => {
  assert.deepEqual(OUTBOUND_CHANNELS, ["voice", "sms", "whatsapp", "email"]);
  assert.ok(OUTBOUND_CAMPAIGN_MODES.includes("broadcast"));
  assert.equal(isOutboundMessagingChannel("SMS"), true);
  assert.equal(isOutboundMessagingChannel("voice"), false);
  assert.equal(campaignRequiresQueueTarget("broadcast"), false);
});

test("messaging config normalizes shapes and drops unknown values", () => {
  const config = normalizeMessagingCampaignConfig({
    destination_fields: ["number:mobile", "", "phone", "number:mobile"],
    sender: { sms: { number_ids: ["a", "a", "b"], strategy: "weird" } },
    template: { sms: { template_id: " t1 ", footer_mode: "nope" } },
    variable_mapping: [{ key: "first_name", source: "bogus", value: "Imię" }, { key: "", value: "x" }, { key: "first_name", value: "dup" }],
    missing_variable_policy: "explode",
    pacing: { max_per_minute: "20", batch_size: 9999, max_in_flight: "" },
    consent: { field: "consent", accepted_values: ["yes", "YES"] },
  });
  assert.deepEqual(config.destination_fields, ["number:mobile", "phone"]);
  assert.deepEqual(config.sender.sms, { number_ids: ["a", "b"], strategy: "round_robin" });
  assert.deepEqual(config.template.sms, { template_id: "t1", footer_mode: "inherit" });
  assert.deepEqual(config.variable_mapping, [{ key: "first_name", source: "contact_field", value: "Imię", fallback: "" }]);
  assert.equal(config.missing_variable_policy, "skip");
  assert.deepEqual(config.pacing, { max_per_minute: 20, batch_size: 500, max_in_flight: null });
  assert.deepEqual(config.consent.accepted_values, ["yes", "YES"]);
});

test("messaging save requirements replace FROM-number rules for SMS campaigns", () => {
  const complete = campaignSaveRequirements(smsCampaign(), { templateVariables: ["first_name"] });
  assert.equal(complete.canSave, true);
  assert.deepEqual(complete.missing, []);

  const empty = campaignSaveRequirements({ name: "", channel: "sms", mode: "broadcast", contact_list_id: null, metadata: {} });
  assert.deepEqual(empty.missing, ["name", "contact_list", "destination_fields", "sender", "template"]);
  assert.match(campaignSaveRequirementsMessage(empty), /Destination fields/);
  assert.match(campaignSaveRequirementsMessage(empty), /Sender/);

  const unmapped = campaignSaveRequirements(smsCampaign(), { templateVariables: ["first_name", "order_id"] });
  assert.deepEqual(unmapped.missing, ["variable_mapping"]);
  const blankPolicy = campaignSaveRequirements(smsCampaign({ metadata: { messaging: { ...smsCampaign().metadata.messaging, missing_variable_policy: "send_blank" } } }), { templateVariables: ["first_name", "order_id"] });
  assert.equal(blankPolicy.canSave, true);
});

test("messaging save requirements demand a time set when the workspace requires one without callable defaults", () => {
  const settings = { messaging: { windows: { use_callable_defaults: false, require_time_set_for: ["sms"] } } };
  assert.deepEqual(campaignSaveRequirements(smsCampaign(), { settings }).missing, ["time_set"]);
  assert.equal(campaignSaveRequirements(smsCampaign({ metadata: { ...smsCampaign().metadata, contactable_time_set_id: "ts-1" } }), { settings }).canSave, true);
});

test("campaign pacing may only tighten the workspace limits", () => {
  const settings = { messaging: { batch: { max_messages_per_batch: 40, max_in_flight_per_campaign: 100, batch_interval_seconds: 7 }, rate: { sms: { max_per_minute: 30, max_per_hour: 500, max_per_day: 2000, per_sender_per_minute: 10, per_sender_daily: 800 } } } };
  const loose = effectiveMessagingPacing(smsCampaign({ metadata: { messaging: { pacing: { max_per_minute: 200, batch_size: 90, max_in_flight: null } } } }), settings);
  assert.deepEqual(loose, { max_per_minute: 30, batch_size: 40, max_in_flight: 100, batch_interval_seconds: 7, max_per_hour: 500, max_per_day: 2000, per_sender_per_minute: 10, per_sender_daily: 800, max_messages_per_campaign: 0 });
  const tight = effectiveMessagingPacing(smsCampaign({ metadata: { messaging: { pacing: { max_per_minute: 5, batch_size: 3, max_in_flight: 2 } } } }), settings);
  assert.equal(tight.max_per_minute, 5);
  assert.equal(tight.batch_size, 3);
  assert.equal(tight.max_in_flight, 2);
});

test("destination options combine channel slots and phone-like columns", () => {
  const list = { custom_field_schema: [{ name: "Mobile", type: "phone" }, { name: "Email", type: "email" }, { name: "Imię", type: "text" }, { name: "Telefon domowy", type: "text" }],
    metadata: { csv_import_settings: { column_mappings: { Mobile: ["number:mobile"], Email: ["email:work"], WA: ["whatsapp:work"], Telefon: ["number:home"] } } } };
  assert.deepEqual(messagingDestinationOptions(list, "sms").map((o) => o.value), ["number:mobile", "number:home", "Mobile", "Telefon domowy"]);
  assert.deepEqual(messagingDestinationOptions(list, "whatsapp").map((o) => o.value), ["whatsapp:work", "number:mobile", "number:home", "Mobile", "Telefon domowy"]);
  assert.deepEqual(messagingDestinationOptions(list, "email").map((o) => o.value), ["email:work", "Email"]);
});

test("the dialer page gates test sends on the saved campaign, not the draft on screen", async () => {
  // Switching a stored voice campaign to SMS changes nothing on the server, so
  // the test send and the audience validation must stay disabled until the
  // campaign is saved. Both read the stored row and record their result on it.
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  assert.match(source, /const messagingUnsaved = isMessaging && messagingFingerprint\(draft\) !== messagingFingerprint\(campaign\)/);
  assert.match(source, /messagingFingerprint = \(source\) => \(source && isOutboundMessagingChannel\(source\.channel\)/);
  // Everything the two actions read from the stored row takes part: the name
  // behind campaign_name, the contact list, the DNC list and the audience filter.
  assert.match(source, /JSON\.stringify\(\[String\(source\.channel\)\.toLowerCase\(\), source\.name \|\| "", source\.contact_list_id \|\| null, source\.metadata\?\.dnc_list_id \|\| null, source\.metadata\?\.contact_list_filter_id \|\| source\.metadata\?\.filter_id \|\| null, messagingCampaignConfig\(source\)\]\)/);
  assert.match(source, /<MessagingCampaignPanel[^>]*unsaved=\{messagingUnsaved\}/);

  const panel = await readFile(new URL("../components/contact-center/outbound/MessagingCampaignPanel.jsx", import.meta.url), "utf8");
  assert.match(panel, /const blocked = !draft\?\.id \|\| unsaved;/);
  assert.match(panel, /data-testid="messaging-test-send"[^>]*/);
  assert.match(panel, /disabled=\{testing \|\| saving \|\| blocked\}/);
  assert.match(panel, /disabled=\{validating \|\| saving \|\| blocked\}/);
  assert.match(panel, /Save the campaign to test it/);
  assert.match(panel, /Save the campaign to validate it/);

  // The server keeps the same rule and says which control fixes it.
  const { messagingChannelRequired } = await import("../lib/outbound-dialer/messaging/api.mjs");
  assert.match(messagingChannelRequired({ channel: "voice" }), /This is a voice campaign\. Choose SMS, WhatsApp or email as the campaign channel first\./);
  for (const route of ["campaigns/[campaignId]/messaging/test-send", "campaigns/[campaignId]/messaging/validate"]) {
    const handler = await readFile(new URL(`../app/api/contact-center/outbound-dialer/${route}/route.js`, import.meta.url), "utf8");
    assert.match(handler, /jsonError\(messagingChannelRequired\(campaign\), 400\)/, route);
    assert.doesNotMatch(handler, /body\.campaign/, `${route} must not act on an unsaved draft`);
  }
});

test("the editor maps the variables an e-mail subject override adds and names test-mode suppressions", async () => {
  // Codex review of #1477: the server requires a mapping for a variable the
  // subject override introduces, so the editor has to show a row for it and the
  // page has to require it before a save; the audience summary has to name the
  // contacts the test-mode allowlist suppresses instead of "No problems found".
  const { messagingTemplateVariableKeys, subjectOverrideVariables } = await import("../lib/outbound-dialer/messaging/variables.mjs");
  const template = { channel: "email", variables: [{ key: "first_name" }] };
  const config = { template: { email: { subject_override: "{{promo_code}} for {{first_name}}" } } };
  assert.deepEqual(subjectOverrideVariables(template, config), ["promo_code"]);
  assert.deepEqual(messagingTemplateVariableKeys(template, config), ["first_name", "promo_code"]);
  assert.deepEqual(messagingTemplateVariableKeys(template), ["first_name"], "without the campaign config only the template counts");
  assert.deepEqual(messagingTemplateVariableKeys({ channel: "sms", variables: ["first_name", "code"] }, config), ["first_name", "code"], "string variables and non-email channels keep the template's list");
  const panel = await readFile(new URL("../components/contact-center/outbound/MessagingCampaignPanel.jsx", import.meta.url), "utf8");
  assert.match(panel, /const templateVariables = useMemo\(\(\) => messagingTemplateVariableKeys\(template, config\), \[template, config\]\)/);
  assert.match(panel, /\["outside the test-mode allowlist", validation\.counts\.test_mode_allowlist\]/);
  const source = await readFile(new URL("../app/(portal)/supervisor/outbound-dialer/page.jsx", import.meta.url), "utf8");
  assert.match(source, /messagingTemplateVariableKeys\(messagingTemplate, \{ template: \{ email: \{ subject_override: messagingSubjectOverride \} \} \}\)/);
  assert.match(source, /templateVariables: messagingTemplateVariables/);
});
