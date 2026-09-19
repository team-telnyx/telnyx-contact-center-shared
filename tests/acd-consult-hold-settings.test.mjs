import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_HOLD_SETTINGS,
  DEFAULT_CONSULT_HOLD_SETTINGS,
  normalizeAgentHoldSettings,
  normalizeConsultHoldSettings,
} from "../lib/acd/consult-hold-settings.mjs";
import {
  DEFAULT_AGENT_LIFECYCLE_SETTINGS,
  agentLifecycleFromAppSettings,
  normalizeAgentLifecycleSettings,
} from "../lib/acd/agent-lifecycle-settings.mjs";

test("consult hold settings retain a valid announcement and clamp its interval", () => {
  assert.deepEqual(
    normalizeConsultHoldSettings({
      media_name: "  hold-track  ",
      announcement_enabled: true,
      announcement_text: "  Please hold.  ",
      announcement_voice: " Telnyx.Ultra.Asteria ",
      announcement_language: "en-US",
      announcement_interval_seconds: 2,
    }),
    {
      media_name: "hold-track",
      announcement_enabled: true,
      announcement_text: "Please hold.",
      announcement_voice: "Telnyx.Ultra.Asteria",
      announcement_language: "en-US",
      announcement_voice_api_key_ref: null,
      announcement_interval_seconds: 10,
    },
  );
});

test("consult hold settings apply safe defaults and honor explicit disable", () => {
  const defaults = normalizeConsultHoldSettings({});
  assert.equal(defaults.announcement_enabled, true);
  assert.equal(defaults.announcement_text, DEFAULT_CONSULT_HOLD_SETTINGS.announcement_text);
  assert.equal(defaults.announcement_voice, DEFAULT_CONSULT_HOLD_SETTINGS.announcement_voice);

  const result = normalizeConsultHoldSettings({
    announcement_enabled: false,
    announcement_text: "",
    announcement_voice: "",
    announcement_interval_seconds: 999,
  });
  assert.equal(result.announcement_enabled, false);
  assert.equal(result.announcement_interval_seconds, 300);
  assert.equal(result.announcement_text, DEFAULT_CONSULT_HOLD_SETTINGS.announcement_text);
});

test("agent hold defaults to silence and supports announcement plus music", () => {
  const defaults = normalizeAgentHoldSettings({});
  assert.equal(defaults.media_name, null);
  assert.equal(defaults.announcement_enabled, false);
  assert.equal(defaults.announcement_text, DEFAULT_AGENT_HOLD_SETTINGS.announcement_text);

  const configured = normalizeAgentHoldSettings({
    media_name: " agent-hold.wav ",
    announcement_enabled: true,
    announcement_text: " One moment please. ",
    announcement_voice: " AWS.Polly.Amy ",
    announcement_interval_seconds: 45,
  });
  assert.equal(configured.media_name, "agent-hold.wav");
  assert.equal(configured.announcement_enabled, true);
  assert.equal(configured.announcement_text, "One moment please.");
  assert.equal(configured.announcement_interval_seconds, 45);
});

test("agent lifecycle settings use safe defaults and bounded durations", () => {
  assert.deepEqual(
    agentLifecycleFromAppSettings({}),
    DEFAULT_AGENT_LIFECYCLE_SETTINGS,
  );
  assert.deepEqual(
    normalizeAgentLifecycleSettings({
      wrapup_timeout_seconds: 2,
      after_wrapup_status: "previous",
      no_answer_status: "available",
      default_answer_timeout_seconds: 999,
      max_call_duration_seconds: 999999,
    }),
    {
      wrapup_timeout_seconds: 15,
      after_wrapup_status: "previous",
      no_answer_status: "available",
      default_answer_timeout_seconds: 120,
      max_call_duration_seconds: 43200,
    },
  );
});

test("agent lifecycle settings reject unknown status policies", () => {
  const settings = normalizeAgentLifecycleSettings({
    after_wrapup_status: "made-up",
    no_answer_status: "made-up",
  });
  assert.equal(settings.after_wrapup_status, "available");
  assert.equal(settings.no_answer_status, "agent_not_answering");
});
