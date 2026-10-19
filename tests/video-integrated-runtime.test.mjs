import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { startVideoAiService } from "../lib/runtime/video-ai-service.mjs";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  throw new Error("Runtime did not reach expected state");
}

test("application waits for schema, recovers browser failure, and stops before restarting", async () => {
  let queries = 0, starts = 0, stops = 0, fail;
  const errors = [], states = [];
  const runtime = startVideoAiService({ env: {}, retryMs: 1,
    getPool: async () => ({ query: async () => { if (++queries === 1) throw new Error("schema not ready"); } }),
    startWorker: async (_, options) => {
      assert.equal(starts, stops, "previous media runtime must be closed before replacement");
      starts++; fail = options.onFailure;
      return { owner: `worker-${starts}`, stop: async () => { stops++; } };
    }, onError: error => errors.push(error.message), onState: state => states.push(state.status),
  });
  try {
    await until(() => runtime.state.owner === "worker-1");
    fail(new Error("Chromium disconnected"));
    await until(() => runtime.state.owner === "worker-2");
    await Promise.all([runtime.stop(), runtime.stop()]);
    assert.equal(stops, 2); assert.equal(starts, 2);
    assert.equal(runtime.state.status, "stopped");
    assert.deepEqual(errors, ["schema not ready", "Chromium disconnected"]);
    assert.equal(states.filter(s => s === "retrying").length, 2);
  } finally { await runtime.stop(); }
});

test("shutdown during Chromium launch closes the late browser and never publishes readiness", async () => {
  const launching = deferred(), launched = deferred();
  let stops = 0; const states = [];
  const runtime = startVideoAiService({ env: {}, getPool: async () => ({ query: async () => {} }),
    startWorker: async () => { launching.resolve(); return launched.promise; }, onState: state => states.push(state.status),
  });
  await launching.promise;
  const stopped = runtime.stop();
  launched.resolve({ owner: "late", stop: async () => { stops++; } });
  await stopped;
  assert.equal(stops, 1); assert.ok(!states.includes("ready"));
});

test("disabled runtime does not import or open browser/database resources", async () => {
  for (const env of [{ VIDEO_CONFERENCE_AI_ENABLED: "false" }, { PROCESS_ROLE: "web" }, { PROCESS_ROLE: "streaming" }, { VIDEO_AI_EXTERNAL_WORKER: "true" }]) {
    const runtime = startVideoAiService({ env, getPool: () => assert.fail("unexpected database access") });
    assert.equal(runtime.state.status, "disabled"); await runtime.stop();
  }
});
