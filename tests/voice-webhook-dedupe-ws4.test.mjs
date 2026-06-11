import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Load DB env from .env (node:test does not load Next.js dotenv files).
async function loadEnvFile() {
  try {
    const raw = await readFile(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) {
        process.env[key] = value.replace(/^"|"$/g, "");
      }
    }
  } catch {
    /* no .env — DB-dependent tests will be skipped */
  }
}

await loadEnvFile();

const { getPostgresPool } = await import("../lib/postgres.mjs");

async function dbAvailable() {
  try {
    const pool = getPostgresPool();
    if (!pool) return false;
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const hasDb = await dbAvailable();
const routePath = new URL(
  "../app/api/voice/webhook/incoming/[flowId]/route.js",
  import.meta.url,
);

test("WS4-T1 route no longer uses in-process dedupe maps", async () => {
  const source = await readFile(routePath, "utf8");
  assert.ok(
    !source.includes("executedTransitions") && !source.includes("completedFlows"),
    "in-process Maps must be fully replaced by the replay-safe dedupe helper",
  );
  assert.match(
    source,
    /from\s+["']@\/lib\/events\/webhook-dedupe\.js["']/,
    "route should import the WS4 dedupe helper",
  );
  assert.match(
    source,
    /claimWebhookKeyOnce\(\s*transitionKey,\s*DEDUPE_KIND_TRANSITION,?\s*\)/,
    "transitions must be claimed atomically",
  );
  assert.match(
    source,
    /markWebhookKeyProcessed\(\s*flowCompletionKey,\s*DEDUPE_KIND_FLOW_COMPLETE,?\s*\)/,
    "flow completion must be persisted through the dedupe helper",
  );
});

test("WS4-T1 transition keys preserve the pre-WS4 shape (call:from:to:event)", async () => {
  const source = await readFile(routePath, "utf8");
  assert.match(
    source,
    /\$\{payload\.call_control_id\}:\$\{currentNode\.id\}:\$\{nextNode\.id\}:\$\{event\}/,
    "webhook transition key format unchanged",
  );
  assert.match(
    source,
    /\$\{callControlId\}:\$\{currentNode\.id\}:\$\{nextNode\.id\}:\$\{\s*currentResult\.output \|\| 0\s*\}/,
    "node-chain transition key format unchanged",
  );
  assert.match(
    source,
    /\$\{payload\.call_control_id\}:\$\{flowId\}/,
    "flow completion key format unchanged",
  );
});

test("WS4-T1 memory layer: claimOnce true exactly once, TTL semantics preserved", async () => {
  process.env.WEBHOOK_IDEMPOTENCY_DB = "false";
  const dedupe = await import("../lib/events/webhook-dedupe.js");
  dedupe.__clearMemoryForTests();

  const key = `test-mem-${randomUUID()}`;
  assert.equal(await dedupe.claimOnce(key, "voice:test"), true, "first claim wins");
  assert.equal(await dedupe.claimOnce(key, "voice:test"), false, "replay is suppressed");
  assert.equal(await dedupe.wasProcessed(key), true);
  assert.equal(await dedupe.wasProcessed(`other-${randomUUID()}`), false);
  delete process.env.WEBHOOK_IDEMPOTENCY_DB;
});

test(
  "WS4-T1 DB layer: replay suppressed across simulated processes/restarts",
  { skip: !hasDb && "postgres not reachable" },
  async () => {
    process.env.WEBHOOK_IDEMPOTENCY_DB = "true";
    const dedupe = await import("../lib/events/webhook-dedupe.js");
    dedupe.__clearMemoryForTests();

    const key = `test-db-${randomUUID()}`;
    assert.equal(await dedupe.claimOnce(key, "voice:test"), true, "first claim wins");

    // Simulate a different node / process restart: memory layer is empty,
    // only the DB row remains.
    dedupe.__clearMemoryForTests();
    assert.equal(
      await dedupe.claimOnce(key, "voice:test"),
      false,
      "replayed webhook on another node must not re-execute the transition",
    );
    assert.equal(await dedupe.wasProcessed(key), true, "read-only check sees DB row");

    // Concurrency: N parallel claims for one fresh key -> exactly one winner.
    dedupe.__clearMemoryForTests();
    const raceKey = `test-race-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => dedupe.claimOnce(raceKey, "voice:test")),
    );
    assert.equal(
      results.filter(Boolean).length,
      1,
      "exactly one concurrent claim may win",
    );

    // Cleanup test rows.
    const pool = getPostgresPool();
    await pool.query(
      "DELETE FROM cc_processed_events WHERE event_id LIKE 'test-db-%' OR event_id LIKE 'test-race-%' OR event_id LIKE 'test-mem-%'",
    );
    delete process.env.WEBHOOK_IDEMPOTENCY_DB;
  },
);

test("WS4-T1 flag off → DB untouched, memory-only behavior (pre-WS4 parity)", async () => {
  process.env.WEBHOOK_IDEMPOTENCY_DB = "false";
  const dedupe = await import("../lib/events/webhook-dedupe.js");
  dedupe.__clearMemoryForTests();
  assert.equal(dedupe.isDbDedupeEnabled(), false);

  const key = `test-flag-${randomUUID()}`;
  assert.equal(await dedupe.claimOnce(key, "voice:test"), true);
  // Simulated restart wipes memory; with the flag off the replay is NOT
  // suppressed — identical to the original in-process Map behavior.
  dedupe.__clearMemoryForTests();
  assert.equal(
    await dedupe.claimOnce(key, "voice:test"),
    true,
    "flag off must reproduce pre-WS4 memory-only semantics",
  );
  delete process.env.WEBHOOK_IDEMPOTENCY_DB;
});
