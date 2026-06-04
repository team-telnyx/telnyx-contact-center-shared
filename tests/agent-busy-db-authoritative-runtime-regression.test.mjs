import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const statusTransitionPath = new URL(
  "../lib/contact-center/agent-status-transition.js",
  import.meta.url,
);
const stateManagerPath = new URL(
  "../lib/contact-center/state-manager.js",
  import.meta.url,
);
const webhookHandlerPath = new URL(
  "../lib/contact-center/webhook-handler.js",
  import.meta.url,
);

async function source(path) {
  return readFile(path, "utf8");
}

function between(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing start needle: ${startNeedle}`);
  const end = src.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing end needle: ${endNeedle}`);
  return src.slice(start, end);
}

test("ringing Busy transition upserts cc_agent_state inside the same transaction as users", async () => {
  const src = await source(statusTransitionPath);
  const helper = between(
    src,
    "export async function markAgentBusyForRinging",
    "export async function restoreAgentAvailableAfterFailedRinging",
  );

  assert.match(helper, /await client\.query\("BEGIN"\)/);
  assert.match(helper, /UPDATE users[\s\S]*agent_status = 'Busy'[\s\S]*status = 'Busy'/);
  assert.match(helper, /INSERT INTO cc_agent_state[\s\S]*agent_status[\s\S]*'Busy'/);
  assert.match(helper, /ON CONFLICT \(user_id\) DO UPDATE SET[\s\S]*agent_status = EXCLUDED\.agent_status/);
  assert.match(helper, /current_calls_count = GREATEST\(cc_agent_state\.current_calls_count, 1\)/);
  assert.match(helper, /await client\.query\("COMMIT"\)/);
  assert.match(helper, /await client\.query\("ROLLBACK"\)/);
  assert.ok(
    helper.indexOf('await client.query("BEGIN")') < helper.indexOf("UPDATE users"),
    "users update should be inside the transaction",
  );
  assert.ok(
    helper.indexOf("UPDATE users") < helper.indexOf("INSERT INTO cc_agent_state"),
    "cc_agent_state upsert should be part of the same transaction after users update",
  );
});

test("state-manager updateAgentStatus updates only the read-model cache status, not DB", async () => {
  const src = await source(stateManagerPath);
  const updateBlock = between(
    src,
    "export async function updateAgentStatus",
    "/**\n * Update agent queue activation",
  );

  assert.match(
    updateBlock,
    /agentState\.agentStatus\s*=\s*status/,
    "DB-authoritative writers must still be able to refresh node-local read model status",
  );
  assert.doesNotMatch(updateBlock, /UPDATE\s+cc_agent_state|INSERT INTO cc_agent_state|UPDATE\s+users/i);
});

test("answered queue calls promote their reservation to active so expiry sweep cannot restore Available mid-call", async () => {
  const src = await source(webhookHandlerPath);
  const answeredCase = between(src, 'case "call.answered": {', 'case "call.bridged":');

  assert.match(answeredCase, /promoteReservation/);
  assert.match(answeredCase, /reservationId|reservation_id/);
  assert.match(answeredCase, /"active"/);
  assert.ok(
    answeredCase.indexOf("promoteReservation") < answeredCase.indexOf("break;"),
    "reservation must be promoted before the answered handler exits",
  );
});
