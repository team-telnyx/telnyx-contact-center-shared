import test from "node:test";
import assert from "node:assert/strict";
import {
  campaignAnsweredWithoutAgentOverride,
  normalizeGlobalAnsweredWithoutAgentPolicy,
  normalizedCampaignPacingConfig,
  resolveAnsweredWithoutAgentPolicy,
  validateCampaignAnsweredWithoutAgentPolicy,
} from "../lib/outbound-dialer/answered-without-agent-policy.mjs";

test("global answered-without-agent settings normalize stored values and legacy threshold", () => {
  const defaults = normalizeGlobalAnsweredWithoutAgentPolicy({});
  assert.equal(defaults.max_agent_connect_seconds, 2);
  assert.equal(defaults.max_abandon_rate_percent, 3);
  assert.equal(defaults.retry_suppression_hours, 72);
  assert.equal(defaults.mode, "announce_and_hangup");

  const legacy = normalizeGlobalAnsweredWithoutAgentPolicy({ compliance_abandon_threshold_seconds: 1.5 });
  assert.equal(legacy.max_agent_connect_seconds, 1.5);

  const configured = normalizeGlobalAnsweredWithoutAgentPolicy({
    answered_without_agent_policy: {
      max_agent_connect_seconds: 1,
      max_abandon_rate_percent: 2,
      retry_suppression_hours: 96,
      announcement_message: "Please wait no longer.",
    },
  });
  assert.equal(configured.max_agent_connect_seconds, 1);
  assert.equal(configured.max_abandon_rate_percent, 2);
  assert.equal(configured.retry_suppression_hours, 96);
  assert.equal(configured.announcement_message, "Please wait no longer.");
});

test("campaign policy accepts equal or stricter limits", () => {
  const global = { answered_without_agent_policy: {
    max_agent_connect_seconds: 2,
    max_abandon_rate_percent: 3,
    retry_suppression_hours: 72,
  } };
  const pacing = { ratio: 2, answered_without_agent_policy: {
    max_agent_connect_seconds: 1,
    max_abandon_rate_percent: 2,
    retry_suppression_hours: 96,
  } };
  assert.deepEqual(validateCampaignAnsweredWithoutAgentPolicy(pacing, global), {
    max_agent_connect_seconds: 1,
    max_abandon_rate_percent: 2,
    retry_suppression_hours: 96,
  });
  assert.deepEqual(campaignAnsweredWithoutAgentOverride(normalizedCampaignPacingConfig(pacing, global)), {
    max_agent_connect_seconds: 1,
    max_abandon_rate_percent: 2,
    retry_suppression_hours: 96,
  });
});

test("campaign policy rejects every weaker direction", () => {
  const global = { answered_without_agent_policy: {
    max_agent_connect_seconds: 2,
    max_abandon_rate_percent: 3,
    retry_suppression_hours: 72,
  } };
  for (const local of [
    { max_agent_connect_seconds: 2.1 },
    { max_abandon_rate_percent: 3.1 },
    { retry_suppression_hours: 71 },
  ]) {
    assert.throws(
      () => validateCampaignAnsweredWithoutAgentPolicy({ answered_without_agent_policy: local }, global),
      (error) => error.code === "OUTBOUND_POLICY_WEAKER_THAN_GLOBAL",
    );
  }
});

test("runtime resolution clamps historical and stale campaign values to the global ceiling", () => {
  const global = { answered_without_agent_policy: {
    max_agent_connect_seconds: 2,
    max_abandon_rate_percent: 3,
    retry_suppression_hours: 72,
  } };
  const stale = resolveAnsweredWithoutAgentPolicy(global, { pacing_config: {
    abandonTimeoutSecs: 15,
    answered_without_agent_policy: {
      max_agent_connect_seconds: 20,
      max_abandon_rate_percent: 10,
      retry_suppression_hours: 1,
    },
  } });
  assert.equal(stale.max_agent_connect_seconds, 2);
  assert.equal(stale.max_abandon_rate_percent, 3);
  assert.equal(stale.retry_suppression_hours, 72);

  const strict = resolveAnsweredWithoutAgentPolicy(global, { pacing_config: {
    abandonTimeoutSecs: 1,
    answered_without_agent_policy: {
      max_abandon_rate_percent: 1,
      retry_suppression_hours: 120,
    },
  } });
  assert.equal(strict.max_agent_connect_seconds, 1);
  assert.equal(strict.max_abandon_rate_percent, 1);
  assert.equal(strict.retry_suppression_hours, 120);
});
