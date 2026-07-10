// Regression tests for lib/seed-default-queue.mjs — the "Sales" queue seed
// that ships alongside the Default Call Flow (lib/seed-default-call-flow.mjs)
// so a fresh deployment's `enqueue` node resolves to a real queue by name.
//
// Uses the same mock-Pool + global.__pg_pool injection pattern as
// tests/seed-default-owner.test.mjs — see that file's header comment for why
// the cache-slot mutation (not reassignment) is required.
import { test } from "node:test";
import assert from "node:assert/strict";

const WRAPUP_IDS = [
  "default", "general-inquiry", "billing-problem", "technical-issue",
  "complaint", "order-completed", "service-request", "account-update",
  "general-feedback", "sale-lead", "no-answer", "voicemail",
  "wrong-number", "dnc-request", "not-interested", "callback-scheduled",
  "dropped-call",
];

function makeMockPool({ existingQueueId = null, knownWrapupIds = WRAPUP_IDS, preExistingQueues = [] } = {}) {
  const state = {
    queues: [
      ...(existingQueueId ? [{ id: existingQueueId, name: "Sales" }] : []),
      ...preExistingQueues,
    ],
    queueWrapupLinks: [],
  };
  const pool = {
    async connect() {
      return {
        async query(text, params = []) {
          const sql = text.trim();
          if (sql.startsWith("SET statement_timeout") || sql.startsWith("RESET statement_timeout")) {
            return { rows: [] };
          }
          if (sql.startsWith("SELECT id FROM cc_queues WHERE id")) {
            const [id] = params;
            const found = state.queues.find((q) => q.id === id);
            return { rows: found ? [found] : [] };
          }
          if (sql.startsWith("SELECT id, name FROM cc_queues WHERE UPPER(name)")) {
            const [name, excludeId] = params;
            const matches = state.queues.filter(
              (q) => q.name && q.name.toUpperCase() === name.toUpperCase() && q.id !== excludeId
            );
            return { rows: matches };
          }
          if (sql.startsWith("INSERT INTO cc_queues")) {
            const [id, name] = params;
            state.queues.push({ id, name, params });
            return { rows: [] };
          }
          if (sql.startsWith("SELECT id FROM cc_wrapup_codes WHERE id = ANY")) {
            const [ids] = params;
            const rows = ids.filter((id) => knownWrapupIds.includes(id)).map((id) => ({ id }));
            return { rows };
          }
          if (sql.startsWith("INSERT INTO cc_queue_wrapup_codes")) {
            const [queueId, wrapupId] = params;
            state.queueWrapupLinks.push({ queueId, wrapupId });
            return { rows: [] };
          }
          throw new Error(`Unmocked query: ${sql}`);
        },
        release() {},
      };
    },
  };
  return { pool, state };
}

async function withMockPool(pool, fn) {
  await import("../lib/postgres.mjs");
  const cached = global.__pg_pool;
  assert.ok(cached, "expected postgres.mjs to have initialized global.__pg_pool on import");
  const prev = { pool: cached.pool, status: cached.status, listenersAttached: cached.listenersAttached };
  cached.pool = pool;
  cached.status = "connected";
  cached.listenersAttached = true;
  try {
    await fn();
  } finally {
    cached.pool = prev.pool;
    cached.status = prev.status;
    cached.listenersAttached = prev.listenersAttached;
  }
}

test("seedDefaultQueue: creates the Sales queue row + links all 17 wrapup codes when none exists yet", async () => {
  const { pool, state } = makeMockPool();
  await withMockPool(pool, async () => {
    const { seedDefaultQueue, SEEDED_DEFAULT_QUEUE_ID } = await import("../lib/seed-default-queue.mjs");
    const ok = await seedDefaultQueue();
    assert.equal(ok, true);
    assert.equal(state.queues.length, 1);
    assert.equal(state.queues[0].id, SEEDED_DEFAULT_QUEUE_ID);
    assert.equal(state.queueWrapupLinks.length, WRAPUP_IDS.length);
    const linkedIds = state.queueWrapupLinks.map((l) => l.wrapupId).sort();
    assert.deepEqual(linkedIds, [...WRAPUP_IDS].sort());
  });
});

test("seedDefaultQueue: is idempotent — a second run against an existing row inserts nothing new", async () => {
  const { pool, state } = makeMockPool();
  await withMockPool(pool, async () => {
    const { seedDefaultQueue } = await import("../lib/seed-default-queue.mjs");
    await seedDefaultQueue();
    const afterFirst = state.queues.length;
    const linksAfterFirst = state.queueWrapupLinks.length;
    const ok = await seedDefaultQueue();
    assert.equal(ok, true);
    assert.equal(state.queues.length, afterFirst);
    assert.equal(state.queueWrapupLinks.length, linksAfterFirst);
  });
});

test("seedDefaultQueue: skips ON CONFLICT short-circuit entirely when the queue row already exists (no wrapup insert attempted)", async () => {
  const { seedDefaultQueue, SEEDED_DEFAULT_QUEUE_ID } = await import("../lib/seed-default-queue.mjs");
  const { pool, state } = makeMockPool({ existingQueueId: SEEDED_DEFAULT_QUEUE_ID });
  await withMockPool(pool, async () => {
    const ok = await seedDefaultQueue();
    assert.equal(ok, true);
    assert.equal(state.queues.length, 1);
    assert.equal(state.queueWrapupLinks.length, 0);
  });
});

test("seedDefaultQueue: skips linking any wrapup code ids that aren't seeded yet, without failing the whole run", async () => {
  const { pool, state } = makeMockPool({ knownWrapupIds: ["default", "general-inquiry"] });
  await withMockPool(pool, async () => {
    const { seedDefaultQueue } = await import("../lib/seed-default-queue.mjs");
    const ok = await seedDefaultQueue();
    assert.equal(ok, true);
    assert.equal(state.queues.length, 1);
    assert.equal(state.queueWrapupLinks.length, 2);
    const linkedIds = state.queueWrapupLinks.map((l) => l.wrapupId).sort();
    assert.deepEqual(linkedIds, ["default", "general-inquiry"]);
  });
});

test("seedDefaultQueue: returns false without throwing when no Postgres pool is available", async () => {
  await import("../lib/postgres.mjs");
  const cached = global.__pg_pool;
  const prev = { pool: cached.pool, status: cached.status, listenersAttached: cached.listenersAttached };
  cached.pool = null;
  cached.status = "disconnected";
  cached.listenersAttached = false;
  try {
    const { seedDefaultQueue } = await import("../lib/seed-default-queue.mjs");
    const ok = await seedDefaultQueue();
    assert.equal(ok, false);
  } finally {
    cached.pool = prev.pool;
    cached.status = prev.status;
    cached.listenersAttached = prev.listenersAttached;
  }
});

test("REGRESSION (Codex bot finding on PR #1200): does NOT create a duplicate queue when a same-name queue already exists under different casing (e.g. admin-created 'SALES' vs this seed's 'Sales')", async () => {
  const { pool, state } = makeMockPool({
    preExistingQueues: [{ id: "admin-created-sales-id", name: "SALES" }],
  });
  await withMockPool(pool, async () => {
    const { seedDefaultQueue } = await import("../lib/seed-default-queue.mjs");
    const ok = await seedDefaultQueue();
    assert.equal(ok, true);
    // Still exactly one queue — the seed must NOT have inserted a second
    // "Sales" row alongside the admin's pre-existing "SALES" row, which
    // would create a split-brain state where case-insensitive lookups
    // (PgDb.findQueueByName) could non-deterministically match either.
    assert.equal(state.queues.length, 1);
    assert.equal(state.queues[0].name, "SALES");
    assert.equal(state.queueWrapupLinks.length, 0, "must not link wrapup codes to a queue it didn't create");
  });
});

test("seedDefaultQueue: name-collision check is case-insensitive in both directions (lowercase pre-existing queue also blocks the seed)", async () => {
  const { pool, state } = makeMockPool({
    preExistingQueues: [{ id: "some-other-id", name: "sales" }],
  });
  await withMockPool(pool, async () => {
    const { seedDefaultQueue } = await import("../lib/seed-default-queue.mjs");
    const ok = await seedDefaultQueue();
    assert.equal(ok, true);
    assert.equal(state.queues.length, 1);
  });
});
