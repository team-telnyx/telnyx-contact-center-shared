/**
 * WS4-T1 — Replay-safe dedupe for the voice webhook route.
 *
 * Replaces the in-process `executedTransitions` / `completedFlows` Maps with
 * a two-layer guard:
 *
 *   L1 — in-memory map with the same 5-minute TTL semantics as before
 *        (fast path; preserves existing single-node behavior exactly).
 *   L2 — DB-backed idempotency via cc_processed_events (cross-node /
 *        cross-restart replay safety), guarded by WEBHOOK_IDEMPOTENCY_DB
 *        (default: enabled, consistent with the contact-center webhook
 *        handler which is already DB-backed).
 *
 * Failure policy: if the DB is unreachable the helper degrades to the L1
 * memory answer (fail-open) — identical to the pre-WS4 behavior — and never
 * throws into the webhook path.
 */

import { getPostgresPool } from "../postgres.mjs";
import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

const TTL_MS = 5 * 60 * 1000;
const PRUNE_PROBABILITY = 0.01;
const DB_PRUNE_OLDER_THAN_HOURS = 24;

const dedupeLogger = createDiagnosticLogger("platform.webhook-dedupe", {
  config: {
    globalLevel: process.env.LOG_LEVEL || "info",
    topicLevels: {
      "platform.webhook-dedupe": process.env.LOG_WEBHOOK_DEDUPE_LEVEL || "warn",
    },
  },
});

const memory = (globalThis.__cc_webhook_dedupe ||= {
  entries: new Map(), // Map<key, timestamp>
});

export function isDbDedupeEnabled() {
  return (
    String(process.env.WEBHOOK_IDEMPOTENCY_DB ?? "true").toLowerCase() !==
    "false"
  );
}

function pruneMemory(now = Date.now()) {
  const cutoff = now - TTL_MS;
  for (const [key, timestamp] of memory.entries.entries()) {
    if (timestamp < cutoff) memory.entries.delete(key);
  }
}

function memoryHas(key, now = Date.now()) {
  const timestamp = memory.entries.get(key);
  if (timestamp === undefined) return false;
  if (timestamp < now - TTL_MS) {
    memory.entries.delete(key);
    return false;
  }
  return true;
}

async function dbClaim(key, kind) {
  const pool = getPostgresPool();
  if (!pool) return null;
  const result = await pool.query(
    `INSERT INTO cc_processed_events (event_id, kind)
     VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [key, kind],
  );
  return (result.rows || []).length > 0; // true = first time (claimed)
}

async function dbHas(key) {
  const pool = getPostgresPool();
  if (!pool) return null;
  const result = await pool.query(
    `SELECT 1 FROM cc_processed_events WHERE event_id = $1 LIMIT 1`,
    [key],
  );
  return (result.rows || []).length > 0;
}

function maybePruneDb() {
  if (Math.random() >= PRUNE_PROBABILITY) return;
  const pool = getPostgresPool();
  if (!pool) return;
  pool
    .query(
      `DELETE FROM cc_processed_events
        WHERE kind LIKE 'voice:%'
          AND created_at < now() - ($1::text || ' hours')::interval`,
      [DB_PRUNE_OLDER_THAN_HOURS],
    )
    .catch((err) => {
      dedupeLogger.warn("webhook_dedupe_prune_failed", {
        error: err?.message || String(err),
      });
    });
}

/**
 * Atomically claim a key. Returns true exactly once per key (per TTL window
 * in memory; per row lifetime in the DB). Safe under concurrency: the DB
 * INSERT … ON CONFLICT is the cross-node arbiter when enabled.
 */
export async function claimOnce(key, kind) {
  if (!key) throw new Error("key is required");
  const now = Date.now();
  pruneMemory(now);

  const memoryFirst = !memoryHas(key, now);
  if (memoryFirst) memory.entries.set(key, now);

  if (!isDbDedupeEnabled()) return memoryFirst;

  try {
    const dbFirst = await dbClaim(key, kind || "voice:event");
    maybePruneDb();
    if (dbFirst === null) return memoryFirst; // DB not configured → memory
    // Memory may have expired (TTL/restart) while the DB row persists; the
    // DB answer wins so replays after restart are still suppressed.
    return memoryFirst && dbFirst;
  } catch (err) {
    dedupeLogger.warn("webhook_dedupe_db_claim_failed", {
      key,
      kind,
      error: err?.message || String(err),
    });
    return memoryFirst; // fail-open: same behavior as pre-WS4 memory dedupe
  }
}

/** Read-only check (no claim). */
export async function wasProcessed(key) {
  if (!key) throw new Error("key is required");
  const now = Date.now();
  if (memoryHas(key, now)) return true;
  if (!isDbDedupeEnabled()) return false;
  try {
    const inDb = await dbHas(key);
    return inDb === true;
  } catch (err) {
    dedupeLogger.warn("webhook_dedupe_db_check_failed", {
      key,
      error: err?.message || String(err),
    });
    return false; // fail-open
  }
}

/** Mark a key as processed without caring whether it was already set. */
export async function markProcessed(key, kind) {
  await claimOnce(key, kind);
}

/** Test hook: clear the in-memory layer. */
export function __clearMemoryForTests() {
  memory.entries.clear();
}
