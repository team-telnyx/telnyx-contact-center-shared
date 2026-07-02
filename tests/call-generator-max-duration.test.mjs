import assert from "node:assert/strict";
import { test } from "node:test";
import { runPostAnswerActions } from "../lib/call-generator/engine.mjs";

// Regression: the generated-call hangup guard must honour the configured max
// call duration. Precedence: explicit run config → per-scenario override
// (cg_scenarios.config.maxCallDurationSecs) → global Settings
// (cg_settings.max_call_duration_secs) → 120s default.
//
// cg_runs.config is persisted empty ({}), so the guard must read the scenario
// override from the joined scenario config. Previously it fell back to the
// global Settings value, cutting a 360s scenario at 120s even though Telnyx
// received the correct time_limit_secs:360 on the Dial.

process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || "test-key";

function makePool({ runConfig = {}, ledgerResult = {}, settings = {}, scenarioConfig = {} }) {
  return {
    async query(sql) {
      if (/JOIN cg_runs/.test(sql)) {
        return { rows: [{ run_config: runConfig, result: ledgerResult, scenario_config: scenarioConfig }] };
      }
      if (/FROM cg_settings/.test(sql)) {
        return { rows: [{ settings }] };
      }
      if (/SELECT status FROM cg_call_ledger/.test(sql)) {
        return { rows: [{ status: "talking" }] };
      }
      return { rows: [] };
    },
  };
}

async function captureTimerDelay(fn) {
  const originalSetTimeout = global.setTimeout;
  let captured = null;
  global.setTimeout = (cb, delay) => {
    captured = delay;
    return { unref() {} };
  };
  try {
    await fn();
  } finally {
    global.setTimeout = originalSetTimeout;
  }
  return captured;
}

function withFetch(fn) {
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, async json() { return {}; }, async text() { return ""; } });
  return Promise.resolve(fn()).finally(() => { global.fetch = origFetch; });
}

test("hangup guard uses Settings max_call_duration_secs when run config is empty", async () => {
  const pool = makePool({ runConfig: {}, settings: { max_call_duration_secs: 120 } });
  await withFetch(async () => {
    const delay = await captureTimerDelay(() =>
      runPostAnswerActions(pool, "ledger-1", { call_control_id: "v3:CC" }, { executeSequence: false })
    );
    assert.equal(delay, 120 * 1000);
  });
});

test("explicit run config maxDurationSecs takes priority over Settings", async () => {
  const pool = makePool({ runConfig: { postAnswer: { maxDurationSecs: 200 } }, settings: { max_call_duration_secs: 120 } });
  await withFetch(async () => {
    const delay = await captureTimerDelay(() =>
      runPostAnswerActions(pool, "ledger-2", { call_control_id: "v3:CC" }, { executeSequence: false })
    );
    assert.equal(delay, 200 * 1000);
  });
});

test("per-scenario maxCallDurationSecs overrides the global Settings value in the hangup guard", async () => {
  // Regression for the 120s cutoff: cg_runs.config is empty so the guard must
  // read the per-scenario override, not fall back to the global Settings value
  // (which would fire at 120s on a scenario configured for 360s).
  const pool = makePool({ runConfig: {}, scenarioConfig: { maxCallDurationSecs: 360 }, settings: { max_call_duration_secs: 120 } });
  await withFetch(async () => {
    const delay = await captureTimerDelay(() =>
      runPostAnswerActions(pool, "ledger-scenario", { call_control_id: "v3:CC" }, { executeSequence: false })
    );
    assert.equal(delay, 360 * 1000);
  });
});

test("explicit run config maxDurationSecs still wins over the scenario override in the guard", async () => {
  const pool = makePool({ runConfig: { postAnswer: { maxDurationSecs: 45 } }, scenarioConfig: { maxCallDurationSecs: 360 }, settings: { max_call_duration_secs: 120 } });
  await withFetch(async () => {
    const delay = await captureTimerDelay(() =>
      runPostAnswerActions(pool, "ledger-scenario-2", { call_control_id: "v3:CC" }, { executeSequence: false })
    );
    assert.equal(delay, 45 * 1000);
  });
});

test("falls back to 120s default when neither run config, scenario nor Settings provide a value", async () => {
  const pool = makePool({ runConfig: {}, settings: {} });
  await withFetch(async () => {
    const delay = await captureTimerDelay(() =>
      runPostAnswerActions(pool, "ledger-3", { call_control_id: "v3:CC" }, { executeSequence: false })
    );
    assert.equal(delay, 120 * 1000);
  });
});
