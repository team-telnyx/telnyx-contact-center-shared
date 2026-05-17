import assert from "node:assert/strict";
import test from "node:test";
import { completeCampaignIfExhausted, deriveFailureReasonFromHangupOutcome } from "../lib/outbound-dialer/completion.js";

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
  assert.equal(pool.calls.some((call) => /UPDATE outbound_campaigns/.test(call.sql) && /status = 'stopped'/.test(call.sql)), true);
});

test("completeCampaignIfExhausted waits while retry is scheduled", async () => {
  const pool = poolWith([{ rows: [{ active: 0, future_retry: 1 }] }]);
  const result = await completeCampaignIfExhausted(pool, { id: "campaign-1", status: "running", contact_list_id: "list-1" }, "tester");
  assert.equal(result.completed, false);
  assert.equal(result.futureRetry, 1);
  assert.equal(pool.calls.length, 1);
});
