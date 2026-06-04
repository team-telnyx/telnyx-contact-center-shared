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

test("agent status endpoint treats agent_status as authoritative over users.status", async () => {
  const src = await source(agentStatusRoutePath);

  assert.doesNotMatch(
    src,
    /targetUser\.status\s*\|\|\s*targetUser\.agent_status/,
    "post-wrapup Available can leave users.status stale/optimistic; agent_status must be preferred",
  );
  assert.match(
    src,
    /targetUser\.agent_status\s*\|\|\s*targetUser\.status\s*\|\|\s*"Unknown"/,
    "agent status transitions must compare against the Contact Center authoritative user agent_status",
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
    "unchanged Available must still force users.agent_status and cc_agent_state into the requested DB-authoritative status before routing",
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
