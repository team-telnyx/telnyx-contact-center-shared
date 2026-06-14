import assert from "node:assert/strict";
import { test } from "node:test";
import { runPostAnswerActions } from "../lib/call-generator/engine.mjs";

// Regression: the generated-call hangup guard must honour the configured
// Settings max_call_duration_secs. Previously it fell back to a hardcoded 60s
// because cg_runs.config is persisted empty ({}), so a Settings value of 120s
// never took effect and every call was cut at ~60s.

process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || "test-key";

function makePool({ runConfig = {}, ledgerResult = {}, settings = {} }) {
  return {
    async query(sql) {
      if (/JOIN cg_runs/.test(sql)) {
        return { rows: [{ config: runConfig, result: ledgerResult }] };
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

test("hangup guard uses Settings max_call_duration_secs when run config is empty", async () => {
  const pool = makePool({ runConfig: {}, settings: { max_call_duration_secs: 120 } });
  // stub fetch (speak/playback calls) so no real network
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, async json() { return {}; }, async text() { return ""; } });
  try {
    const delay = await captureTimerDelay(() =>
      runPostAnswerActions(pool, "ledger-1", { call_control_id: "v3:CC" }, { executeSequence: false })
    );
    assert.equal(delay, 120 * 1000);
  } finally {
    global.fetch = origFetch;
  }
});

test("explicit run config maxDurationSecs takes priority over Settings", async () => {
  const pool = makePool({ runConfig: { postAnswer: { maxDurationSecs: 200 } }, settings: { max_call_duration_secs: 120 } });
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, async json() { return {}; }, async text() { return ""; } });
  try {
    const delay = await captureTimerDelay(() =>
      runPostAnswerActions(pool, "ledger-2", { call_control_id: "v3:CC" }, { executeSequence: false })
    );
    assert.equal(delay, 200 * 1000);
  } finally {
    global.fetch = origFetch;
  }
});

test("falls back to 120s default when neither run config nor Settings provide a value", async () => {
  const pool = makePool({ runConfig: {}, settings: {} });
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, async json() { return {}; }, async text() { return ""; } });
  try {
    const delay = await captureTimerDelay(() =>
      runPostAnswerActions(pool, "ledger-3", { call_control_id: "v3:CC" }, { executeSequence: false })
    );
    assert.equal(delay, 120 * 1000);
  } finally {
    global.fetch = origFetch;
  }
});
