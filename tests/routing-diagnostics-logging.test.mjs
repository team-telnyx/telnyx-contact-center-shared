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

  assert.match(routeSrc, /statusLogger\.debug\("status_update_requested"/);
  assert.match(routeSrc, /statusLogger\.info\("status_update_completed"/);
  assert.match(userStatusSrc, /statusLogger\.debug\("user_status_request"/);
  assert.match(userStatusSrc, /statusLogger\.debug\("user_status_offer_queued_call_result"/);
});

test("queued-call router diagnostics expose decision reasons and bridge failures", async () => {
  const src = await source(queuedRouterPath);

  assert.match(src, /routingLogger\.debug\(diagnosticEventName\(label\), fields\)/);
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

  assert.match(src, /routingLogger\.debug\("state_manager_periodic_reeval_tick"/);
  assert.match(src, /routingLogger\.debug\("state_manager_periodic_reeval_eligible_agents_loaded"/);
  assert.match(src, /routingLogger\.debug\("state_manager_periodic_reeval_agent_offer_result"/);
});
