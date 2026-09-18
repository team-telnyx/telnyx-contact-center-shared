import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MESSAGING_SETTINGS, messagingChannelEnabled, messagingSettingsFrom, normalizeMessagingSettings } from "../lib/outbound-dialer/messaging/settings.mjs";

test("messaging settings default to every channel disabled with documented limits", () => {
  const settings = normalizeMessagingSettings({});
  assert.deepEqual(settings.enabled_channels, { sms: false, whatsapp: false, email: false });
  assert.equal(settings.batch.max_messages_per_batch, 50);
  assert.equal(settings.rate.email.batch_api_size, 100);
  assert.equal(settings.rate.whatsapp.same_recipient_min_interval_seconds, 6);
  assert.equal(settings.sms.opt_out_footer_text, DEFAULT_MESSAGING_SETTINGS.sms.opt_out_footer_text);
  assert.deepEqual(settings.windows.require_time_set_for, ["sms", "whatsapp"]);
});

test("messaging settings clamp numbers to their ranges and keep the email batch hard limit", () => {
  const settings = normalizeMessagingSettings({
    batch: { max_messages_per_batch: 5000, batch_interval_seconds: 0, max_in_flight_per_campaign: "abc" },
    rate: { email: { batch_api_size: 5000 }, sms: { per_sender_per_minute: -5 } },
    safety: { max_messages_per_campaign: -1, test_mode: { enabled: true, allowlist: ["+48 600 000 001", "Demo@Example.com", "", "+48600000001"] } },
    sms: { max_segments_per_message: 99, opt_out_footer_text: "" },
    windows: { require_time_set_for: ["sms", "fax"] },
  });
  assert.equal(settings.batch.max_messages_per_batch, 500);
  assert.equal(settings.batch.batch_interval_seconds, 1);
  assert.equal(settings.batch.max_in_flight_per_campaign, 200);
  assert.equal(settings.rate.email.batch_api_size, 1000);
  assert.equal(settings.rate.sms.per_sender_per_minute, 1);
  assert.equal(settings.safety.max_messages_per_campaign, 0);
  assert.deepEqual(settings.safety.test_mode.allowlist, ["+48 600 000 001", "demo@example.com", "+48600000001"]);
  assert.equal(settings.sms.max_segments_per_message, 10);
  assert.equal(settings.sms.opt_out_footer_text, "Reply STOP to opt out");
  assert.deepEqual(settings.windows.require_time_set_for, ["sms"]);
});

test("messaging settings read back from the outbound settings row", () => {
  const row = { max_lines: 10, messaging: { enabled_channels: { sms: true }, whatsapp: { allowed_template_categories: ["utility", "bogus"] } } };
  const settings = messagingSettingsFrom(row);
  assert.equal(settings.enabled_channels.sms, true);
  assert.equal(settings.enabled_channels.whatsapp, false);
  assert.deepEqual(settings.whatsapp.allowed_template_categories, ["UTILITY"]);
  assert.equal(messagingChannelEnabled(row, "sms"), true);
  assert.equal(messagingChannelEnabled(row, "email"), false);
  assert.equal(messagingChannelEnabled({}, "sms"), false);
});
