import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const stateManagerPath = new URL(
  "../lib/contact-center/state-manager.js",
  import.meta.url,
);
const queuedRouterPath = new URL(
  "../lib/contact-center/queued-call-router.js",
  import.meta.url,
);

async function source(path) {
  return readFile(path, "utf8");
}

test("queue metrics exclude terminal interactions even when state is still queued", async () => {
  const src = await source(stateManagerPath);

  const queueHydration = src.slice(
    src.indexOf("const queueStates = await pool.query"),
    src.indexOf("// Load agent states"),
  );
  assert.match(queueHydration, /i\.completed_at IS NULL/);
  assert.match(queueHydration, /i\.abandoned_at IS NULL/);

  const refreshQueueState = src.slice(
    src.indexOf("export async function refreshQueueState"),
    src.indexOf("// Initialize state manager when module is imported"),
  );
  assert.match(refreshQueueState, /i\.completed_at IS NULL/);
  assert.match(refreshQueueState, /i\.abandoned_at IS NULL/);
});

test("queued-call assignment refuses terminal queued interactions", async () => {
  const src = await source(queuedRouterPath);

  const assignment = src.slice(
    src.indexOf("async function assignQueuedInteractionToAgent"),
    src.indexOf("export async function offerQueuedCallForAgent"),
  );
  assert.match(assignment, /interaction\.completed_at/);
  assert.match(assignment, /interaction\.abandoned_at/);
  assert.match(assignment, /reason:\s*"interaction_terminal"/);
  assert.match(assignment, /WHERE id = \$7 AND state = 'queued'\s+AND completed_at IS NULL\s+AND abandoned_at IS NULL/);
});
