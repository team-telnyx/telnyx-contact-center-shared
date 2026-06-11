import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  computePowerDialBudget,
  powerPacingConfig,
  isPowerPacingEnabled,
} from "../lib/outbound-dialer/pacing-power.js";

const pacingPath = new URL("../lib/outbound-dialer/pacing-power.js", import.meta.url);
const executionPath = new URL("../lib/outbound-dialer/execution.js", import.meta.url);
const coordinatorPath = new URL("../lib/contact-center/coordinator.js", import.meta.url);

// ---------------------------------------------------------------------------
// Pacing math (pure)
// ---------------------------------------------------------------------------

test("WS5-T3 dial budget: ceil(ratio × freeAgents) − inFlight", () => {
  assert.equal(computePowerDialBudget({ freeAgents: 4, ratio: 1, inFlight: 0, maxLines: 50 }), 4);
  assert.equal(computePowerDialBudget({ freeAgents: 4, ratio: 1.5, inFlight: 2, maxLines: 50 }), 4);
  assert.equal(computePowerDialBudget({ freeAgents: 3, ratio: 2, inFlight: 5, maxLines: 50 }), 1);
});

test("WS5-T3 dial budget never negative and respects maxLines cap", () => {
  assert.equal(computePowerDialBudget({ freeAgents: 1, ratio: 1, inFlight: 5, maxLines: 50 }), 0);
  assert.equal(computePowerDialBudget({ freeAgents: 0, ratio: 3, inFlight: 0, maxLines: 50 }), 0);
  // cap: inFlight + dialed must not exceed maxLines
  assert.equal(computePowerDialBudget({ freeAgents: 10, ratio: 2, inFlight: 8, maxLines: 10 }), 2);
  assert.equal(computePowerDialBudget({ freeAgents: 10, ratio: 1, inFlight: 10, maxLines: 10 }), 0);
});

test("WS5-T3 dial budget tolerates garbage input (fail-safe to 0/defaults)", () => {
  assert.equal(computePowerDialBudget({ freeAgents: NaN, ratio: null, inFlight: -3, maxLines: 0 }), 0);
  assert.equal(computePowerDialBudget({}), 0);
});

test("WS5-T3 dial budget per-tick burst cap", () => {
  // even with a huge budget, a single tick dials at most 10 lines
  assert.equal(computePowerDialBudget({ freeAgents: 100, ratio: 3, inFlight: 0, maxLines: 500 }), 10);
});

test("WS5-T3 pacing config defaults: ratio=1, abandonTimeoutSecs=10", () => {
  const defaults = powerPacingConfig({});
  assert.equal(defaults.ratio, 1);
  assert.equal(defaults.abandonTimeoutSecs, 10);

  const configured = powerPacingConfig({
    pacing_config: { ratio: 2.5, abandonTimeoutSecs: 5 },
  });
  assert.equal(configured.ratio, 2.5);
  assert.equal(configured.abandonTimeoutSecs, 5);
});

// ---------------------------------------------------------------------------
// Dormancy guards (flag off by default)
// ---------------------------------------------------------------------------

test("WS5-T3 power pacing is inert unless OUTBOUND_POWER_PACING=true", () => {
  const prev = process.env.OUTBOUND_POWER_PACING;
  delete process.env.OUTBOUND_POWER_PACING;
  assert.equal(isPowerPacingEnabled(), false);
  process.env.OUTBOUND_POWER_PACING = "false";
  assert.equal(isPowerPacingEnabled(), false);
  process.env.OUTBOUND_POWER_PACING = "true";
  assert.equal(isPowerPacingEnabled(), true);
  if (prev === undefined) delete process.env.OUTBOUND_POWER_PACING;
  else process.env.OUTBOUND_POWER_PACING = prev;
});

// ---------------------------------------------------------------------------
// Contract guards (source-level, same style as other WS tests)
// ---------------------------------------------------------------------------

test("WS5-T3 pacer reuses shared claim/originate primitives (no parallel dial path)", async () => {
  const source = await readFile(pacingPath, "utf8");
  assert.match(source, /claimOneAgentlessRecord\(pool, campaign, run\?\.id \|\| null/, "claims via shared WS5-T1 primitive");
  assert.match(source, /executeAgentlessAttempt\(pool, campaign, claim\)/, "originates via shared WS5-T2 primitive (AMD included)");
  assert.match(source, /attemptReason: "power_pacing_claim"/, "power claims are tagged");
});

test("WS5-T3 human connect path reserves agent with channel='outbound' before bridging", async () => {
  const source = await readFile(pacingPath, "utf8");
  assert.match(source, /channel: "outbound",\s*\n\s*attemptId: ledgerId/, "reserveAgent uses outbound channel + attemptId");
  assert.match(source, /DIAL_STATES\.CONNECTING/, "human → connecting transition is CAS-guarded");
  assert.match(source, /releaseReservation\(reservationId, \{ pool \}\)/, "reservation released on stale state or bridge failure");
  assert.match(source, /bridgeCallToAgent\(/, "bridges via the shared webrtc-bridge primitive");
});

test("WS5-T3 overshoot path abandons humans past abandonTimeoutSecs", async () => {
  const source = await readFile(pacingPath, "utf8");
  assert.match(source, /waitedSecs > abandonTimeoutSecs/, "abandon threshold enforced");
  assert.match(source, /DIAL_STATES\.ABANDONED/, "abandoned via dial-state CAS");
  assert.match(source, /actions\/hangup/, "abandoned calls are hung up");
  assert.match(source, /reason_code: "abandoned"/, "ledger completion carries abandoned reason code");
});

test("WS5-T3 pacer only targets running campaigns with mode='power'", async () => {
  const source = await readFile(pacingPath, "utf8");
  assert.match(
    source,
    /WHERE status = 'running' AND mode = 'power'/,
    "campaign selection is mode-gated; agentless/preview/progressive untouched",
  );
});

test("WS5-T3 AMD human handler only invokes power connect for power campaigns", async () => {
  const source = await readFile(executionPath, "utf8");
  assert.match(
    source,
    /String\(ledger\.mode \|\| ""\) === "power"/,
    "machine-detection human path is mode-gated",
  );
  assert.match(
    source,
    /handleHumanAnswerForPowerCampaign\(pool, ledger, callControlId\)/,
    "power connect handler invoked from AMD webhook path",
  );
});

test("WS5-T3 pacing loop is mounted leader-only inside the WS3 coordinator", async () => {
  const source = await readFile(coordinatorPath, "utf8");
  assert.match(source, /startPowerPacingLoop\(\{ signal \}\)/, "started in the leader loop with the leadership abort signal");
  assert.match(source, /stopPowerPacingLoop\(\)/, "stopped when leadership is lost");
});

test("WS5-T3 free-agent query is DB-authoritative (reservations + agent state)", async () => {
  const source = await readFile(pacingPath, "utf8");
  assert.match(source, /cc_queue_user_assignments/, "respects queue assignment activation");
  assert.match(source, /cc_agent_reservations/, "counts unexpired reservations for capacity");
  assert.match(source, /agent_status = 'Available'/, "only Available agents");
  assert.match(source, /max_concurrent_calls/, "respects per-agent concurrency");
});
