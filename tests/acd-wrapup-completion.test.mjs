// Regression for PROD 2026-08-02: the first answered call completed, but
// subsequent calls remained queued because status and the ACD wrap-up
// workflow diverged. Core now owns both values.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  makeTxRunner,
  prepareAcdTestPool,
  seedAgent as seedAgentIn,
  seedQueue as seedQueueIn,
} from "./helpers/acd-test-db.mjs";
import { completeAcdWrapup } from "../lib/acd/wrapup.mjs";
import { setWorkflowState } from "../lib/acd/agent-state.mjs";
import {
  applyTransition,
  createWorkItem,
  openSegment,
} from "../lib/acd/lifecycle.mjs";
import { routeOne } from "../lib/acd/router.mjs";
import { findPendingAcdWrapupForAgent } from "../lib/acd/wrapup-context.mjs";
import {
  getDurableOverallAgentMetrics,
  getDurableQueueAgentMetrics,
} from "../lib/acd/realtime-queue-metrics.mjs";

const pool = await prepareAcdTestPool("acd_core_test_wrapup_completion");
const skip = pool ? false : "PostgreSQL not reachable — skipping ACD wrap-up tests";
const withTx = makeTxRunner(pool);
const seedAgent = (agentId, overrides) => seedAgentIn(pool, agentId, overrides);
const seedQueue = (queueId, agentIds, overrides) => seedQueueIn(pool, queueId, agentIds, overrides);

async function makeQueuedWorkItem(queueId) {
  return withTx(async (tx) => {
    const workItem = await createWorkItem(tx, {
      channel: "voice",
      direction: "inbound",
      queueId,
      actor: "test",
    });
    await applyTransition(tx, {
      workItemId: workItem.id,
      to: "queued",
      eventType: "work_item_queued",
      actor: "test",
      patch: { queueId, enqueuedAt: new Date().toISOString() },
    });
    await openSegment(tx, {
      workItemId: workItem.id,
      kind: "queue_wait",
      queueId,
    });
    return workItem;
  });
}

test("wrap-up submission atomically restores routability and offers the next queued call", { skip }, async () => {
  const queueId = `queue-${randomUUID().slice(0, 8)}`;
  const agentId = `agent-${randomUUID().slice(0, 8)}`;
  const completedWorkItemId = randomUUID();
  await seedAgent(agentId);
  await seedQueue(queueId, [agentId], { engineOwner: "acd_core" });

  await pool.query(
    `INSERT INTO acd_work_items
       (id, channel, direction, state, queue_id,
        terminal_at, terminal_reason, attributes)
     VALUES ($1, 'voice', 'inbound', 'completed', $2,
             now(), 'call_ended', '{}')`,
    [completedWorkItemId, queueId],
  );
  await pool.query(
    `INSERT INTO acd_segments
       (id, work_item_id, seq, kind, queue_id, agent_id, started_at, ended_at, outcome)
     VALUES ($1, $2, 1, 'agent', $3, $4, now() - interval '30 seconds', now(), 'completed')`,
    [randomUUID(), completedWorkItemId, queueId, agentId],
  );
  await pool.query(
    `UPDATE acd_agent_state
        SET presence = 'online', routability = 'routable'
      WHERE agent_id = $1`,
    [agentId],
  );
  await setWorkflowState(pool, agentId, "wrapup", {
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    actor: "test",
    workItemId: completedWorkItemId,
  });
  const nextWorkItem = await makeQueuedWorkItem(queueId);
  const blocked = await routeOne(pool, nextWorkItem.id);
  assert.deepEqual(blocked, { routed: false, reason: "no_candidates" });
  const blockedEvent = await pool.query(
    `SELECT payload
       FROM acd_events
      WHERE work_item_id = $1 AND type = 'no_agent_reserved'
      ORDER BY id DESC LIMIT 1`,
    [nextWorkItem.id],
  );
  assert.equal(blockedEvent.rows[0].payload.reason, "agent_in_wrapup");
  assert.deepEqual(blockedEvent.rows[0].payload.candidate_reasons, { agent_in_wrapup: 1 });

  const unavailableMetrics = await getDurableQueueAgentMetrics(pool, queueId, "acd_core");
  assert.equal(unavailableMetrics.availableAgents, 0);

  const completed = await completeAcdWrapup(pool, {
    workItemId: completedWorkItemId,
    expectedAgentId: agentId,
    wrapupCodeId: "general-inquiry",
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.agentId, agentId);

  const state = await pool.query(
    `SELECT core.workflow_state, core.workflow_deadline_at, core.routability,
            core.manual_status, seg.wrapup_code_id, seg.wrapup_ended_at
       FROM acd_agent_state core
       JOIN acd_segments seg ON seg.work_item_id = $2 AND seg.agent_id = core.agent_id
      WHERE core.agent_id = $1`,
    [agentId, completedWorkItemId],
  );
  assert.equal(state.rows[0].workflow_state, "idle");
  assert.equal(state.rows[0].workflow_deadline_at, null);
  assert.equal(state.rows[0].routability, "routable");
  assert.equal(state.rows[0].manual_status, "Available");
  assert.equal(state.rows[0].wrapup_code_id, "general-inquiry");
  assert.ok(state.rows[0].wrapup_ended_at);
  const availableMetrics = await getDurableQueueAgentMetrics(pool, queueId, "acd_core");
  assert.equal(availableMetrics.availableAgents, 1);
  assert.equal(availableMetrics.busyAgents, 0);
  const availableOverall = await getDurableOverallAgentMetrics(pool);
  assert.equal(availableOverall.availableAgents, 1);
  assert.equal(availableOverall.totalAgents, 1);

  const routed = await routeOne(pool, nextWorkItem.id);
  assert.equal(routed.routed, true);
  assert.equal(routed.agentId, agentId);
  const busyMetrics = await getDurableQueueAgentMetrics(pool, queueId, "acd_core");
  assert.equal(busyMetrics.availableAgents, 0);
  assert.equal(busyMetrics.busyAgents, 1);

  const events = await pool.query(
    `SELECT type, payload
       FROM acd_events
      WHERE work_item_id = $1
        AND type IN ('agent_workflow_changed', 'wrapup_completed')
      ORDER BY id`,
    [completedWorkItemId],
  );
  assert.deepEqual(events.rows.map((row) => row.type), [
    "agent_workflow_changed",
    "agent_workflow_changed",
    "wrapup_completed",
  ]);
  assert.equal(events.rows[1].payload.reason, "wrapup_submitted");
});

test("Save & Go on Break completes wrap-up without exposing a routable state", { skip }, async () => {
  const queueId = `queue-${randomUUID().slice(0, 8)}`;
  const agentId = `agent-${randomUUID().slice(0, 8)}`;
  const completedWorkItemId = randomUUID();
  await seedAgent(agentId);
  await seedQueue(queueId, [agentId], { engineOwner: "acd_core" });

  await pool.query(
    `INSERT INTO acd_work_items
       (id, channel, direction, state, queue_id,
        terminal_at, terminal_reason, attributes)
     VALUES ($1, 'voice', 'inbound', 'completed', $2,
             now(), 'call_ended', '{}')`,
    [completedWorkItemId, queueId],
  );
  await pool.query(
    `INSERT INTO acd_segments
       (id, work_item_id, seq, kind, queue_id, agent_id, started_at, ended_at, outcome)
     VALUES ($1, $2, 1, 'agent', $3, $4, now() - interval '30 seconds', now(), 'completed')`,
    [randomUUID(), completedWorkItemId, queueId, agentId],
  );
  await pool.query(
    `UPDATE acd_agent_state
        SET presence = 'online', routability = 'routable'
      WHERE agent_id = $1`,
    [agentId],
  );
  await setWorkflowState(pool, agentId, "wrapup", {
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    actor: "test",
    workItemId: completedWorkItemId,
  });
  const nextWorkItem = await makeQueuedWorkItem(queueId);

  const completed = await completeAcdWrapup(pool, {
    workItemId: completedWorkItemId,
    expectedAgentId: agentId,
    wrapupCodeId: "general-inquiry",
    nextManualStatus: "Break",
  });
  assert.equal(completed.completed, true);

  const state = (
    await pool.query(
      `SELECT workflow_state, routability, manual_status
         FROM acd_agent_state
        WHERE agent_id = $1`,
      [agentId],
    )
  ).rows[0];
  assert.deepEqual(state, {
    workflow_state: "idle",
    routability: "not_routable",
    manual_status: "Break",
  });

  const routed = await routeOne(pool, nextWorkItem.id);
  assert.deepEqual(routed, { routed: false, reason: "no_candidates" });
});

test("duplicate wrap-up completion cannot release a newer agent workflow", { skip }, async () => {
  for (const newerWorkflowState of ["offered", "handling", "wrapup"]) {
    const queueId = `queue-${randomUUID().slice(0, 8)}`;
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const oldWorkItemId = randomUUID();
    const newerWorkItemId = randomUUID();
    await seedAgent(agentId);
    await seedQueue(queueId, [agentId], { engineOwner: "acd_core" });

    await pool.query(
      `INSERT INTO acd_work_items
         (id, channel, direction, state, queue_id, terminal_at, terminal_reason, attributes)
       VALUES
         ($1, 'voice', 'inbound', 'completed', $3, now() - interval '30 seconds',
          'call_ended', '{"engine":"acd_core"}'),
         ($2, 'voice', 'inbound', $4, $3,
          CASE WHEN $4 = 'completed' THEN now() ELSE NULL END,
          CASE WHEN $4 = 'completed' THEN 'call_ended' ELSE NULL END,
          '{"engine":"acd_core"}')`,
      [
        oldWorkItemId,
        newerWorkItemId,
        queueId,
        newerWorkflowState === "wrapup" ? "completed" : "active",
      ],
    );
    await pool.query(
      `INSERT INTO acd_segments
         (id, work_item_id, seq, kind, queue_id, agent_id, started_at, ended_at,
          wrapup_ended_at, outcome)
       VALUES ($1, $2, 1, 'agent', $3, $4, now() - interval '60 seconds',
               now() - interval '30 seconds', now() - interval '25 seconds', 'completed')`,
      [randomUUID(), oldWorkItemId, queueId, agentId],
    );
    await setWorkflowState(pool, agentId, newerWorkflowState, {
      deadlineAt:
        newerWorkflowState === "wrapup"
          ? new Date(Date.now() + 120_000).toISOString()
          : null,
      actor: "test",
      workItemId: newerWorkItemId,
    });
    await pool.query(
      `UPDATE acd_agent_state SET routability = 'not_routable' WHERE agent_id = $1`,
      [agentId],
    );
    const result = await completeAcdWrapup(pool, {
      workItemId: oldWorkItemId,
      expectedAgentId: agentId,
    });
    assert.equal(result.completed, true, newerWorkflowState);
    assert.equal(result.alreadyCompleted, true, newerWorkflowState);
    assert.equal(result.agentStateReleased, false, newerWorkflowState);

    const state = await pool.query(
      `SELECT core.workflow_state, core.routability, core.manual_status
         FROM acd_agent_state core
        WHERE core.agent_id = $1`,
      [agentId],
    );
    assert.equal(state.rows[0].workflow_state, newerWorkflowState);
    assert.equal(state.rows[0].routability, "not_routable");
    assert.equal(state.rows[0].manual_status, "Available");
  }
});

test("a transferred agent segment can complete wrap-up while the call continues in another queue", { skip }, async () => {
  const sourceQueueId = `queue-${randomUUID().slice(0, 8)}`;
  const targetQueueId = `queue-${randomUUID().slice(0, 8)}`;
  const agentId = `agent-${randomUUID().slice(0, 8)}`;
  const workItemId = randomUUID();
  const segmentId = randomUUID();
  await seedAgent(agentId, { workflowState: "wrapup", legacyStatus: "Wrapup" });
  await seedQueue(sourceQueueId, [agentId], { engineOwner: "acd_core" });
  await seedQueue(targetQueueId, [], { engineOwner: "acd_core" });
  await pool.query(
    `INSERT INTO acd_work_items
       (id, channel, direction, state, queue_id, enqueued_at, attributes)
     VALUES ($1, 'voice', 'inbound', 'queued', $2, now(), '{}')`,
    [workItemId, targetQueueId],
  );
  await pool.query(
    `INSERT INTO acd_segments
       (id, work_item_id, seq, kind, queue_id, agent_id, started_at,
        answered_at, ended_at, outcome, wrapup_code_id)
     VALUES ($1, $2, 1, 'agent', $3, $4, now() - interval '30 seconds',
             now() - interval '30 seconds', now() - interval '5 seconds',
             'transferred', 'transfer-code')`,
    [segmentId, workItemId, sourceQueueId, agentId],
  );
  await pool.query(
    `INSERT INTO acd_segments
       (id, work_item_id, seq, kind, queue_id, started_at)
     VALUES ($1, $2, 2, 'queue_wait', $3, now() - interval '5 seconds')`,
    [randomUUID(), workItemId, targetQueueId],
  );
  await setWorkflowState(pool, agentId, "wrapup", {
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    actor: "test",
    workItemId,
  });

  const recovered = await findPendingAcdWrapupForAgent(pool, { agentId });
  assert.equal(recovered?.interaction_id, workItemId);
  assert.equal(recovered?.work_item_id, workItemId);
  assert.equal(recovered?.id, segmentId);

  const result = await completeAcdWrapup(pool, {
    workItemId,
    expectedAgentId: agentId,
  });
  assert.equal(result.completed, true);
  assert.equal(result.agentStateReleased, true);
  const state = (
    await pool.query(
      `SELECT a.workflow_state, s.wrapup_code_id, s.wrapup_ended_at,
              w.state AS work_item_state, w.queue_id
         FROM acd_agent_state a
         JOIN acd_segments s ON s.id = $2
         JOIN acd_work_items w ON w.id = $3
        WHERE a.agent_id = $1`,
      [agentId, segmentId, workItemId],
    )
  ).rows[0];
  assert.equal(state.workflow_state, "idle");
  assert.equal(state.wrapup_code_id, "transfer-code");
  assert.ok(state.wrapup_ended_at);
  assert.equal(state.work_item_state, "queued");
  assert.equal(state.queue_id, targetQueueId);
});

test("late first wrap-up completion records the old segment without releasing a newer wrap-up", { skip }, async () => {
  const queueId = `queue-${randomUUID().slice(0, 8)}`;
  const agentId = `agent-${randomUUID().slice(0, 8)}`;
  const oldWorkItemId = randomUUID();
  const newerWorkItemId = randomUUID();
  const oldSegmentId = randomUUID();
  const newerSegmentId = randomUUID();
  await seedAgent(agentId);
  await seedQueue(queueId, [agentId], { engineOwner: "acd_core" });

  await pool.query(
    `INSERT INTO acd_work_items
       (id, channel, direction, state, queue_id, terminal_at, terminal_reason, attributes)
     VALUES
       ($1, 'voice', 'inbound', 'completed', $3, now() - interval '60 seconds',
        'call_ended', '{"engine":"acd_core"}'),
       ($2, 'voice', 'inbound', 'completed', $3, now(),
        'call_ended', '{"engine":"acd_core"}')`,
    [oldWorkItemId, newerWorkItemId, queueId],
  );
  await pool.query(
    `INSERT INTO acd_segments
       (id, work_item_id, seq, kind, queue_id, agent_id, started_at, ended_at, outcome)
     VALUES
       ($1, $3, 1, 'agent', $5, $6, now() - interval '90 seconds',
        now() - interval '60 seconds', 'completed'),
       ($2, $4, 1, 'agent', $5, $6, now() - interval '30 seconds', now(), 'completed')`,
    [oldSegmentId, newerSegmentId, oldWorkItemId, newerWorkItemId, queueId, agentId],
  );
  await setWorkflowState(pool, agentId, "wrapup", {
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    actor: "test",
    workItemId: newerWorkItemId,
  });
  await pool.query(
    `UPDATE acd_agent_state SET routability = 'not_routable' WHERE agent_id = $1`,
    [agentId],
  );
  const result = await completeAcdWrapup(pool, {
    workItemId: oldWorkItemId,
    expectedAgentId: agentId,
    wrapupCodeId: "late-code",
  });
  assert.equal(result.completed, true);
  assert.equal(result.alreadyCompleted, false);
  assert.equal(result.agentStateReleased, false);
  assert.equal(result.reason, "newer_work_item_owns_wrapup");

  const state = await pool.query(
    `SELECT core.workflow_state, core.routability, core.manual_status,
            old_segment.wrapup_ended_at AS old_wrapup_ended_at,
            old_segment.wrapup_code_id AS old_wrapup_code_id,
            newer_segment.wrapup_ended_at AS newer_wrapup_ended_at
       FROM acd_agent_state core
       JOIN acd_segments old_segment ON old_segment.id = $2
       JOIN acd_segments newer_segment ON newer_segment.id = $3
      WHERE core.agent_id = $1`,
    [agentId, oldSegmentId, newerSegmentId],
  );
  assert.equal(state.rows[0].workflow_state, "wrapup");
  assert.equal(state.rows[0].routability, "not_routable");
  assert.equal(state.rows[0].manual_status, "Available");
  assert.ok(state.rows[0].old_wrapup_ended_at);
  assert.equal(state.rows[0].old_wrapup_code_id, "late-code");
  assert.equal(state.rows[0].newer_wrapup_ended_at, null);
});

test("Core workflow transitions persist the canonical wrap-up status interval", { skip }, async () => {
  const agentId = `agent-${randomUUID().slice(0, 8)}`;
  const workItemId = randomUUID();
  await seedAgent(agentId);
  await pool.query(
    `INSERT INTO acd_work_items
       (id, channel, direction, state, terminal_at, terminal_reason, attributes)
     VALUES ($1, 'voice', 'inbound', 'completed', now(), 'call_ended', '{}')`,
    [workItemId],
  );
  await pool.query(
    `INSERT INTO acd_segments
       (id, work_item_id, seq, kind, agent_id, started_at, ended_at, outcome)
     VALUES ($1, $2, 1, 'agent', $3, now() - interval '60 seconds', now(), 'completed')`,
    [randomUUID(), workItemId, agentId],
  );
  await setWorkflowState(pool, agentId, "wrapup", {
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    actor: "test",
    workItemId,
  });
  await completeAcdWrapup(pool, { workItemId, expectedAgentId: agentId });

  const state = (
    await pool.query(
      `SELECT workflow_state, routability, manual_status
         FROM acd_agent_state WHERE agent_id = $1`,
      [agentId],
    )
  ).rows[0];
  assert.deepEqual(state, {
    workflow_state: "idle",
    routability: "routable",
    manual_status: "Available",
  });
  const intervals = await pool.query(
    `SELECT status, next_status, source, work_item_id
       FROM cc_agent_status_intervals WHERE user_id = $1 ORDER BY started_at`,
    [agentId],
  );
  assert.deepEqual(
    intervals.rows.map((row) => [row.status, row.next_status, row.source, row.work_item_id]),
    [
      ["Available", "Wrapup", "acd_core", workItemId],
      ["Wrapup", "Available", "acd_core", workItemId],
    ],
  );
});

test("Core status writer locks current agent state before deriving an interval", { skip }, async () => {
  const agentId = `agent-${randomUUID().slice(0, 8)}`;
  const workItemId = randomUUID();
  await seedAgent(agentId);
  await pool.query(
    `INSERT INTO acd_work_items
       (id, channel, direction, state, terminal_at, terminal_reason, attributes)
     VALUES ($1, 'voice', 'inbound', 'completed', now(), 'call_ended', '{}')`,
    [workItemId],
  );
  await pool.query(
    `INSERT INTO acd_segments
       (id, work_item_id, seq, kind, agent_id, started_at, ended_at, outcome)
     VALUES ($1, $2, 1, 'agent', $3, now() - interval '60 seconds', now(), 'completed')`,
    [randomUUID(), workItemId, agentId],
  );

  const locker = await pool.connect();
  try {
    await locker.query("BEGIN");
    await locker.query(
      `UPDATE acd_agent_state
          SET manual_status = 'Break', routability = 'not_routable',
              status_started_at = now() - interval '30 seconds'
        WHERE agent_id = $1`,
      [agentId],
    );

    const projection = setWorkflowState(pool, agentId, "wrapup", {
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      actor: "concurrent_projection_test",
      workItemId,
    });

    let observedLockWait = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const waiting = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query ILIKE '%acd_agent_state%'
         ) AS waiting`,
      );
      if (waiting.rows[0].waiting) {
        observedLockWait = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(observedLockWait, true);

    await locker.query("COMMIT");
    assert.equal(await projection, true);
    const intervals = await pool.query(
      `SELECT status, next_status
         FROM cc_agent_status_intervals
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [agentId],
    );
    assert.deepEqual(intervals.rows[0], {
      status: "Break",
      next_status: "Wrapup",
    });
  } finally {
    await locker.query("ROLLBACK").catch(() => {});
    locker.release();
  }
});

test.after(async () => {
  await pool?.end().catch(() => {});
});
