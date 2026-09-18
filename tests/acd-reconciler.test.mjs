// ACD reconciler — behavioral tests on real PostgreSQL (design §5.5).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  prepareAcdTestPool,
  makeTxRunner,
  seedAgent as seedAgentIn,
  seedQueue as seedQueueIn,
  makeFakeProvider,
} from "./helpers/acd-test-db.mjs";
import { createWorkItem, applyTransition, openSegment, checkInvariants } from "../lib/acd/lifecycle.mjs";
import { routeOne } from "../lib/acd/router.mjs";
import { appendEvent } from "../lib/acd/events.mjs";
import "../lib/acd/sagas/connect.mjs"; // register saga type
import {
  sweepOrphanedClaims,
  sweepWrapupDeadlines,
  sweepInvariants,
  runReconcilerTick,
  acquireReconcilerLeadership,
} from "../lib/acd/reconciler.mjs";

const pool = await prepareAcdTestPool("acd_core_test_reconciler");
const skip = pool ? false : "PostgreSQL not reachable — skipping ACD reconciler tests";
const withTx = makeTxRunner(pool);
const seedAgent = (agentId, overrides) => seedAgentIn(pool, agentId, overrides);
const seedQueue = (queueId, agentIds, overrides) => seedQueueIn(pool, queueId, agentIds, overrides);

async function queuedAndRouted() {
  const queue = `queue-${randomUUID().slice(0, 8)}`;
  const agent = `agent-${randomUUID().slice(0, 8)}`;
  await seedAgent(agent);
  await seedQueue(queue, [agent]);
  const workItem = await withTx(async (tx) => {
    const wi = await createWorkItem(tx, {
      channel: "voice", direction: "inbound", queueId: queue, actor: "test",
    });
    await applyTransition(tx, {
      workItemId: wi.id, to: "queued", eventType: "work_item_queued", actor: "test",
      patch: { queueId: queue, enqueuedAt: new Date().toISOString() },
    });
    await openSegment(tx, { workItemId: wi.id, kind: "queue_wait", queueId: queue });
    return wi;
  });
  const routeResult = await routeOne(pool, workItem.id);
  assert.equal(routeResult.routed, true);
  return { queue, agent, workItem, routeResult };
}

test("orphaned claim (crash between route and saga start) is repaired and requeued", { skip }, async () => {
  const { agent, workItem, routeResult } = await queuedAndRouted();
  // No saga was started — simulate the crash window. Expire the claim lease.
  await pool.query(
    `UPDATE acd_reservations SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [routeResult.reservationId],
  );

  const corrected = await sweepOrphanedClaims(pool);
  assert.equal(corrected, 1);

  const after = await pool.query(
    `SELECT w.state AS wi_state, r.state AS res_state, r.released_reason,
            o.state AS offer_state, o.outcome_reason, a.workflow_state
       FROM acd_work_items w
       JOIN acd_reservations r ON r.id = $2
       JOIN acd_offers o ON o.id = $3
       JOIN acd_agent_state a ON a.agent_id = $4
      WHERE w.id = $1`,
    [workItem.id, routeResult.reservationId, routeResult.offerId, agent],
  );
  const row = after.rows[0];
  assert.equal(row.wi_state, "queued"); // work item goes back to the queue
  assert.equal(row.res_state, "released");
  assert.equal(row.released_reason, "lease_expired_orphan");
  assert.equal(row.offer_state, "cancelled");
  assert.equal(row.outcome_reason, "orphaned_claim");
  assert.equal(row.workflow_state, "idle"); // agent freed

  const event = await pool.query(
    `SELECT payload FROM acd_events WHERE work_item_id = $1 AND type = 'reconciler_corrected'`,
    [workItem.id],
  );
  assert.equal(event.rows.length, 1);
  assert.equal(event.rows[0].payload.kind, "orphaned_claim");
  assert.deepEqual(await checkInvariants(pool), {});
});

test("orphan sweep does NOT touch claims owned by a live saga or active reservations", { skip }, async () => {
  const { workItem, routeResult } = await queuedAndRouted();
  // A running saga owns this work item → sweep must skip it even when expired.
  await withTx((tx) =>
    tx.query(
      `INSERT INTO acd_sagas (id, type, work_item_id, conflict_key, state, step, deadline_at)
       VALUES ($1, 'connect', $2, 'assignment', 'running', 'dial_agent', now() + interval '30 seconds')`,
      [randomUUID(), workItem.id],
    ),
  );
  await pool.query(
    `UPDATE acd_reservations SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [routeResult.reservationId],
  );
  assert.equal(await sweepOrphanedClaims(pool), 0);

  // Active reservations are never released by age (design principle 8).
  await pool.query(`DELETE FROM acd_sagas WHERE work_item_id = $1`, [workItem.id]);
  await pool.query(
    `UPDATE acd_reservations SET state = 'active', lease_expires_at = NULL,
            handling_session_id = $2 WHERE id = $1`,
    [routeResult.reservationId, randomUUID()],
  );
  assert.equal(await sweepOrphanedClaims(pool), 0);
  const still = await pool.query(`SELECT state FROM acd_reservations WHERE id = $1`, [routeResult.reservationId]);
  assert.equal(still.rows[0].state, "active");
});

test("wrapup past deadline auto-closes to idle with an observable event", { skip }, async () => {
  const agent = `agent-${randomUUID().slice(0, 8)}`;
  await seedAgent(agent);
  const workItem = await withTx(async tx => {
    const wi = await createWorkItem(tx, { channel: "voice", direction: "inbound", actor: "test" });
    await openSegment(tx, { workItemId: wi.id, kind: "agent", agentId: agent });
    await tx.query(`UPDATE acd_segments SET ended_at = now() WHERE work_item_id = $1`, [wi.id]);
    await appendEvent(tx, { workItemId: wi.id, agentId: agent, type: "agent_workflow_changed", payload: { workflow_state: "wrapup" }, actor: "test" });
    return wi;
  });
  await pool.query(
    `UPDATE acd_agent_state SET workflow_state = 'wrapup',
            workflow_deadline_at = now() - interval '5 seconds' WHERE agent_id = $1`,
    [agent],
  );
  assert.equal(await sweepWrapupDeadlines(pool), 1);
  const state = await pool.query(
    `SELECT workflow_state, workflow_deadline_at FROM acd_agent_state WHERE agent_id = $1`,
    [agent],
  );
  assert.equal(state.rows[0].workflow_state, "idle");
  assert.equal(state.rows[0].workflow_deadline_at, null);
  const segment = (await pool.query(`SELECT wrapup_code_id, wrapup_ended_at FROM acd_segments WHERE work_item_id = $1`, [workItem.id])).rows[0];
  assert.equal(segment.wrapup_code_id, "auto_timeout");
  assert.ok(segment.wrapup_ended_at);
  const event = await pool.query(
    `SELECT 1 FROM acd_events WHERE agent_id = $1 AND type = 'reconciler_corrected'
      AND payload->>'kind' = 'wrapup_auto_closed'`,
    [agent],
  );
  assert.equal(event.rows.length, 1);

  // Future deadline is left alone.
  await pool.query(
    `UPDATE acd_agent_state SET workflow_state = 'wrapup',
            workflow_deadline_at = now() + interval '60 seconds' WHERE agent_id = $1`,
    [agent],
  );
  assert.equal(await sweepWrapupDeadlines(pool), 0);
});

test("full tick closes expired wrapup from Core state without a legacy projection", { skip }, async () => {
  const queue = `queue-${randomUUID().slice(0, 8)}`;
  const agent = `agent-${randomUUID().slice(0, 8)}`;
  await seedAgent(agent);
  await seedQueue(queue, [agent], { engineOwner: "acd_core" });
  await pool.query(
    `UPDATE acd_agent_state
        SET presence = 'online', routability = 'not_routable', workflow_state = 'wrapup',
            workflow_deadline_at = now() - interval '5 seconds'
      WHERE agent_id = $1`,
    [agent],
  );

  const beforeTick = await pool.query(
    `SELECT workflow_state, workflow_deadline_at
       FROM acd_agent_state
      WHERE agent_id = $1`,
    [agent],
  );
  assert.equal(beforeTick.rows[0].workflow_state, "wrapup");
  assert.ok(beforeTick.rows[0].workflow_deadline_at);

  const result = await runReconcilerTick(pool, { provider: makeFakeProvider() });
  assert.equal(result.wrapupsClosed, 1);
  const state = await pool.query(
    `SELECT workflow_state, workflow_deadline_at, routability, manual_status
       FROM acd_agent_state
      WHERE agent_id = $1`,
    [agent],
  );
  assert.equal(state.rows[0].workflow_state, "idle");
  assert.equal(state.rows[0].workflow_deadline_at, null);
  assert.equal(state.rows[0].routability, "routable");
  assert.equal(state.rows[0].manual_status, "Available");
});

test("invariant violations become alarm events", { skip }, async () => {
  assert.equal(await sweepInvariants(pool), 0);

  const workItem = await withTx((tx) =>
    createWorkItem(tx, { channel: "voice", direction: "inbound", actor: "test" }),
  );
  await withTx((tx) =>
    applyTransition(tx, {
      workItemId: workItem.id, to: "failed", eventType: "work_item_failed",
      actor: "test", patch: { terminalReason: "seeded" },
    }),
  );
  const badReservation = randomUUID();
  await pool.query(
    `INSERT INTO acd_reservations (id, agent_id, work_item_id, channel, weight, state)
     VALUES ($1, 'ghost', $2, 'voice', 1.0, 'active')`,
    [badReservation, workItem.id],
  );
  assert.equal(await sweepInvariants(pool), 1);
  const alarm = await pool.query(
    `SELECT payload FROM acd_events WHERE type = 'invariant_violation' ORDER BY id DESC LIMIT 1`,
  );
  assert.equal(alarm.rows[0].payload.invariant, "live_reservation_on_terminal_work_item");
  await pool.query(`DELETE FROM acd_reservations WHERE id = $1`, [badReservation]);
});

test("full tick runs all sweeps and reports counts", { skip }, async () => {
  const provider = makeFakeProvider();
  const results = await runReconcilerTick(pool, { provider });
  assert.deepEqual(Object.keys(results).sort(), [
    "abandonedDirectIntents", "invariantAlarms", "orphanedClaims", "retention", "sagaDeadlines", "settledDirectIntents", "stalledDriven", "unconfirmedDirectCalls", "wrapupsClosed",
  ].sort());
  for (const [key, value] of Object.entries(results)) {
    if (key === "retention") {
      assert.deepEqual(value, { enabled: false, ran: false });
    } else {
      assert.equal(typeof value, "number");
    }
  }
});

test("leadership: only one holder at a time; released lock is re-acquirable", { skip }, async () => {
  const first = await acquireReconcilerLeadership(pool);
  assert.equal(first.acquired, true);
  const second = await acquireReconcilerLeadership(pool);
  assert.equal(second.acquired, false);
  await first.release();
  const third = await acquireReconcilerLeadership(pool);
  assert.equal(third.acquired, true);
  await third.release();
});

test.after(async () => {
  await pool?.end().catch(() => {});
});
