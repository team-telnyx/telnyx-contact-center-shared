import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  computePowerDialBudget,
  powerPacingConfig,
} from "../lib/acd/outbound-pacing.mjs";

test("power dial budget follows ratio, occupancy and line limits", () => {
  assert.equal(computePowerDialBudget({ freeAgents: 4, ratio: 1.5, inFlight: 2, maxLines: 50 }), 4);
  assert.equal(computePowerDialBudget({ freeAgents: 10, ratio: 2, inFlight: 8, maxLines: 10 }), 2);
  assert.equal(computePowerDialBudget({ freeAgents: 1, ratio: 1, inFlight: 5, maxLines: 50 }), 0);
  assert.equal(computePowerDialBudget({ freeAgents: 100, ratio: 3, inFlight: 0, maxLines: 500 }), 10);
});

test("power dial budget rejects unusable capacity input", () => {
  assert.equal(computePowerDialBudget({ freeAgents: Number.NaN, ratio: null, inFlight: -3, maxLines: 0 }), 0);
  assert.equal(computePowerDialBudget({}), 0);
});

test("power pacing configuration has safe defaults and accepts overrides", () => {
  assert.deepEqual(powerPacingConfig({}), { ratio: 1, abandonTimeoutSecs: 10 });
  assert.deepEqual(
    powerPacingConfig({ pacing_config: { ratio: 2.5, abandonTimeoutSecs: 5 } }),
    { ratio: 2.5, abandonTimeoutSecs: 5 },
  );
});

test("power pacing executes only through the durable ACD worker", async () => {
  const [runtime, worker] = await Promise.all([
    readFile(new URL("../lib/acd/outbound-runtime.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/acd/worker.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(runtime, /computePowerDialBudget/);
  assert.match(runtime, /outboundBlendingBudget/);
  assert.match(runtime, /acd_work_items/);
  assert.match(worker, /tickOutboundVoice/);
});
