import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  computePredictiveRatio,
  computeBlendedFreeAgents,
  predictivePacingConfig,
  isPredictivePacingEnabled,
} from "../lib/outbound-dialer/pacing-predictive.js";

const predictivePath = new URL("../lib/outbound-dialer/pacing-predictive.js", import.meta.url);
const powerPath = new URL("../lib/outbound-dialer/pacing-power.js", import.meta.url);
const executionPath = new URL("../lib/outbound-dialer/execution.js", import.meta.url);
const coordinatorPath = new URL("../lib/contact-center/coordinator.js", import.meta.url);

// ---------------------------------------------------------------------------
// Predictive controller (pure)
// ---------------------------------------------------------------------------

test("WS6 cold start: below minSampleSize the controller behaves like Power (baseRatio)", () => {
  assert.equal(
    computePredictiveRatio({ answerRate: 0, abandonRate: 0, sampleSize: 0, baseRatio: 1 }),
    1,
  );
  assert.equal(
    computePredictiveRatio({ answerRate: 0.2, abandonRate: 0.5, sampleSize: 19, baseRatio: 1.5, minSampleSize: 20 }),
    1.5,
  );
});

test("WS6 adaptive ratio: lower answer rate → higher dial ratio (1/answerRate)", () => {
  // 50% answer rate → ratio 2
  assert.equal(
    computePredictiveRatio({ answerRate: 0.5, abandonRate: 0, sampleSize: 100, baseRatio: 1, maxRatio: 5 }),
    2,
  );
  // 25% answer rate → ratio 4
  assert.equal(
    computePredictiveRatio({ answerRate: 0.25, abandonRate: 0, sampleSize: 100, baseRatio: 1, maxRatio: 5 }),
    4,
  );
});

test("WS6 ratio is capped by maxRatio and answer-rate floor bounds 1/answerRate", () => {
  // 10% answer rate with maxRatio 3 → capped at 3
  assert.equal(
    computePredictiveRatio({ answerRate: 0.1, abandonRate: 0, sampleSize: 100, baseRatio: 1, maxRatio: 3 }),
    3,
  );
  // answerRate 0 clamps to minAnswerRate (0.1) → 1/0.1 = 10 → capped at maxRatio
  assert.equal(
    computePredictiveRatio({ answerRate: 0, abandonRate: 0, sampleSize: 100, baseRatio: 1, maxRatio: 3 }),
    3,
  );
});

test("WS6 abandon compliance loop: ratio damped multiplicatively above target", () => {
  const atTarget = computePredictiveRatio({
    answerRate: 0.5, abandonRate: 0.03, sampleSize: 100, baseRatio: 1, maxRatio: 5, abandonTarget: 0.03,
  });
  assert.equal(atTarget, 2, "at target → no damping");

  const doubleTarget = computePredictiveRatio({
    answerRate: 0.5, abandonRate: 0.06, sampleSize: 100, baseRatio: 1, maxRatio: 5, abandonTarget: 0.03,
  });
  assert.equal(doubleTarget, 1, "2× target → ratio halved (2 × 0.5)");

  const extreme = computePredictiveRatio({
    answerRate: 0.5, abandonRate: 0.5, sampleSize: 100, baseRatio: 1, maxRatio: 5, abandonTarget: 0.03,
  });
  assert.equal(extreme, 0.5, "extreme abandon → damping floored at MIN (0.25): 2 × 0.25");
});

test("WS6 controller tolerates garbage input", () => {
  const ratio = computePredictiveRatio({ answerRate: NaN, abandonRate: null, sampleSize: -5 });
  assert.ok(ratio > 0 && Number.isFinite(ratio));
  const empty = computePredictiveRatio({});
  assert.ok(empty > 0 && Number.isFinite(empty));
});

// ---------------------------------------------------------------------------
// Blending (pure)
// ---------------------------------------------------------------------------

test("WS6 blending: queued inbound interactions reserve agents first", () => {
  assert.equal(computeBlendedFreeAgents({ freeAgents: 5, queuedInbound: 0 }), 5);
  assert.equal(computeBlendedFreeAgents({ freeAgents: 5, queuedInbound: 2 }), 3);
  assert.equal(computeBlendedFreeAgents({ freeAgents: 5, queuedInbound: 99 }), 0, "reserve capped at freeAgents");
});

test("WS6 blending: fixed percentage reserve on top of queued inbound", () => {
  // 20% of 10 agents = 2 reserved → 8 outbound
  assert.equal(
    computeBlendedFreeAgents({ freeAgents: 10, queuedInbound: 0, inboundReservePercent: 0.2 }),
    8,
  );
  // ceil(0.2 × 5) = 1 + 1 queued = 2 reserved → 3 outbound
  assert.equal(
    computeBlendedFreeAgents({ freeAgents: 5, queuedInbound: 1, inboundReservePercent: 0.2 }),
    3,
  );
  assert.equal(computeBlendedFreeAgents({}), 0);
});

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

test("WS6 predictive config defaults (ratio 1, maxRatio 3, target 3%, window 30m, sample 20)", () => {
  const cfg = predictivePacingConfig({});
  assert.equal(cfg.baseRatio, 1);
  assert.equal(cfg.maxRatio, 3);
  assert.equal(cfg.abandonTarget, 0.03);
  assert.equal(cfg.minSampleSize, 20);
  assert.equal(cfg.statsWindowMinutes, 30);
  assert.equal(cfg.inboundReservePercent, 0);

  const custom = predictivePacingConfig({
    pacing_config: { ratio: 1.2, maxRatio: 4, abandonTarget: 0.05, minSampleSize: 50, statsWindowMinutes: 15 },
    metadata: { blending_config: { inboundReservePercent: 25 } },
  });
  assert.equal(custom.baseRatio, 1.2);
  assert.equal(custom.maxRatio, 4);
  assert.equal(custom.abandonTarget, 0.05);
  assert.equal(custom.minSampleSize, 50);
  assert.equal(custom.statsWindowMinutes, 15);
  assert.equal(custom.inboundReservePercent, 0.25);
});

// ---------------------------------------------------------------------------
// Dormancy guards
// ---------------------------------------------------------------------------

test("WS6 predictive pacing is inert unless OUTBOUND_PREDICTIVE_PACING=true", () => {
  const prev = process.env.OUTBOUND_PREDICTIVE_PACING;
  delete process.env.OUTBOUND_PREDICTIVE_PACING;
  assert.equal(isPredictivePacingEnabled(), false);
  process.env.OUTBOUND_PREDICTIVE_PACING = "false";
  assert.equal(isPredictivePacingEnabled(), false);
  process.env.OUTBOUND_PREDICTIVE_PACING = "true";
  assert.equal(isPredictivePacingEnabled(), true);
  if (prev === undefined) delete process.env.OUTBOUND_PREDICTIVE_PACING;
  else process.env.OUTBOUND_PREDICTIVE_PACING = prev;
});

// ---------------------------------------------------------------------------
// Contract guards (source-level)
// ---------------------------------------------------------------------------

test("WS6 pacer reuses shared claim/originate/budget primitives (no parallel dial path)", async () => {
  const source = await readFile(predictivePath, "utf8");
  assert.match(source, /claimOneAgentlessRecord\(pool, campaign, run\?\.id \|\| null/, "claims via shared WS5-T1 primitive");
  assert.match(source, /executeAgentlessAttempt\(pool, campaign, claim\)/, "originates via shared WS5-T2 primitive");
  assert.match(source, /computePowerDialBudget\(\{/, "budget math shared with the Power pacer");
  assert.match(source, /attemptReason: "predictive_pacing_claim"/, "predictive claims are tagged");
  assert.match(source, /reconnectOrAbandonPendingHumans\(pool, campaign\)/, "human retry/abandon reuses the WS5 primitive");
});

test("WS6 pacer only targets running campaigns with mode='predictive'", async () => {
  const source = await readFile(predictivePath, "utf8");
  assert.match(
    source,
    /WHERE status = 'running' AND mode = 'predictive'/,
    "campaign selection is mode-gated",
  );
});

test("WS6 stats are DB-authoritative from the attempt ledger (trailing window)", async () => {
  const source = await readFile(predictivePath, "utf8");
  assert.match(source, /FROM outbound_attempt_ledger/, "stats sourced from the ledger");
  assert.match(source, /dial_state = 'abandoned'/, "abandons counted from the dial-state machine");
  assert.match(source, /updated_at > NOW\(\) - \(\$2::text \|\| ' minutes'\)::interval/, "trailing window");
});

test("WS6 blending counts queued inbound from cc_interactions", async () => {
  const source = await readFile(predictivePath, "utf8");
  assert.match(source, /FROM cc_interactions/, "inbound pressure from interactions table");
  assert.match(source, /state = 'queued'/, "only queued interactions reserve agents");
});

test("WS6 human connect path is shared with Power and gated per mode", async () => {
  const powerSource = await readFile(powerPath, "utf8");
  assert.match(powerSource, /mode === "power" && !isPowerPacingEnabled\(\)/, "power gate preserved");
  assert.match(powerSource, /isPredictivePacingEnabled/, "predictive gate added");

  const executionSource = await readFile(executionPath, "utf8");
  assert.match(
    executionSource,
    /\["power", "predictive"\]\.includes\(String\(ledger\.mode \|\| ""\)\)/,
    "AMD human path dispatches both modes",
  );
});

test("WS6 pacing loop is mounted leader-only inside the WS3 coordinator", async () => {
  const source = await readFile(coordinatorPath, "utf8");
  assert.match(source, /startPredictivePacingLoop\(\{ signal \}\)/, "started in the leader loop");
  assert.match(source, /stopPredictivePacingLoop\(\)/, "stopped when leadership is lost");
});
