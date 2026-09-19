import { publishCommittedOutbox } from "./stream.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_LOCK = Object.freeze([741901, 11]);

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

export function acdRetentionConfig(environment = process.env) {
  return {
    enabled: enabled(environment.ACD_RETENTION_ENABLED),
    intervalMs:
      positiveNumber(environment.ACD_RETENTION_INTERVAL_MINUTES, 15) * 60 * 1000,
    outboxSafetyMs:
      positiveNumber(environment.ACD_OUTBOX_RETENTION_HOURS, 24) * HOUR_MS,
    streamReplayMs:
      positiveNumber(environment.ACD_STREAM_RETENTION_HOURS, 24) * HOUR_MS,
    eventHistoryMs:
      positiveNumber(environment.ACD_EVENT_RETENTION_DAYS, 90) * DAY_MS,
    batchSize: Math.min(
      50_000,
      Math.max(100, Math.floor(positiveNumber(environment.ACD_RETENTION_BATCH_SIZE, 5_000))),
    ),
  };
}

async function latestRetentionRun(db) {
  const result = await db.query(
    `SELECT MAX(last_run_at) AS last_run_at FROM acd_retention_watermarks`,
  );
  return result.rows[0]?.last_run_at || null;
}

async function deleteAcdOutbox(tx, cutoff, limit) {
  const result = await tx.query(
    `WITH candidates AS (
       SELECT o.seq
         FROM acd_outbox o
         JOIN acd_stream_events stream ON stream.outbox_seq = o.seq
         JOIN acd_events event ON event.id = o.event_id
         LEFT JOIN acd_work_items work ON work.id = event.work_item_id
        WHERE o.created_at < $1
          AND (event.work_item_id IS NULL OR work.terminal_at IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1
              FROM acd_webhook_events inbox
             WHERE inbox.status IN ('received','processing','retryable_failed')
               AND inbox.event_id = COALESCE(
                 event.payload->>'source_event_id',
                 event.payload->>'provider_event_id'
               )
          )
        ORDER BY o.seq
        LIMIT $2
     )
     DELETE FROM acd_outbox target
      USING candidates
      WHERE target.seq = candidates.seq
     RETURNING target.seq`,
    [cutoff, limit],
  );
  return result.rowCount;
}

async function deleteAcdStreamEvents(tx, cutoff, limit) {
  const result = await tx.query(
    `WITH candidates AS (
       SELECT stream.seq
         FROM acd_stream_events stream
         JOIN acd_events event ON event.id = stream.event_id
         LEFT JOIN acd_work_items work ON work.id = event.work_item_id
        WHERE stream.created_at < $1
          AND (event.work_item_id IS NULL OR work.terminal_at IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1
              FROM acd_webhook_events inbox
             WHERE inbox.status IN ('received','processing','retryable_failed')
               AND inbox.event_id = COALESCE(
                 event.payload->>'source_event_id',
                 event.payload->>'provider_event_id'
               )
          )
        ORDER BY stream.seq
        LIMIT $2
     )
     DELETE FROM acd_stream_events target
      USING candidates
      WHERE target.seq = candidates.seq
     RETURNING target.seq`,
    [cutoff, limit],
  );
  return result.rowCount;
}

async function deleteAcdEvents(tx, cutoff, limit) {
  const result = await tx.query(
    `WITH candidates AS (
       SELECT event.id
         FROM acd_events event
         LEFT JOIN acd_work_items work ON work.id = event.work_item_id
        WHERE event.occurred_at < $1
          AND (event.work_item_id IS NULL OR work.terminal_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM acd_outbox o WHERE o.event_id = event.id)
          AND NOT EXISTS (SELECT 1 FROM acd_stream_events s WHERE s.event_id = event.id)
          AND NOT EXISTS (
            SELECT 1
              FROM acd_webhook_events inbox
             WHERE inbox.status IN ('received','processing','retryable_failed')
               AND inbox.event_id = COALESCE(
                 event.payload->>'source_event_id',
                 event.payload->>'provider_event_id'
               )
          )
        ORDER BY event.id
        LIMIT $2
     )
     DELETE FROM acd_events target
      USING candidates
      WHERE target.id = candidates.id
     RETURNING target.id`,
    [cutoff, limit],
  );
  return result.rowCount;
}

async function sequenceBounds(tx, layer, previousLatest = 0) {
  const sequenceColumn = layer === "acd_events" ? "id" : "seq";
  const result = await tx.query(
    `SELECT MIN(${sequenceColumn})::text AS oldest,
            MAX(${sequenceColumn})::text AS latest
       FROM ${layer}`,
  );
  const latest = result.rows[0]?.latest == null
    ? String(previousLatest || 0)
    : String(result.rows[0].latest);
  return {
    oldest: result.rows[0]?.oldest == null ? null : String(result.rows[0].oldest),
    latest,
  };
}

async function recordWatermark(tx, {
  layer,
  cutoff,
  deleted,
  previousLatest,
  metadata,
}) {
  const bounds = await sequenceBounds(tx, layer, previousLatest);
  await tx.query(
    `INSERT INTO acd_retention_watermarks
       (layer, last_run_at, cutoff_at, last_deleted_count,
        total_deleted_count, oldest_retained_sequence, latest_sequence, metadata)
     VALUES ($1, clock_timestamp(), $2, $3, $3, $4, $5, $6::jsonb)
     ON CONFLICT (layer) DO UPDATE SET
       last_run_at = EXCLUDED.last_run_at,
       cutoff_at = EXCLUDED.cutoff_at,
       last_deleted_count = EXCLUDED.last_deleted_count,
       total_deleted_count = acd_retention_watermarks.total_deleted_count
         + EXCLUDED.last_deleted_count,
       oldest_retained_sequence = EXCLUDED.oldest_retained_sequence,
       latest_sequence = GREATEST(
         acd_retention_watermarks.latest_sequence,
         EXCLUDED.latest_sequence
       ),
       metadata = EXCLUDED.metadata`,
    [
      layer,
      cutoff,
      deleted,
      bounds.oldest,
      bounds.latest,
      JSON.stringify(metadata || {}),
    ],
  );
  return bounds;
}

/**
 * Prune the three ACD history layers independently. The function is safe to
 * invoke on every reconciler tick: a database watermark throttles work and an
 * advisory transaction lock permits only one node to prune at a time.
 */
export async function runAcdRetentionCycle(
  pool,
  { force = false, now = new Date(), config = acdRetentionConfig() } = {},
) {
  if (!pool || (!force && !config.enabled)) {
    return { enabled: Boolean(config?.enabled), ran: false };
  }
  const previousRun = await latestRetentionRun(pool);
  if (
    !force &&
    previousRun &&
    now.getTime() - new Date(previousRun).getTime() < config.intervalMs
  ) {
    return { enabled: true, ran: false, reason: "interval" };
  }

  // Outbox rows must first be materialized into the committed stream sequence.
  await publishCommittedOutbox(pool, { limit: config.batchSize });

  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const lock = await tx.query(
      `SELECT pg_try_advisory_xact_lock($1, $2) AS acquired`,
      RETENTION_LOCK,
    );
    if (!lock.rows[0]?.acquired) {
      await tx.query("ROLLBACK");
      return { enabled: true, ran: false, reason: "lock" };
    }

    const layers = [
      {
        layer: "acd_outbox",
        ageMs: config.outboxSafetyMs,
        remove: deleteAcdOutbox,
      },
      {
        layer: "acd_stream_events",
        ageMs: config.streamReplayMs,
        remove: deleteAcdStreamEvents,
      },
      {
        layer: "acd_events",
        ageMs: config.eventHistoryMs,
        remove: deleteAcdEvents,
      },
    ];
    const results = {};
    for (const item of layers) {
      const prior = await tx.query(
        `SELECT latest_sequence FROM acd_retention_watermarks WHERE layer = $1`,
        [item.layer],
      );
      const cutoff = new Date(now.getTime() - item.ageMs);
      const deleted = await item.remove(tx, cutoff, config.batchSize);
      const bounds = await recordWatermark(tx, {
        layer: item.layer,
        cutoff,
        deleted,
        previousLatest: prior.rows[0]?.latest_sequence || 0,
        metadata: { age_ms: item.ageMs, batch_size: config.batchSize },
      });
      results[item.layer] = { deleted, cutoff, ...bounds };
    }
    await tx.query("COMMIT");
    return { enabled: true, ran: true, layers: results };
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}
