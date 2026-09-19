import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  computeBlendedFreeAgents,
  computePredictiveRatio,
  predictivePacingConfig,
} from "../lib/acd/outbound-pacing.mjs";

test("predictive ratio cold-starts conservatively and adapts to answer rate", () => {
  assert.equal(computePredictiveRatio({ sampleSize: 0, baseRatio: 1.5 }), 1.5);
  assert.equal(computePredictiveRatio({ answerRate: 0.5, abandonRate: 0, sampleSize: 100, baseRatio: 1, maxRatio: 5 }), 2);
  assert.equal(computePredictiveRatio({ answerRate: 0.1, abandonRate: 0, sampleSize: 100, baseRatio: 1, maxRatio: 3 }), 3);
});

test("predictive ratio dampens when abandonment exceeds its target", () => {
  assert.equal(computePredictiveRatio({ answerRate: 0.5, abandonRate: 0.06, sampleSize: 100, baseRatio: 1, maxRatio: 5, abandonTarget: 0.03 }), 1);
  assert.equal(computePredictiveRatio({ answerRate: 0.5, abandonRate: 0.5, sampleSize: 100, baseRatio: 1, maxRatio: 5, abandonTarget: 0.03 }), 0.5);
});

test("blending reserves Core capacity for queued inbound work", () => {
  assert.equal(computeBlendedFreeAgents({ freeAgents: 5, queuedInbound: 2 }), 3);
  assert.equal(computeBlendedFreeAgents({ freeAgents: 5, queuedInbound: 1, inboundReservePercent: 0.2 }), 3);
  assert.equal(computeBlendedFreeAgents({ freeAgents: 5, queuedInbound: 99 }), 0);
});

test("predictive configuration normalizes pacing and blending settings", () => {
  const defaults = predictivePacingConfig({});
  assert.equal(defaults.baseRatio, 1);
  assert.equal(defaults.maxRatio, 3);
  assert.equal(defaults.abandonTarget, 0.03);
  assert.equal(defaults.minSampleSize, 20);
  assert.equal(defaults.statsWindowMinutes, 30);
  assert.equal(defaults.inboundReservePercent, 0);
  const custom = predictivePacingConfig({
    pacing_config: { ratio: 1.2, maxRatio: 4, abandonTarget: 0.05, minSampleSize: 50, statsWindowMinutes: 15 },
    metadata: { blending_config: { inboundReservePercent: 25 } },
  });
  assert.equal(custom.baseRatio, 1.2);
  assert.equal(custom.maxRatio, 4);
  assert.equal(custom.inboundReservePercent, 0.25);
});

test("predictive runtime reads attempt history and Core inbound pressure", async () => {
  const runtime = await readFile(new URL("../lib/acd/outbound-runtime.mjs", import.meta.url), "utf8");
  assert.match(runtime, /outbound_attempt_ledger/);
  assert.match(runtime, /acd_work_items/);
  assert.match(runtime, /outboundBlendingBudget/);
});
