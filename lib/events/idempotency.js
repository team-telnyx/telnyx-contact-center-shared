import { getPostgresPool } from "../postgres.mjs";

function resolvePool(pool) {
  const resolved = pool || getPostgresPool();
  if (!resolved) {
    throw new Error("Postgres pool is not available");
  }
  return resolved;
}

export async function alreadyProcessed(eventId, kind, opts = {}) {
  if (!eventId) {
    throw new Error("eventId is required");
  }
  if (!kind) {
    throw new Error("kind is required");
  }

  const pool = resolvePool(opts.pool);
  const result = await pool.query(
    `INSERT INTO cc_processed_events (event_id, kind)
     VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, kind],
  );

  return result.rowCount === 0 || result.rows.length === 0;
}

export async function pruneProcessedEvents(opts = {}) {
  const pool = resolvePool(opts.pool);
  const olderThanHours = Number.isFinite(Number(opts.olderThanHours))
    ? Number(opts.olderThanHours)
    : 24;

  const result = await pool.query(
    `DELETE FROM cc_processed_events
      WHERE created_at < now() - ($1::text || ' hours')::interval`,
    [olderThanHours],
  );

  return result.rowCount || 0;
}
