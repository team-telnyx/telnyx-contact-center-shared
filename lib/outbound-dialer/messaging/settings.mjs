// Browser-safe normalizer for the messaging-campaign branch of the global
// outbound settings (`outbound_settings.settings.messaging`). Campaigns may only
// tighten these values; the runner reads them on every tick.
import { OUTBOUND_MESSAGING_CHANNELS } from "../schema.js";

const int = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
const text = (value, fallback = "", max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : fallback);
const list = (value, max = 100, limit = 200) => (Array.isArray(value) ? value : []).map((item) => String(item || "").trim().slice(0, limit)).filter(Boolean).filter((item, idx, arr) => arr.indexOf(item) === idx).slice(0, max);

export const MESSAGING_SETTINGS_LIMITS = Object.freeze({
  max_messages_per_batch: [1, 500], batch_interval_seconds: [1, 300], max_in_flight_per_campaign: [1, 5000],
  max_attempts_per_contact: [1, 100], transient_retry_minutes: [1, 1440], throttled_retry_minutes: [1, 120], frequency_cap_retry_hours: [1, 168],
  auto_pause_failure_rate_percent: [1, 100], failure_rate_window_minutes: [1, 1440], failure_rate_min_sample: [1, 10000], on_429_pause_seconds: [5, 600], max_messages_per_campaign: [0, 1000000],
  attribution_hours: [1, 720], pause_when_reply_queue_waiting_over: [0, 1000],
  max_per_minute: [1, 100000], max_per_hour: [1, 1000000], max_per_day: [1, 10000000], per_sender_per_minute: [1, 100000], per_sender_daily: [1, 10000000],
  unique_recipients_24h: [1, 1000000], same_recipient_min_interval_seconds: [0, 3600], batch_api_size: [1, 1000], max_segments_per_message: [1, 10], suppression_sync_minutes: [1, 1440],
});

export const DEFAULT_MESSAGING_SETTINGS = Object.freeze({
  enabled_channels: { sms: false, whatsapp: false, email: false },
  batch: { max_messages_per_batch: 50, batch_interval_seconds: 5, max_in_flight_per_campaign: 200 },
  attempts: { max_attempts_per_contact: 2, transient_retry_minutes: 30, throttled_retry_minutes: 5, frequency_cap_retry_hours: 24 },
  safety: { auto_pause_failure_rate_percent: 20, failure_rate_window_minutes: 15, failure_rate_min_sample: 50, on_429_pause_seconds: 30, max_messages_per_campaign: 0, test_mode: { enabled: false, allowlist: [] } },
  windows: { use_callable_defaults: true, require_time_set_for: ["sms", "whatsapp"] },
  reply: { attribution_hours: 72, pause_when_reply_queue_waiting_over: 20 },
  senders: { sms_numbers: [], whatsapp_numbers: [], email_mailboxes: [] },
  rate: {
    // Telnyx: account 50 MPS SMS; long code 0.1 MPS outside the US, 10DLC per campaign, toll-free 3–20 MPS.
    sms: { max_per_minute: 60, max_per_hour: 2000, max_per_day: 10000, per_sender_per_minute: 60, per_sender_daily: 2000 },
    // Meta: 80 MPS per number, 1 message / 6 s to the same user, 250 → 2 000 → … unique recipients per rolling 24 h.
    whatsapp: { max_per_minute: 120, max_per_hour: 3000, max_per_day: 10000, per_sender_per_minute: 1200, unique_recipients_24h: 250, same_recipient_min_interval_seconds: 6 },
    // Telnyx email: Gmail/Outlook throttle 500/h, daily quota counted in recipients, batch endpoint ≤ 1 000 messages.
    email: { max_per_minute: 60, max_per_hour: 500, max_per_day: 1000, batch_api_size: 100 },
  },
  sms: { require_opt_out_footer: true, opt_out_footer_text: "Reply STOP to opt out", max_segments_per_message: 3, honor_opt_out_across_numbers: true, allow_mms: false },
  whatsapp: { allowed_template_categories: ["MARKETING", "UTILITY"], require_consent_for_marketing: true, auto_pause_on_template_pause: true },
  email: { require_unsubscribe: true, unsubscribe_group_id: "", add_list_unsubscribe_header: true, suppress_on_bounce: true, suppress_on_complaint: true, suppression_sync_minutes: 15, tracking: { opens: false, clicks: false }, default_from_name: "", default_reply_to: "" },
});

const clamp = (key, value, fallback) => int(value, fallback, ...(MESSAGING_SETTINGS_LIMITS[key] || [0, Number.MAX_SAFE_INTEGER]));

export function normalizeMessagingSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const d = DEFAULT_MESSAGING_SETTINGS;
  const enabled = source.enabled_channels || {};
  const batch = source.batch || {};
  const attempts = source.attempts || {};
  const safety = source.safety || {};
  const testMode = safety.test_mode || {};
  const windows = source.windows || {};
  const reply = source.reply || {};
  const senders = source.senders || {};
  const rate = source.rate || {};
  const sms = source.sms || {};
  const whatsapp = source.whatsapp || {};
  const email = source.email || {};
  const tracking = email.tracking || {};
  return {
    enabled_channels: Object.fromEntries(OUTBOUND_MESSAGING_CHANNELS.map((channel) => [channel, bool(enabled[channel], d.enabled_channels[channel])])),
    batch: {
      max_messages_per_batch: clamp("max_messages_per_batch", batch.max_messages_per_batch, d.batch.max_messages_per_batch),
      batch_interval_seconds: clamp("batch_interval_seconds", batch.batch_interval_seconds, d.batch.batch_interval_seconds),
      max_in_flight_per_campaign: clamp("max_in_flight_per_campaign", batch.max_in_flight_per_campaign, d.batch.max_in_flight_per_campaign),
    },
    attempts: {
      max_attempts_per_contact: clamp("max_attempts_per_contact", attempts.max_attempts_per_contact, d.attempts.max_attempts_per_contact),
      transient_retry_minutes: clamp("transient_retry_minutes", attempts.transient_retry_minutes, d.attempts.transient_retry_minutes),
      throttled_retry_minutes: clamp("throttled_retry_minutes", attempts.throttled_retry_minutes, d.attempts.throttled_retry_minutes),
      frequency_cap_retry_hours: clamp("frequency_cap_retry_hours", attempts.frequency_cap_retry_hours, d.attempts.frequency_cap_retry_hours),
    },
    safety: {
      auto_pause_failure_rate_percent: clamp("auto_pause_failure_rate_percent", safety.auto_pause_failure_rate_percent, d.safety.auto_pause_failure_rate_percent),
      failure_rate_window_minutes: clamp("failure_rate_window_minutes", safety.failure_rate_window_minutes, d.safety.failure_rate_window_minutes),
      failure_rate_min_sample: clamp("failure_rate_min_sample", safety.failure_rate_min_sample, d.safety.failure_rate_min_sample),
      on_429_pause_seconds: clamp("on_429_pause_seconds", safety.on_429_pause_seconds, d.safety.on_429_pause_seconds),
      max_messages_per_campaign: clamp("max_messages_per_campaign", safety.max_messages_per_campaign, d.safety.max_messages_per_campaign),
      test_mode: { enabled: bool(testMode.enabled, false), allowlist: list(testMode.allowlist, 100).map((entry) => entry.toLowerCase()) },
    },
    windows: {
      use_callable_defaults: bool(windows.use_callable_defaults, d.windows.use_callable_defaults),
      require_time_set_for: windows.require_time_set_for === undefined
        ? [...d.windows.require_time_set_for]
        : list(windows.require_time_set_for, 3).filter((channel) => OUTBOUND_MESSAGING_CHANNELS.includes(channel)),
    },
    reply: {
      attribution_hours: clamp("attribution_hours", reply.attribution_hours, d.reply.attribution_hours),
      pause_when_reply_queue_waiting_over: clamp("pause_when_reply_queue_waiting_over", reply.pause_when_reply_queue_waiting_over, d.reply.pause_when_reply_queue_waiting_over),
    },
    senders: {
      sms_numbers: list(senders.sms_numbers, 200),
      whatsapp_numbers: list(senders.whatsapp_numbers, 200),
      email_mailboxes: list(senders.email_mailboxes, 200),
    },
    rate: {
      sms: {
        max_per_minute: clamp("max_per_minute", rate.sms?.max_per_minute, d.rate.sms.max_per_minute),
        max_per_hour: clamp("max_per_hour", rate.sms?.max_per_hour, d.rate.sms.max_per_hour),
        max_per_day: clamp("max_per_day", rate.sms?.max_per_day, d.rate.sms.max_per_day),
        per_sender_per_minute: clamp("per_sender_per_minute", rate.sms?.per_sender_per_minute, d.rate.sms.per_sender_per_minute),
        per_sender_daily: clamp("per_sender_daily", rate.sms?.per_sender_daily, d.rate.sms.per_sender_daily),
      },
      whatsapp: {
        max_per_minute: clamp("max_per_minute", rate.whatsapp?.max_per_minute, d.rate.whatsapp.max_per_minute),
        max_per_hour: clamp("max_per_hour", rate.whatsapp?.max_per_hour, d.rate.whatsapp.max_per_hour),
        max_per_day: clamp("max_per_day", rate.whatsapp?.max_per_day, d.rate.whatsapp.max_per_day),
        per_sender_per_minute: clamp("per_sender_per_minute", rate.whatsapp?.per_sender_per_minute, d.rate.whatsapp.per_sender_per_minute),
        unique_recipients_24h: clamp("unique_recipients_24h", rate.whatsapp?.unique_recipients_24h, d.rate.whatsapp.unique_recipients_24h),
        same_recipient_min_interval_seconds: clamp("same_recipient_min_interval_seconds", rate.whatsapp?.same_recipient_min_interval_seconds, d.rate.whatsapp.same_recipient_min_interval_seconds),
      },
      email: {
        max_per_minute: clamp("max_per_minute", rate.email?.max_per_minute, d.rate.email.max_per_minute),
        max_per_hour: clamp("max_per_hour", rate.email?.max_per_hour, d.rate.email.max_per_hour),
        max_per_day: clamp("max_per_day", rate.email?.max_per_day, d.rate.email.max_per_day),
        batch_api_size: clamp("batch_api_size", rate.email?.batch_api_size, d.rate.email.batch_api_size),
      },
    },
    sms: {
      require_opt_out_footer: bool(sms.require_opt_out_footer, d.sms.require_opt_out_footer),
      opt_out_footer_text: text(sms.opt_out_footer_text, d.sms.opt_out_footer_text, 120) || d.sms.opt_out_footer_text,
      max_segments_per_message: clamp("max_segments_per_message", sms.max_segments_per_message, d.sms.max_segments_per_message),
      honor_opt_out_across_numbers: bool(sms.honor_opt_out_across_numbers, d.sms.honor_opt_out_across_numbers),
      allow_mms: bool(sms.allow_mms, d.sms.allow_mms),
    },
    whatsapp: {
      allowed_template_categories: (() => { const values = list(whatsapp.allowed_template_categories, 3).map((v) => v.toUpperCase()).filter((v) => ["MARKETING", "UTILITY", "AUTHENTICATION"].includes(v)); return values.length ? values : [...d.whatsapp.allowed_template_categories]; })(),
      require_consent_for_marketing: bool(whatsapp.require_consent_for_marketing, d.whatsapp.require_consent_for_marketing),
      auto_pause_on_template_pause: bool(whatsapp.auto_pause_on_template_pause, d.whatsapp.auto_pause_on_template_pause),
    },
    email: {
      require_unsubscribe: bool(email.require_unsubscribe, d.email.require_unsubscribe),
      unsubscribe_group_id: text(email.unsubscribe_group_id, "", 120),
      add_list_unsubscribe_header: bool(email.add_list_unsubscribe_header, d.email.add_list_unsubscribe_header),
      suppress_on_bounce: bool(email.suppress_on_bounce, d.email.suppress_on_bounce),
      suppress_on_complaint: bool(email.suppress_on_complaint, d.email.suppress_on_complaint),
      suppression_sync_minutes: clamp("suppression_sync_minutes", email.suppression_sync_minutes, d.email.suppression_sync_minutes),
      tracking: { opens: bool(tracking.opens, false), clicks: bool(tracking.clicks, false) },
      default_from_name: text(email.default_from_name, "", 120),
      default_reply_to: text(email.default_reply_to, "", 254).toLowerCase(),
    },
  };
}

// Settings row → messaging branch with defaults applied (read side).
export function messagingSettingsFrom(settings = {}) {
  return normalizeMessagingSettings(settings?.messaging || {});
}

export function messagingChannelEnabled(settings, channel) {
  return Boolean(messagingSettingsFrom(settings).enabled_channels[String(channel || "").toLowerCase()]);
}
