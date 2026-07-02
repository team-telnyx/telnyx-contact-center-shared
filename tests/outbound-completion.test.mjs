import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { completeCampaignIfExhausted, deriveFailureReasonFromHangupOutcome, loadCampaignMaxAttempts } from "../lib/outbound-dialer/completion.js";

function poolWith(results) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const next = results.shift();
      if (typeof next === "function") return next(sql, params);
      return next || { rows: [] };
    },
  };
}

test("deriveFailureReasonFromHangupOutcome persists retryable Telnyx reason", () => {
  assert.equal(deriveFailureReasonFromHangupOutcome({ reasonCode: "user_busy" }), "user_busy");
  assert.equal(deriveFailureReasonFromHangupOutcome({ reason_code: "timeout" }), "timeout");
});

test("completeCampaignIfExhausted stops running campaign when no active, future retry, or callable records remain", async () => {
  const pool = poolWith([
    { rows: [{ active: 0, future_retry: 0 }] },
    { rows: [{ settings: { global_max_attempts: 5 } }] },
    { rows: [{ remaining: 0 }] },
    { rows: [{ id: "campaign-1", status: "stopped", metadata: { execution_state: "stopped" } }] },
    { rows: [] },
  ]);
  const result = await completeCampaignIfExhausted(pool, { id: "campaign-1", status: "running", contact_list_id: "list-1", retry_policy: { maxAttempts: 3 } }, "tester");
  assert.equal(result.completed, true);
  assert.equal(result.remaining, 0);
  assert.equal(/status = 'claimed' AND COALESCE\(lease_expires_at/.test(pool.calls[0].sql), true);
  assert.equal(pool.calls.some((call) => /UPDATE outbound_campaigns/.test(call.sql) && /status = 'stopped'/.test(call.sql)), true);
  assert.equal(pool.calls.some((call) => /UPDATE outbound_campaign_runs/.test(call.sql) && /stopped_at = COALESCE\(stopped_at, NOW\(\)\)/.test(call.sql) && /stopped_by = \$2/.test(call.sql)), true);
  assert.equal(pool.calls.some((call) => /UPDATE outbound_campaign_runs/.test(call.sql) && /ended_at|ended_by/.test(call.sql)), false);
});

test("completeCampaignIfExhausted waits while retry is scheduled", async () => {
  const pool = poolWith([{ rows: [{ active: 0, future_retry: 1 }] }]);
  const result = await completeCampaignIfExhausted(pool, { id: "campaign-1", status: "running", contact_list_id: "list-1" }, "tester");
  assert.equal(result.completed, false);
  assert.equal(result.futureRetry, 1);
  assert.equal(pool.calls.length, 1);
});

test("attempt controls only cap completion when active", async () => {
  const pool = poolWith([
    { rows: [{ settings: { global_max_attempts: 5 } }] },
    { rows: [{ max_attempts_per_contact: 2 }] },
  ]);

  const result = await loadCampaignMaxAttempts(pool, {
    attempt_control_id: "attempt-control-1",
    retry_policy: { maxAttempts: 4 },
  });

  assert.equal(result.maxAttemptsPerContact, 2);
  assert.match(pool.calls[1].sql, /WHERE id = \$1 AND status = 'active'/);
});

test("attempt controls only cap outbound execution when active", async () => {
  const source = await readFile(new URL("../lib/outbound-dialer/execution.js", import.meta.url), "utf8");
  assert.match(source, /FROM outbound_attempt_controls\s+WHERE id = \$1 AND status = 'active'\s+LIMIT 1/);
  assert.doesNotMatch(source, /FROM outbound_attempt_controls\s+WHERE id = \$1 AND status <> 'archived'/);
});

test("attempt controls only cap agent campaigns when active", async () => {
  const source = await readFile(new URL("../lib/outbound-dialer/agent-campaigns.js", import.meta.url), "utf8");
  assert.match(source, /FROM outbound_attempt_controls\s+WHERE id = \$1 AND status = 'active'\s+LIMIT 1/);
  assert.doesNotMatch(source, /FROM outbound_attempt_controls\s+WHERE id = \$1 AND status <> 'archived'/);
});
