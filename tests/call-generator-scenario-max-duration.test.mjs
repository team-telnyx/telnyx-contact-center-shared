import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveRunLimits } from "../lib/call-generator/runner.mjs";
import { originateGeneratedCall } from "../lib/call-generator/engine.mjs";

// Per-scenario max call duration:
//   precedence = explicit run config → scenario.config.maxCallDurationSecs →
//   global Settings (cg_settings.max_call_duration_secs) → 120s default.
// Telnyx enforces the hangup via the Dial command's time_limit_secs, derived
// from the resolved maxDurationSecs.

process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || "test-key";

test("scenario maxCallDurationSecs overrides the global Settings value", () => {
  const limits = effectiveRunLimits(
    { max_call_duration_secs: 120 },
    {},
    { maxCallDurationSecs: 300 },
  );
  assert.equal(limits.maxDurationSecs, 300);
});

test("scenario override may exceed the global default (not just tighten it)", () => {
  const limits = effectiveRunLimits(
    { max_call_duration_secs: 90 },
    {},
    { maxCallDurationSecs: 600 },
  );
  assert.equal(limits.maxDurationSecs, 600);
});

test("falls back to the global Settings value when scenario has no override", () => {
  const limits = effectiveRunLimits(
    { max_call_duration_secs: 200 },
    {},
    {},
  );
  assert.equal(limits.maxDurationSecs, 200);
});

test("explicit run config still wins over the scenario override", () => {
  const limits = effectiveRunLimits(
    { max_call_duration_secs: 120 },
    { maxDurationSecs: 45 },
    { maxCallDurationSecs: 300 },
  );
  assert.equal(limits.maxDurationSecs, 45);
});

test("falls back to 120s default when nothing is configured", () => {
  const limits = effectiveRunLimits({}, {}, {});
  assert.equal(limits.maxDurationSecs, 120);
});

test("scenario override is clamped to the 10s–3600s bounds", () => {
  assert.equal(effectiveRunLimits({}, {}, { maxCallDurationSecs: 5 }).maxDurationSecs, 10);
  assert.equal(effectiveRunLimits({}, {}, { maxCallDurationSecs: 99999 }).maxDurationSecs, 3600);
});

test("originateGeneratedCall sends time_limit_secs to Telnyx from the resolved duration", async () => {
  let sentBody = null;
  const pool = {
    async query(sql) {
      if (/FROM cg_settings/.test(sql)) return { rows: [{ settings: { enabled: true } }] };
      if (/SELECT status FROM cg_call_ledger/.test(sql)) return { rows: [{ status: "pending" }] };
      return { rows: [] };
    },
  };
  const origFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, async json() { return { data: { call_control_id: "v3:CC", call_session_id: "sess" } }; }, async text() { return ""; } };
  };
  try {
    const result = await originateGeneratedCall(pool, {
      run: { id: "run-1", config: { postAnswer: { maxDurationSecs: 300 } } },
      ledgerRow: { id: "ledger-1" },
      task: { target_type: "call_flow", target: "flow-sub" },
      fromNumber: "+15551234567",
    });
    assert.equal(result.ok, true);
    assert.equal(sentBody.time_limit_secs, 300);
  } finally {
    global.fetch = origFetch;
  }
});

test("originateGeneratedCall omits time_limit_secs when no duration is provided", async () => {
  let sentBody = null;
  const pool = {
    async query(sql) {
      if (/FROM cg_settings/.test(sql)) return { rows: [{ settings: { enabled: true } }] };
      if (/SELECT status FROM cg_call_ledger/.test(sql)) return { rows: [{ status: "pending" }] };
      return { rows: [] };
    },
  };
  const origFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, async json() { return { data: { call_control_id: "v3:CC" } }; }, async text() { return ""; } };
  };
  try {
    await originateGeneratedCall(pool, {
      run: { id: "run-2", config: {} },
      ledgerRow: { id: "ledger-2" },
      task: { target_type: "call_flow", target: "flow-sub" },
      fromNumber: "+15551234567",
    });
    // JSON.stringify drops undefined values, so the field is absent on the wire.
    assert.equal(sentBody.time_limit_secs, undefined);
    assert.equal("time_limit_secs" in sentBody, false);
  } finally {
    global.fetch = origFetch;
  }
});
