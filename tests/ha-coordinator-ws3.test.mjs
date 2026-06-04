import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const schemaPath = new URL("../lib/postgres-schema.mjs", import.meta.url);
const coordinatorPath = new URL("../lib/contact-center/coordinator-lease.js", import.meta.url);
const stateManagerPath = new URL("../lib/contact-center/state-manager.js", import.meta.url);

function createFakePool({ acquired = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/INSERT INTO cc_coordinator_leases/i.test(sql)) {
        return acquired ? { rows: [{ lease_name: params[0] }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test("WS3 schema adds DB-backed coordinator leases", async () => {
  const source = await readFile(schemaPath, "utf8");

  assert.match(source, /CREATE TABLE IF NOT EXISTS cc_coordinator_leases/);
  assert.match(source, /lease_name TEXT PRIMARY KEY/);
  assert.match(source, /owner_id TEXT NOT NULL/);
  assert.match(source, /lease_expires_at TIMESTAMPTZ NOT NULL/);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_coordinator_leases_expires_at/);
});

test("runWithCoordinatorLease atomically acquires or renews a DB lease before running work", async () => {
  const { runWithCoordinatorLease } = await import(coordinatorPath);
  const pool = createFakePool({ acquired: true });
  let ran = 0;

  const result = await runWithCoordinatorLease(
    "cc-routing-re-eval",
    20_000,
    async () => {
      ran += 1;
      return "done";
    },
    { pool, ownerId: "node-a" },
  );

  assert.equal(ran, 1);
  assert.deepEqual(result, { acquired: true, result: "done" });
  const leaseCall = pool.calls.find((call) => /INSERT INTO cc_coordinator_leases/i.test(call.sql));
  assert.ok(leaseCall, "coordinator should insert into lease table");
  assert.match(leaseCall.sql, /ON CONFLICT \(lease_name\) DO UPDATE/i);
  assert.match(leaseCall.sql, /lease_expires_at < now\(\)/i);
  assert.match(leaseCall.sql, /owner_id = EXCLUDED\.owner_id/i);
  assert.match(leaseCall.sql, /RETURNING lease_name/i);
  assert.equal(leaseCall.params[0], "cc-routing-re-eval");
  assert.equal(leaseCall.params[1], "node-a");
  assert.equal(leaseCall.params[2], 20_000);
});

test("runWithCoordinatorLease skips work when another node holds the lease", async () => {
  const { runWithCoordinatorLease } = await import(coordinatorPath);
  const pool = createFakePool({ acquired: false });
  let ran = 0;

  const result = await runWithCoordinatorLease(
    "cc-routing-re-eval",
    20_000,
    async () => {
      ran += 1;
    },
    { pool, ownerId: "node-b" },
  );

  assert.equal(ran, 0);
  assert.deepEqual(result, { acquired: false, skipped: true });
});

test("state manager gates routing-critical background jobs with coordinator leases", async () => {
  const source = await readFile(stateManagerPath, "utf8");

  assert.match(source, /import \{ runWithCoordinatorLease \} from "\.\/coordinator-lease\.js"/);
  assert.match(source, /runWithCoordinatorLease\(\s*"cc-routing-re-eval"[\s\S]*?reEvaluateRoutingForAvailableAgents/);
  assert.match(source, /runWithCoordinatorLease\(\s*"cc-agent-answer-timeouts"[\s\S]*?checkAndHandleAgentAnswerTimeouts/);
});
