import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const queuedRouterPath = new URL("../lib/contact-center/queued-call-router.js", import.meta.url);
const skillsReEvaluatorPath = new URL("../lib/contact-center/skills-re-evaluator.js", import.meta.url);
const statusTransitionPath = new URL("../lib/contact-center/agent-status-transition.js", import.meta.url);

async function source(url) {
  return readFile(url, "utf8");
}

test("queued-call router marks the agent Busy after assignment commit and before WebRTC bridge", async () => {
  const src = await source(queuedRouterPath);

  assert.match(src, /handleAgentCallLifecycleStatus/);

  const commitIndex = src.indexOf('await client.query("COMMIT")');
  const busyIndex = src.indexOf('event: "ringing"');
  const bridgeIndex = src.indexOf("await bridgeCallToAgent");

  assert.ok(commitIndex > -1, "assignment transaction should commit before external side effects");
  assert.ok(busyIndex > -1, "agent must be marked Busy when ringing starts");
  assert.ok(bridgeIndex > -1, "router should still bridge after status update");
  assert.ok(commitIndex < busyIndex, "Busy status must be set after DB assignment commit");
  assert.ok(busyIndex < bridgeIndex, "Busy status must be visible before the softphone rings");

  const bridgeFailedBlock = src.slice(src.indexOf("} catch (error) {", bridgeIndex), src.indexOf("routingDiagError(\"bridge failed; interaction re-queued\""));
  assert.match(bridgeFailedBlock, /await releaseReservation/);
  assert.match(bridgeFailedBlock, /handleAgentCallLifecycleStatus\([\s\S]*event:\s*"no-answer"/);
  assert.doesNotMatch(bridgeFailedBlock, /restoreAgentAvailableAfterFailedRinging/);
});

test("legacy skills re-evaluator also marks agent Busy before direct WebRTC bridge", async () => {
  const src = await source(skillsReEvaluatorPath);

  assert.match(src, /handleAgentCallLifecycleStatus/);
  const busyIndex = src.indexOf('event: "ringing"');
  const bridgeIndex = src.indexOf("await bridgeCallToAgent");
  assert.ok(busyIndex > -1, "legacy evaluator must mark Busy");
  assert.ok(bridgeIndex > -1, "legacy evaluator still bridges");
  assert.ok(busyIndex < bridgeIndex, "Busy status must be visible before direct bridge rings");
});

test("agent status transition helper requires live ringing evidence and broadcasts status_changed", async () => {
  const src = await source(statusTransitionPath);

  assert.match(src, /export async function markAgentBusyForRinging/);
  assert.doesNotMatch(src, /UPDATE\s+users[\s\S]*(?:status\s*=|agent_status\s*=)/i);
  assert.match(src, /FROM cc_agent_reservations[\s\S]*UNION[\s\S]*FROM cc_interactions/s);
  assert.match(src, /reason:\s*"no_live_ringing_evidence"/);
  assert.match(src, /INSERT INTO cc_agent_state[\s\S]*'Busy'/s);
  assert.match(src, /ON CONFLICT \(user_id\) DO UPDATE SET[\s\S]*agent_status = EXCLUDED\.agent_status/s);
  assert.match(src, /current_calls_count = EXCLUDED\.current_calls_count/);
  assert.doesNotMatch(src, /GREATEST\(cc_agent_state\.current_calls_count, 1\)/);
  assert.match(src, /broadcastAgentStatusChanged/);
  assert.match(src, /`user:status:\$\{userId\}`/);
  assert.match(src, /`contact-center:agent:\$\{username\}`/);
});
