// ACD reconciler (the internal documentation §5.5) — ALWAYS ON, leader-elected,
// no enabling flag. Every correction emits an event visible to supervisors:
// a healthy system shows zero corrections; any sustained non-zero rate is an
// alarm carrying the exact defect.

import { NATIVE_LIFECYCLE_CHANNELS } from "./channel-registry.mjs";
import { appendEvent } from "./events.mjs";
import { expireAgentSessions } from "./sessions.mjs";
import { alarmUnconfirmedDirectIntents, settleEndedDirectIntents, sweepAbandonedDirectIntents } from './direct-capacity.mjs';
import { startUnresolvedTargetCleanup } from "./sagas/target-cleanup.mjs";
import "./sagas/index.mjs";
import { sweepDueSagas, sweepStalledSagas } from "./saga-engine.mjs";
import { releaseReservation, resolveOffer } from "./reservations.mjs";
import { setWorkflowState } from "./agent-state.mjs";
import { applyTransition, checkInvariants } from "./lifecycle.mjs";
import { finalizeTimedOutOutboundAttempt } from "./outbound-capacity.mjs";
import { runAcdRetentionCycle } from "./retention.mjs";

// Advisory-lock identity for leadership (classid, objid) — ACD namespace.
export const RECONCILER_LOCK = Object.freeze([14501, 1]);
export const RECONCILER_TICK_MS = 10_000;

/**
 * Sweep 1 (after saga deadlines): ORPHANED execution claims — reserved/ringing
 * reservations whose lease expired and which no running/compensating saga
 * owns. This covers the crash window between routeOne's commit and
 * startConnectSaga. The owning saga's own deadline handles the non-orphan
 * case; 'active' reservations are NEVER touched by age (design principle 8).
 */
export async function sweepOrphanedClaims(pool, { node = "reconciler", limit = 20 } = {}) {
  const client = await pool.connect();
  const corrected = [];
  try {
    await client.query("BEGIN");
    const orphans = await client.query(
      `SELECT r.id, r.agent_id, r.work_item_id
         FROM acd_reservations r
        WHERE r.state IN ('reserved', 'ringing')
          AND r.lease_expires_at < now()
          -- Either nobody ever owned the claim, or the owning saga already
          -- finished without releasing it (a crash mid-cancel, or an older
          -- node that did not know the channel).
          AND (r.owner_saga_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM acd_sagas owner
             WHERE owner.id = r.owner_saga_id
               AND owner.state IN ('running', 'compensating')
          ))
          AND NOT EXISTS (
            SELECT 1 FROM acd_sagas s
             WHERE s.work_item_id = r.work_item_id
               AND s.state IN ('running', 'compensating')
          )
        ORDER BY r.lease_expires_at
        LIMIT $1
        FOR UPDATE OF r SKIP LOCKED`,
      [limit],
    );

    for (const orphan of orphans.rows) {
      await releaseReservation(client, orphan.id, "lease_expired_orphan", { actor: "reconciler" });
      if (orphan.work_item_id) {
        await client.query(
          `UPDATE acd_offers SET state = 'cancelled', outcome_reason = 'orphaned_claim',
                  terminal_at = now()
            WHERE work_item_id = $1 AND state IN ('created', 'ringing')`,
          [orphan.work_item_id],
        );
        const workItem = (
          await client.query(`SELECT state FROM acd_work_items WHERE id = $1 FOR UPDATE`, [
            orphan.work_item_id,
          ])
        ).rows[0];
        if (workItem?.state === "offered") {
          await applyTransition(client, {
            workItemId: orphan.work_item_id,
            to: "queued",
            eventType: "work_item_requeued",
            payload: { reason: "orphaned_claim", reservation_id: orphan.id },
            actor: "reconciler",
          });
        }
      }
      if (orphan.agent_id) {
        const stillBusy = await client.query(
          `SELECT 1 FROM acd_reservations
            WHERE agent_id = $1 AND state <> 'released'
              AND (state = 'active' OR owner_saga_id IS NOT NULL OR lease_expires_at > now())
            LIMIT 1`,
          [orphan.agent_id],
        );
        if (stillBusy.rows.length === 0) {
          await setWorkflowState(client, orphan.agent_id, "idle", {
            actor: "reconciler",
            workItemId: orphan.work_item_id,
            reason: "orphaned_claim_released",
          });
        }
      }
      await appendEvent(client, {
        workItemId: orphan.work_item_id,
        agentId: orphan.agent_id,
        type: "reconciler_corrected",
        payload: { kind: "orphaned_claim", reservation_id: orphan.id },
        actor: "reconciler",
      });
      corrected.push(orphan.id);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return corrected.length;
}

/** Sweep 2: wrap-up sessions past their deadline → auto-close to idle. */
export async function sweepWrapupDeadlines(pool) {
  const client = await pool.connect();
  let closed = 0;
  try {
    await client.query("BEGIN");
    const due = await client.query(
      `SELECT agent_id FROM acd_agent_state a
        WHERE (workflow_state = 'wrapup' AND workflow_deadline_at < now()
            AND NOT EXISTS (SELECT 1 FROM acd_work_items w WHERE w.id=a.workflow_work_item_id AND w.channel = ANY($1::text[])))
          OR EXISTS (SELECT 1 FROM acd_segments s WHERE s.agent_id = a.agent_id
            AND s.wrapup_deadline_at < now() AND s.wrapup_ended_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM acd_work_items w WHERE w.id=s.work_item_id AND w.channel = ANY($1::text[])))
        FOR UPDATE SKIP LOCKED`,
      [NATIVE_LIFECYCLE_CHANNELS],
    );
    for (const row of due.rows) {
      const segments = await client.query(
        `UPDATE acd_segments s
            SET wrapup_ended_at = now(), wrapup_code_id = COALESCE(wrapup_code_id, 'auto_timeout')
          WHERE s.agent_id = $1 AND s.kind = 'agent'
            AND NOT EXISTS (SELECT 1 FROM acd_work_items w WHERE w.id=s.work_item_id AND w.channel = ANY($2::text[]))
            AND s.ended_at IS NOT NULL AND s.wrapup_ended_at IS NULL
            AND (s.wrapup_deadline_at < now() OR (s.wrapup_deadline_at IS NULL AND s.work_item_id = (
              SELECT work_item_id FROM acd_events
               WHERE agent_id = $1 AND type = 'agent_workflow_changed'
                 AND payload->>'workflow_state' = 'wrapup'
               ORDER BY id DESC LIMIT 1
            )))
          RETURNING s.id, s.work_item_id, s.seq, s.outcome, s.wrapup_code_id`,
        [row.agent_id, NATIVE_LIFECYCLE_CHANNELS],
      );
      for (const segment of segments.rows) {
        const workItem = (await client.query(
          `SELECT w.outbound_attempt_id, w.state, w.terminal_at,
                  NOT EXISTS (
                    SELECT 1 FROM acd_segments newer
                     WHERE newer.work_item_id = w.id
                       AND newer.kind = 'agent'
                       AND newer.seq > $2
                  ) AS final_agent_segment
             FROM acd_work_items w
            WHERE w.id = $1`,
          [segment.work_item_id, segment.seq],
        )).rows[0];
        if (workItem?.outbound_attempt_id && workItem.final_agent_segment) {
          await finalizeTimedOutOutboundAttempt(client, workItem.outbound_attempt_id);
        }
        await appendEvent(client, {
          workItemId: segment.work_item_id, agentId: row.agent_id,
          type: "wrapup_completed",
          payload: { segment_id: segment.id, wrapup_code_id: segment.wrapup_code_id, reason: "auto_timeout" },
          actor: "reconciler",
        });
      }
      await setWorkflowState(client, row.agent_id, "idle", {
        actor: "reconciler",
        reason: "wrapup_deadline_expired",
      });
      await appendEvent(client, {
        agentId: row.agent_id,
        type: "reconciler_corrected",
        payload: { kind: "wrapup_auto_closed" },
        actor: "reconciler",
      });
      closed += 1;
    }
    // A provider hangup can commit concurrently with the wrap-up timeout.
    // Retrying all eligible rows on every tick closes that visibility race.
    const outboundLedger = (await client.query(
      `SELECT to_regclass('outbound_attempt_ledger') AS name`,
    )).rows[0]?.name;
    if (outboundLedger) await finalizeTimedOutOutboundAttempt(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return closed;
}

/** Sweep 3: invariant violations become loud, typed alarm events. */
export async function sweepInvariants(pool) {
  const violations = await checkInvariants(pool);
  const names = Object.keys(violations);
  if (names.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const name of names) {
      await appendEvent(client, {
        type: "invariant_violation",
        payload: { invariant: name, count: violations[name].length, sample: violations[name].slice(0, 3) },
        actor: "reconciler",
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return names.length;
}

/** One full reconciler tick, in design §5.5 priority order. */
export async function runReconcilerTick(pool, { provider, node = "reconciler" } = {}) {
  const results = {};
  await expireAgentSessions(pool);
  // Session expiry must land before this sweep: a browser that stopped
  // heartbeating is the evidence that an unstarted direct call owns no media.
  results.abandonedDirectIntents = await sweepAbandonedDirectIntents(pool, { provider, node });
  // Leg evidence closes intents before the alarm below can mistake a finished
  // call for one whose evidence never arrived.
  results.settledDirectIntents = await settleEndedDirectIntents(pool, { node });
  results.unconfirmedDirectCalls = await alarmUnconfirmedDirectIntents(pool);
  results.wrapupsClosed = await sweepWrapupDeadlines(pool);
  results.sagaDeadlines = await sweepDueSagas(pool, { provider, node });
  await startUnresolvedTargetCleanup(pool);
  results.stalledDriven = await sweepStalledSagas(pool, { provider, node });
  results.orphanedClaims = await sweepOrphanedClaims(pool, { node });
  results.invariantAlarms = await sweepInvariants(pool);
  results.retention = await runAcdRetentionCycle(pool);
  return results;
}

/**
 * Leadership: a dedicated client holds pg_try_advisory_lock for its lifetime.
 * Returns { acquired, release } — release() frees the lock and the client.
 */
export async function acquireReconcilerLeadership(pool) {
  const client = await pool.connect();
  let alive = true;
  let released = false;
  const lost = () => {
    alive = false;
    if (!released) { released = true; client.release(true); }
  };
  client.on('error', lost);
  try {
    const result = await client.query(`SELECT pg_try_advisory_lock($1, $2) AS ok`, RECONCILER_LOCK);
    if (!result.rows[0].ok) {
      client.removeListener('error', lost);
      client.release();
      return { acquired: false, release: async () => {} };
    }
    return {
      get acquired() { return alive && !released; },
      release: async () => {
        if (released) return;
        released = true;
        await client.query(`SELECT pg_advisory_unlock($1, $2)`, RECONCILER_LOCK).catch(() => {});
        client.removeListener('error', lost);
        client.release();
      },
    };
  } catch (error) {
    client.removeListener('error', lost);
    if (!released) client.release(true);
    throw error;
  }
}

/**
 * Always-on loop: every node runs this; exactly one (the advisory-lock holder)
 * executes ticks. A node that loses its DB connection loses the lock with it,
 * and another node takes over on its next attempt.
 */
export function startReconciler(pool, { provider, node = "node", intervalMs = RECONCILER_TICK_MS, onTick } = {}) {
  let leadership = null;
  let stopped = false;
  let running = false;

  const timer = setInterval(async () => {
    if (stopped || running) return;
    running = true;
    try {
      if (!leadership?.acquired) {
        leadership = await acquireReconcilerLeadership(pool);
        if (!leadership.acquired) return; // another node leads; retry next tick
      }
      const results = await runReconcilerTick(pool, { provider, node });
      onTick?.(results);
    } catch (error) {
      // Leadership client may be broken — drop it and re-elect next tick.
      await leadership?.release?.().catch(() => {});
      leadership = null;
      onTick?.({ error: String(error?.message || error) });
    } finally { running = false; }
  }, intervalMs);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await leadership?.release?.().catch(() => {});
      leadership = null;
    },
  };
}
