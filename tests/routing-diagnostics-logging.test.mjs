import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const queuedRouterPath = new URL(
  "../lib/contact-center/queued-call-router.js",
  import.meta.url,
);
const userStatusPath = new URL(
  "../lib/contact-center/user-status.js",
  import.meta.url,
);
const agentStatusRoutePath = new URL(
  "../app/api/contact-center/agent/status/route.js",
  import.meta.url,
);
const stateManagerPath = new URL(
  "../lib/contact-center/state-manager.js",
  import.meta.url,
);

async function source(path) {
  return readFile(path, "utf8");
}

test("backend routing diagnostics log each status-to-offer boundary", async () => {
  const routeSrc = await source(agentStatusRoutePath);
  const userStatusSrc = await source(userStatusPath);

  assert.match(routeSrc, /\[AgentStatus\]\[RoutingDiagnostics\] PUT received/);
  assert.match(routeSrc, /\[AgentStatus\]\[RoutingDiagnostics\] setUserStatus completed/);
  assert.match(userStatusSrc, /\[UserStatus\]\[RoutingDiagnostics\] status request/);
  assert.match(userStatusSrc, /\[UserStatus\]\[RoutingDiagnostics\] offerQueuedCallForAgent result/);
});

test("queued-call router diagnostics expose decision reasons and bridge failures", async () => {
  const src = await source(queuedRouterPath);

  assert.match(src, /ROUTING_DIAG_PREFIX\s*=\s*"\[QueuedCallRouter\]\[RoutingDiagnostics\]"/);
  assert.match(src, /routingDiag\("offer start"/);
  assert.match(src, /routingDiag\("active queues loaded"/);
  assert.match(src, /routingDiag\("queued interactions loaded"/);
  assert.match(src, /routingDiag\("queue scores"/);
  assert.match(src, /routingDiag\("interaction skipped"/);
  assert.match(src, /routingDiag\("assignment transaction result"/);
  assert.match(src, /routingDiagError\("bridge failed; interaction re-queued"/);
  assert.match(src, /routingDiag\("no suitable interaction"/);
});

test("periodic routing re-evaluation diagnostics expose eligible agent discovery", async () => {
  const src = await source(stateManagerPath);

  assert.match(src, /\[StateManager\]\[RoutingDiagnostics\] periodic re-eval tick/);
  assert.match(src, /\[StateManager\]\[RoutingDiagnostics\] eligible agents loaded/);
  assert.match(src, /\[StateManager\]\[RoutingDiagnostics\] agent offer result/);
});
