import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const agentStatusRoutePath = new URL(
  "../app/api/contact-center/agent/status/route.js",
  import.meta.url,
);
const userStatusPath = new URL(
  "../lib/contact-center/user-status.js",
  import.meta.url,
);
const statusTransitionPath = new URL(
  "../lib/contact-center/agent-status-transition.js",
  import.meta.url,
);

async function source(path) {
  return readFile(path, "utf8");
}

test("agent status endpoint reads previous status from cc_agent_state, never users.status", async () => {
  const src = await source(agentStatusRoutePath);

  assert.doesNotMatch(
    src,
    /targetUser\.status|targetUser\.agent_status|users\.status|users\.agent_status/,
    "Contact Center status must not depend on legacy users.status/users.agent_status",
  );
  assert.match(
    src,
    /s\.agent_status AS current_agent_status[\s\S]*targetUser\.current_agent_status\s*\|\|\s*"Unknown"/,
    "agent status transitions must compare against cc_agent_state.agent_status",
  );
});

test("unchanged Available requests reconcile Contact Center status stores before routing", async () => {
  const src = await source(userStatusPath);
  const unchangedStatusBlock = src.slice(
    src.indexOf("if (previousStatus && previousStatus === status)"),
    src.indexOf("// If agent is manually changing status"),
  );

  assert.match(
    unchangedStatusBlock,
    /reconcileAgentStatusStores\([\s\S]*status[\s\S]*\)/,
    "unchanged Available must still force cc_agent_state into the requested DB-authoritative status before routing",
  );
  assert.ok(
    unchangedStatusBlock.indexOf("reconcileAgentStatusStores") <
      unchangedStatusBlock.indexOf("offerQueuedCallForAgent"),
    "status stores must be reconciled before routing offers a queued call",
  );
});

test("ringing Busy transition is forced for assigned ringing interactions, not skipped because one status store is stale", async () => {
  const src = await source(statusTransitionPath);
  const busyHelper = src.slice(
    src.indexOf("export async function markAgentBusyForRinging"),
  );

  assert.doesNotMatch(
    busyHelper,
    /if \(previousStatus !== "Available"\)[\s\S]*return \{/,
    "once routing has assigned/ringing evidence, Busy must be idempotently forced instead of skipped due to stale users.agent_status",
  );
  assert.doesNotMatch(
    busyHelper,
    /WHERE user_id = \$1\s+AND agent_status = 'Available'/,
    "cc_agent_state Busy update must not be conditional on the previous cc_agent_state value after a ringing assignment exists",
  );
  assert.match(
    busyHelper,
    /ON CONFLICT \(user_id\) DO UPDATE SET/,
    "cc_agent_state should still update/upsert the targeted agent row only",
  );
});
