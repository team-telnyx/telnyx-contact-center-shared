// Durable webhook inbox (the internal documentation §5.1).
// Intake persists first and acks fast; leased workers apply events. A crash
// after claim leaves a retryable row, never a false 'processed' marker.

import { createHash, randomUUID } from "node:crypto";

export const INBOX_LEASE_MS = 30_000;
export const INBOX_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
function payloadHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload ?? {})).digest("hex").slice(0, 32);
}

/**
 * Persist a webhook event in the single-authority Core inbox.
 */
export async function persistWebhookEvent(db, event) {
  const { eventId, provider = "telnyx", eventType, occurredAt = null, payload = {} } = event;
  if (!eventId) throw new Error("persistWebhookEvent: eventId is required");
  if (!eventType) throw new Error("persistWebhookEvent: eventType is required");
  const result = await db.query(
    `INSERT INTO acd_webhook_events
       (event_id, provider, event_type, occurred_at, payload, payload_hash, source_route, source_flow_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [
      eventId,
      provider,
      eventType,
      occurredAt,
      JSON.stringify(payload),
      payloadHash(payload),
      event.sourceRoute || null,
      event.sourceFlowId || null,
    ],
  );
  return { inserted: Boolean(result.rows[0]) };
}

export async function hasInboxEvent(db, eventId) {
  if (!eventId) return false;
  const result = await db.query(
    `SELECT 1 FROM acd_webhook_events WHERE event_id = $1`,
    [eventId],
  );
  return result.rowCount > 0;
}

/**
 * Claim one known event for inline handling or provider-redelivery recovery.
 * A duplicate delivery may resume a received/retryable row, but it can never
 * steal a live lease from another node. Terminal rows return null.
 */
export async function claimInboxEvent(
  db,
  { eventId, node, leaseMs = INBOX_LEASE_MS },
) {
  if (!eventId) throw new Error("claimInboxEvent: eventId is required");
  if (!node) throw new Error("claimInboxEvent: node is required");
  const result = await db.query(
    `UPDATE acd_webhook_events e
        SET status = 'processing',
            lease_owner = $2,
            lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
            attempt_count = e.attempt_count + 1
      WHERE e.event_id = $1
        AND (
          (
            e.status IN ('received', 'retryable_failed')
            AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= now())
          )
          OR (e.status = 'processing' AND e.lease_expires_at < now())
        )
      RETURNING e.*`,
    [eventId, node, String(leaseMs)],
  );
  return result.rows[0] || null;
}

/** Claim a batch of processable events with a lease. */
export async function claimInboxBatch(
  db,
  {
    node,
    limit = 20,
    leaseMs = INBOX_LEASE_MS,
  },
) {
  if (!node) throw new Error("claimInboxBatch: node is required");
  const result = await db.query(
    `UPDATE acd_webhook_events e
        SET status = 'processing',
            lease_owner = $1,
            lease_expires_at = now() + ($2::text || ' milliseconds')::interval,
            attempt_count = e.attempt_count + 1
      WHERE e.event_id IN (
        SELECT event_id FROM acd_webhook_events
         WHERE (
                 (
                   status IN ('received', 'retryable_failed')
                   AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                 )
                 OR (status = 'processing' AND lease_expires_at < now())
               )
         ORDER BY received_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
      )
      RETURNING e.*`,
    [node, String(leaseMs), limit],
  );
  return result.rows;
}

const TERMINAL_OUTCOMES = new Set(["applied", "noop", "unmatched"]);

// How long a Core-owned event may wait for its leg to appear before it becomes
// an observable unmatched terminal event.
export const INBOX_CORRELATION_WINDOW_MS = 5 * 60 * 1000;

export async function completeInboxEvent(db, eventId, outcome, { node } = {}) {
  if (!TERMINAL_OUTCOMES.has(outcome)) {
    throw new Error(`completeInboxEvent: illegal outcome ${outcome}`);
  }
  if (!node) throw new Error("completeInboxEvent: node is required");
  // A leg event can precede the dial response or initiated event. Retry
  // correlation for five minutes, independently of provider effect retries.
  if (outcome === "unmatched") {
    const result = await db.query(
      `UPDATE acd_webhook_events
          SET status = CASE WHEN received_at < now() - ($3::text || ' milliseconds')::interval THEN 'unmatched' ELSE 'retryable_failed' END,
              next_attempt_at = now() + interval '2 seconds',
              processed_at = CASE WHEN received_at < now() - ($3::text || ' milliseconds')::interval THEN now() ELSE NULL END,
              last_error = 'Awaiting leg correlation', lease_owner = NULL, lease_expires_at = NULL
        WHERE event_id = $1 AND status = 'processing' AND lease_owner = $2
        RETURNING event_id`, [eventId, node, String(INBOX_CORRELATION_WINDOW_MS)]);
    return Boolean(result.rowCount);
  }
  const result = await db.query(
    `UPDATE acd_webhook_events
        SET status = $2, processed_at = now(), lease_owner = NULL, lease_expires_at = NULL,
            last_error = NULL
      WHERE event_id = $1 AND status = 'processing' AND lease_owner = $3
      RETURNING event_id`,
    [eventId, outcome, node],
  );
  return Boolean(result.rows[0]);
}

export async function failInboxEvent(
  db,
  eventId,
  error,
  { node, maxAttempts = INBOX_MAX_ATTEMPTS } = {},
) {
  if (!node) throw new Error("failInboxEvent: node is required");
  const message = String(error?.message || error).slice(0, 500);
  const result = await db.query(
    `UPDATE acd_webhook_events
        SET status = CASE WHEN attempt_count >= $3 THEN 'dead' ELSE 'retryable_failed' END,
            last_error = $2,
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_attempt_at = now() + (LEAST($4 * POWER(2, attempt_count), $5)::text || ' milliseconds')::interval,
            processed_at = CASE WHEN attempt_count >= $3 THEN now() ELSE processed_at END
      WHERE event_id = $1 AND status = 'processing' AND lease_owner = $6
      RETURNING event_id`,
    [eventId, message, maxAttempts, BACKOFF_BASE_MS, BACKOFF_MAX_MS, node],
  );
  return Boolean(result.rows[0]);
}

export async function renewInboxLease(
  db,
  eventId,
  { node, leaseMs = INBOX_LEASE_MS } = {},
) {
  if (!eventId) throw new Error("renewInboxLease: eventId is required");
  if (!node) throw new Error("renewInboxLease: node is required");
  const result = await db.query(
    `UPDATE acd_webhook_events
        SET lease_expires_at = now() + ($3::text || ' milliseconds')::interval
      WHERE event_id = $1 AND status = 'processing' AND lease_owner = $2
      RETURNING event_id`,
    [eventId, node, String(leaseMs)],
  );
  return Boolean(result.rows[0]);
}

/** Keep one claimed event leased while an async handler is still running. */
export function startInboxLeaseHeartbeat(
  db,
  eventId,
  { node, leaseMs = INBOX_LEASE_MS } = {},
) {
  if (!eventId) throw new Error("startInboxLeaseHeartbeat: eventId is required");
  if (!node) throw new Error("startInboxLeaseHeartbeat: node is required");

  let stopped = false;
  let leaseLost = false;
  let heartbeatPromise = Promise.resolve();
  const heartbeatEveryMs = Math.max(10, Math.floor(leaseMs / 3));
  const heartbeat = setInterval(() => {
    if (stopped) return;
    heartbeatPromise = heartbeatPromise
      .then(async () => {
        const renewed = await renewInboxLease(db, eventId, { node, leaseMs });
        if (!renewed) leaseLost = true;
      })
      .catch(() => {
        // A transient DB error does not prove ownership loss. The owner-fenced
        // complete/fail update remains the final authority.
      });
  }, heartbeatEveryMs);
  heartbeat.unref?.();

  return {
    renew: () => renewInboxLease(db, eventId, { node, leaseMs }),
    async stop() {
      stopped = true;
      clearInterval(heartbeat);
      await heartbeatPromise;
      return !leaseLost;
    },
  };
}

/**
 * One worker pass: claim → handler(event) → complete/fail.
 * handler returns 'applied' | 'noop' | 'unmatched'; a throw marks the event
 * retryable (dead after maxAttempts). Returns per-outcome counts.
 */
export async function runInboxWorkerOnce(
  pool,
  {
    node = "inbox-0",
    handler,
    limit = 20,
    leaseMs = INBOX_LEASE_MS,
  },
) {
  if (typeof handler !== "function") throw new Error("runInboxWorkerOnce: handler is required");
  const counts = { claimed: 0, applied: 0, noop: 0, unmatched: 0, failed: 0, leaseLost: 0 };
  for (let index = 0; index < limit; index += 1) {
    // Claim immediately before execution so later rows never spend their lease
    // waiting behind earlier provider calls. A per-event token fences stale
    // completion and failure updates from every other worker/node.
    const leaseOwner = `${node}:${randomUUID()}`;
    const [event] = await claimInboxBatch(pool, {
      node: leaseOwner,
      limit: 1,
      leaseMs,
    });
    if (!event) break;
    counts.claimed += 1;

    const leaseHeartbeat = startInboxLeaseHeartbeat(pool, event.event_id, {
      node: leaseOwner,
      leaseMs,
    });

    try {
      const outcome =
        (await handler(event, {
          leaseOwner,
          renewLease: leaseHeartbeat.renew,
        })) || "noop";
      const leaseHeld = await leaseHeartbeat.stop();
      if (!leaseHeld) {
        counts.leaseLost += 1;
        continue;
      }
      const completed = await completeInboxEvent(pool, event.event_id, outcome, {
        node: leaseOwner,
      });
      if (completed) counts[outcome] = (counts[outcome] || 0) + 1;
      else counts.leaseLost += 1;
    } catch (error) {
      const leaseHeld = await leaseHeartbeat.stop();
      if (!leaseHeld) {
        counts.leaseLost += 1;
        continue;
      }
      const failed = await failInboxEvent(pool, event.event_id, error, {
        node: leaseOwner,
      });
      if (failed) counts.failed += 1;
      else counts.leaseLost += 1;
    }
  }
  return counts;
}
