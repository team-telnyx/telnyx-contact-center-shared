import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  prepareAcdTestPool,
  seedAgent,
  seedQueue,
} from "./helpers/acd-test-db.mjs";
import {
  getDurableOverallQueueMetrics,
  getDurableQueueMetrics,
} from "../lib/acd/realtime-queue-metrics.mjs";
import {
  enrichAcdRealtimeCalls,
  getAcdRealtimeAgentCalls,
  getAcdRealtimeQueueCalls,
} from "../lib/acd/realtime-queue-calls.mjs";

const pool = await prepareAcdTestPool("acd_core_test_supervisor_realtime");
const skip = pool ? false : "PostgreSQL not reachable — skipping ACD supervisor tests";

function id() {
  return randomUUID();
}

async function insertCoreWork({ queueId, state, enqueuedSecondsAgo }) {
  const workItemId = id();
  await pool.query(
    `INSERT INTO acd_work_items
       (id, channel, direction, state, queue_id, attributes, enqueued_at, created_at)
     VALUES ($1, 'voice', 'inbound', $2, $3, $4::jsonb,
             now() - ($5::text || ' seconds')::interval,
             now() - ($5::text || ' seconds')::interval)`,
    [
      workItemId,
      state,
      queueId,
      JSON.stringify({}),
      String(enqueuedSecondsAgo),
    ],
  );
  if (["queued", "offered"].includes(state)) {
    await pool.query(
      `INSERT INTO acd_segments
         (id, work_item_id, seq, kind, queue_id, started_at)
       VALUES ($1, $2, 1, 'queue_wait', $3,
               now() - ($4::text || ' seconds')::interval)`,
      [id(), workItemId, queueId, String(enqueuedSecondsAgo)],
    );
  }
  return workItemId;
}

test("ACD supervisor realtime derives every queue counter from Core", { skip }, async () => {
  const queueId = `acd-test-${id().slice(0, 8)}`;
  await seedQueue(pool, queueId, [], { name: "ACD Test" });

  await insertCoreWork({ queueId, state: "queued", enqueuedSecondsAgo: 180 });
  await insertCoreWork({ queueId, state: "offered", enqueuedSecondsAgo: 60 });
  await insertCoreWork({ queueId, state: "active", enqueuedSecondsAgo: 30 });

  const metrics = await getDurableQueueMetrics(pool, queueId);
  assert.equal(metrics.queuedCalls, 1);
  assert.equal(metrics.ringingCalls, 1);
  assert.equal(metrics.waitingCalls, 2);
  assert.equal(metrics.activeCalls, 1);
  assert.ok(metrics.longestWaitSeconds >= 179);
  assert.ok(metrics.avgWaitSeconds >= 119);
});

test("every configured queue uses Core realtime data", { skip }, async () => {
  const queueId = `configured-test-${id().slice(0, 8)}`;
  await seedQueue(pool, queueId, [], { name: "Configured Test" });
  await insertCoreWork({ queueId, state: "queued", enqueuedSecondsAgo: 600 });

  const metrics = await getDurableQueueMetrics(pool, queueId);
  assert.equal(metrics.waitingCalls, 1);
  assert.equal(metrics.ringingCalls, 0);
  assert.equal(metrics.activeCalls, 0);
});

test("ACD supervisor accordion reads identities and state from acd_*", { skip }, async () => {
  const queueId = `acd-calls-${id().slice(0, 8)}`;
  await seedQueue(pool, queueId, [], { name: "ACD Calls" });
  const workItemId = id();
  await pool.query(
    `INSERT INTO acd_work_items
       (id, channel, direction, state, queue_id, customer_address, cc_address,
        required_skills, priority, attributes, enqueued_at)
     VALUES ($1, 'voice', 'inbound', 'queued', $2, '+15551112222', '+15553334444',
             '{"polish": 4}', 3, '{"engine":"acd_core"}', now() - interval '90 seconds')`,
    [workItemId, queueId],
  );
  await pool.query(
    `INSERT INTO acd_legs
       (id, work_item_id, role, provider_call_id, provider_session_id, state)
     VALUES ($1, $2, 'customer', $3, $4, 'answered')`,
    [id(), workItemId, `v3:${id().replaceAll("-", "")}`, `session-${id()}`],
  );
  await pool.query(
    `INSERT INTO acd_events (work_item_id, type, payload, actor)
     VALUES ($1, 'no_agent_reserved', '{"reason":"no_queue_members_online"}', 'router')`,
    [workItemId],
  );

  const calls = await getAcdRealtimeQueueCalls(pool, queueId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workItemId, workItemId);
  assert.equal(calls[0].fromNumber, "+15551112222");
  assert.equal(calls[0].toNumber, "+15553334444");
  assert.equal(calls[0].state, "queued");
  assert.equal(calls[0].waitingReason, "No agents online");
  assert.deepEqual(calls[0].requiredSkills, { polish: 4 });
  assert.equal(calls[0].priority, 3);
  assert.ok(calls[0].waitSeconds >= 89);
});

test("agent interaction rows include queue, skill relaxation, and priority", { skip }, async () => {
  const agentId = `agent-view-${id().slice(0, 8)}`;
  const queueId = `agent-queue-${id().slice(0, 8)}`;
  const workItemId = id();
  await seedAgent(pool, agentId);
  await seedQueue(pool, queueId, [agentId], { name: "Priority Support" });
  await pool.query(
    `UPDATE cc_queues
        SET skill_relaxation_enabled = true,
            skill_relaxation_after_seconds = 0,
            skill_relaxation_strategy = 'fallback'
      WHERE id = $1`,
    [queueId],
  );
  await pool.query(
    `INSERT INTO skills (id, name, is_active)
     VALUES ('polish', 'Polish', true)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
  );
  await pool.query(
    `INSERT INTO acd_work_items
       (id, channel, direction, state, queue_id, customer_address, cc_address,
        required_skills, priority, attributes, enqueued_at)
     VALUES ($1, 'voice', 'inbound', 'active', $2, '+15551112222', '+15553334444',
             '{"polish": 5}', 4, '{"engine":"acd_core"}', now() - interval '90 seconds')`,
    [workItemId, queueId],
  );
  await pool.query(
    `INSERT INTO acd_segments
       (id, work_item_id, seq, kind, queue_id, agent_id, started_at)
     VALUES ($1, $2, 1, 'agent', $3, $4, now() - interval '30 seconds')`,
    [id(), workItemId, queueId, agentId],
  );
  await pool.query(
    `INSERT INTO acd_legs
       (id, work_item_id, role, provider_call_id, provider_session_id,
        agent_id, state, answered_at, bridged_at)
     VALUES ($1, $2, 'customer', $3, $4, NULL, 'bridged', now(), now()),
            ($5, $2, 'agent_device', $6, NULL, $7, 'bridged', now(), now())`,
    [
      id(),
      workItemId,
      `v3:${id().replaceAll("-", "")}`,
      `session-${id()}`,
      id(),
      `v3:${id().replaceAll("-", "")}`,
      agentId,
    ],
  );

  const calls = await enrichAcdRealtimeCalls(
    pool,
    await getAcdRealtimeAgentCalls(pool, agentId),
  );
  const call = calls.find((entry) => entry.workItemId === workItemId);
  assert.ok(call);
  assert.equal(call.queueId, queueId);
  assert.equal(call.queueName, "Priority Support");
  assert.deepEqual(call.requiredSkills, { polish: 5 });
  assert.deepEqual(call.relaxedSkills, { polish: 3 });
  assert.equal(call.isRelaxed, true);
  assert.deepEqual(call.skillNames, { polish: "Polish" });
  assert.equal(call.priority, 4);
});

test("overall realtime totals use Core rows across configured queues", { skip }, async () => {
  const before = await getDurableOverallQueueMetrics(pool);
  const firstQueueId = `overall-first-${id().slice(0, 8)}`;
  const secondQueueId = `overall-second-${id().slice(0, 8)}`;
  await seedQueue(pool, firstQueueId, [], { name: firstQueueId });
  await seedQueue(pool, secondQueueId, [], { name: secondQueueId });
  await insertCoreWork({ queueId: firstQueueId, state: "queued", enqueuedSecondsAgo: 20 });
  await insertCoreWork({ queueId: secondQueueId, state: "active", enqueuedSecondsAgo: 20 });

  const after = await getDurableOverallQueueMetrics(pool);
  assert.equal(after.waitingCalls, before.waitingCalls + 1);
  assert.equal(after.activeCalls, before.activeCalls + 1);
});
