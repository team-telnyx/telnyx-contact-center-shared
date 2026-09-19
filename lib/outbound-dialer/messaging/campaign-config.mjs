// Browser-safe messaging campaign configuration (`campaign.metadata.messaging`):
// normalization, per-channel save requirements and destination-field helpers.
import { OUTBOUND_MESSAGING_CHANNELS, isOutboundMessagingChannel } from "../schema.js";
import { MISSING_VARIABLE_POLICIES, normalizeVariableMapping } from "./variables.mjs";
import { messagingSettingsFrom } from "./settings.mjs";

export const SMS_SENDER_STRATEGIES = Object.freeze(["round_robin", "sticky_hash", "rotate_on_retry"]);
export const DESTINATION_PREFIXES = Object.freeze({ sms: ["number:"], whatsapp: ["whatsapp:", "number:"], email: ["email:"] });
export const DESTINATION_GROUPS = Object.freeze({ sms: ["number"], whatsapp: ["whatsapp", "number"], email: ["email"] });

const text = (value, max = 200) => String(value ?? "").trim().slice(0, max);
const list = (value, max = 50) => (Array.isArray(value) ? value : []).map((item) => text(item, 200)).filter(Boolean).filter((item, idx, arr) => arr.indexOf(item) === idx).slice(0, max);
const optionalInt = (value, [min, max]) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, parsed));
};
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

export function emptyMessagingCampaignConfig() {
  return {
    destination_fields: [],
    sender: { sms: { number_ids: [], strategy: "round_robin" }, whatsapp: { number_id: "", waba_id: "" }, email: { mailbox_id: "", from_name: "", reply_to: "" } },
    template: { sms: { template_id: "", footer_mode: "inherit" }, whatsapp: { template_id: "", name: "", language: "", header_media: null }, email: { template_id: "", subject_override: "", attachments: [] } },
    variable_mapping: [],
    missing_variable_policy: "skip",
    consent: { field: "", accepted_values: [] },
    pacing: { max_per_minute: null, batch_size: null, max_in_flight: null },
    reply: { attribution_hours: null, stop_contact_on_reply: true },
    test: { allowlist_only: false },
  };
}

export function normalizeMessagingCampaignConfig(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const base = emptyMessagingCampaignConfig();
  const sender = source.sender || {};
  const template = source.template || {};
  const headerMedia = template.whatsapp?.header_media && typeof template.whatsapp.header_media === "object" ? template.whatsapp.header_media : null;
  return {
    destination_fields: list(source.destination_fields, 10),
    sender: {
      sms: { number_ids: list(sender.sms?.number_ids, 20), strategy: SMS_SENDER_STRATEGIES.includes(sender.sms?.strategy) ? sender.sms.strategy : "round_robin" },
      whatsapp: { number_id: text(sender.whatsapp?.number_id, 80), waba_id: text(sender.whatsapp?.waba_id, 80) },
      email: { mailbox_id: text(sender.email?.mailbox_id, 80), from_name: text(sender.email?.from_name, 120), reply_to: text(sender.email?.reply_to, 254).toLowerCase() },
    },
    template: {
      sms: { template_id: text(template.sms?.template_id, 80), footer_mode: ["inherit", "none"].includes(template.sms?.footer_mode) ? template.sms.footer_mode : "inherit" },
      whatsapp: { template_id: text(template.whatsapp?.template_id, 120), name: text(template.whatsapp?.name, 512), language: text(template.whatsapp?.language, 12), header_media: headerMedia ? { type: text(headerMedia.type, 20).toLowerCase(), media_id: text(headerMedia.media_id, 120), url: text(headerMedia.url, 2000), filename: text(headerMedia.filename, 200) } : null },
      email: { template_id: text(template.email?.template_id, 80), subject_override: text(template.email?.subject_override, 998), attachments: list(template.email?.attachments, 20) },
    },
    variable_mapping: normalizeVariableMapping(source.variable_mapping),
    missing_variable_policy: MISSING_VARIABLE_POLICIES.includes(source.missing_variable_policy) ? source.missing_variable_policy : base.missing_variable_policy,
    consent: { field: text(source.consent?.field, 200), accepted_values: list(source.consent?.accepted_values, 20) },
    pacing: {
      max_per_minute: optionalInt(source.pacing?.max_per_minute, [1, 100000]),
      batch_size: optionalInt(source.pacing?.batch_size, [1, 500]),
      max_in_flight: optionalInt(source.pacing?.max_in_flight, [1, 5000]),
    },
    reply: { attribution_hours: optionalInt(source.reply?.attribution_hours, [1, 720]), stop_contact_on_reply: bool(source.reply?.stop_contact_on_reply, true) },
    test: { allowlist_only: bool(source.test?.allowlist_only, false) },
  };
}

export function messagingCampaignConfig(campaign = {}) {
  return normalizeMessagingCampaignConfig(campaign?.metadata?.messaging || {});
}

export function isMessagingCampaign(campaign = {}) {
  return isOutboundMessagingChannel(campaign?.channel);
}

// Effective per-campaign pacing: campaign values may only tighten the global ones.
export function effectiveMessagingPacing(campaign = {}, settings = {}) {
  const global = messagingSettingsFrom(settings);
  const channel = String(campaign?.channel || "sms").toLowerCase();
  const config = messagingCampaignConfig(campaign);
  const rate = global.rate[channel] || global.rate.sms;
  const clampTo = (value, ceiling) => (value == null ? ceiling : Math.min(value, ceiling));
  return {
    max_per_minute: clampTo(config.pacing.max_per_minute, rate.max_per_minute),
    batch_size: clampTo(config.pacing.batch_size, global.batch.max_messages_per_batch),
    max_in_flight: clampTo(config.pacing.max_in_flight, global.batch.max_in_flight_per_campaign),
    batch_interval_seconds: global.batch.batch_interval_seconds,
    max_per_hour: rate.max_per_hour,
    max_per_day: rate.max_per_day,
    per_sender_per_minute: rate.per_sender_per_minute ?? null,
    per_sender_daily: rate.per_sender_daily ?? null,
    max_messages_per_campaign: global.safety.max_messages_per_campaign,
  };
}

// Contact-list columns and contact-method slots that can address a channel.
export function messagingDestinationOptions(list = {}, channel = "sms") {
  const groups = DESTINATION_GROUPS[channel] || [];
  const importSettings = list?.metadata?.csv_import_settings || list?.metadata?.csvImportSettings || {};
  const mappings = importSettings.column_mappings || importSettings.columnMappings || {};
  const slots = [];
  for (const values of Object.values(mappings)) {
    for (const mapping of Array.isArray(values) ? values : []) {
      const [group] = String(mapping || "").split(":");
      if (groups.includes(group) && !slots.includes(mapping)) slots.push(mapping);
    }
  }
  const pattern = channel === "email" ? /mail/i : /phone|mobile|number|msisdn|tel|whatsapp/i;
  const typeMatch = channel === "email" ? ["email"] : ["phone"];
  const fields = (Array.isArray(list?.custom_field_schema) ? list.custom_field_schema : [])
    .filter((field) => typeMatch.includes(field?.type) || pattern.test(String(field?.name || "")))
    .map((field) => field.name).filter(Boolean);
  const order = { whatsapp: 0, number: 1, email: 0 };
  slots.sort((a, b) => (order[a.split(":")[0]] ?? 9) - (order[b.split(":")[0]] ?? 9) || (a.endsWith(":mobile") ? -1 : 0));
  return [...new Set([...slots, ...fields])].map((value) => ({ value, label: value.includes(":") ? `${value.split(":")[0]} · ${value.split(":")[1]}` : value, kind: value.includes(":") ? "contact_method" : "contact_field" }));
}

export function messagingCampaignSaveRequirements(campaign = {}, { settings = {}, templateVariables = null } = {}) {
  const channel = String(campaign?.channel || "").toLowerCase();
  const config = messagingCampaignConfig(campaign);
  const global = messagingSettingsFrom(settings);
  const missing = [];
  if (!text(campaign?.name)) missing.push("name");
  if (!text(campaign?.contact_list_id)) missing.push("contact_list");
  if (!config.destination_fields.length) missing.push("destination_fields");
  if (channel === "sms") {
    if (!config.sender.sms.number_ids.length) missing.push("sender");
    if (!config.template.sms.template_id) missing.push("template");
  } else if (channel === "whatsapp") {
    if (!config.sender.whatsapp.number_id) missing.push("sender");
    if (!config.template.whatsapp.template_id) missing.push("template");
  } else if (channel === "email") {
    if (!config.sender.email.mailbox_id) missing.push("sender");
    if (!config.template.email.template_id) missing.push("template");
  } else missing.push("channel");
  if (Array.isArray(templateVariables)) {
    const mapped = new Set(config.variable_mapping.filter((row) => row.value || row.fallback).map((row) => row.key));
    const unmapped = templateVariables.filter((key) => !mapped.has(key));
    if (unmapped.length && config.missing_variable_policy !== "send_blank") missing.push("variable_mapping");
  }
  if (global.windows.require_time_set_for.includes(channel) && !(campaign?.metadata?.contactable_time_set_id || campaign?.metadata?.time_set_id) && !global.windows.use_callable_defaults) missing.push("time_set");
  return { canSave: missing.length === 0, missing, channel, config };
}

export const MESSAGING_REQUIREMENT_LABELS = Object.freeze({
  name: "Campaign Name", contact_list: "Contact List", destination_fields: "Destination fields", sender: "Sender", template: "Template",
  variable_mapping: "Variable mapping", time_set: "Contactable Time Set", channel: "Channel",
});

export { OUTBOUND_MESSAGING_CHANNELS };
