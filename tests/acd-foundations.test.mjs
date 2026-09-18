// ACD Core Phase A foundations — behavioral tests against a REAL PostgreSQL
// (the internal documentation §11: assertions on final DB state and emitted
// events, never on SQL text). Uses a dedicated database `acd_core_test`;
// skips cleanly when PostgreSQL is unreachable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  prepareAcdTestPool,
  makeTxRunner,
  seedAgent as seedAgentIn,
  seedQueue as seedQueueIn,
} from "./helpers/acd-test-db.mjs";
import { ensureAcdSchema } from "../lib/acd/schema.mjs";
import { appendEvent, readOutboxAfter } from "../lib/acd/events.mjs";
import {
  createWorkItem,
  applyTransition,
  openSegment,
  closeOpenSegment,
  checkInvariants,
  TransitionConflictError,
  TRANSITIONS,
} from "../lib/acd/lifecycle.mjs";
import {
  tryOfferAndReserve,
  promoteReservation,
  releaseReservation,
  resolveOffer,
  agentLiveOccupancy,
} from "../lib/acd/reservations.mjs";
import { routeOne } from "../lib/acd/router.mjs";
import { skillsPolicy, fifoPolicy } from "../lib/acd/policies/index.mjs";

const pool = await prepareAcdTestPool("acd_core_test_foundations");
const skip = pool ? false : "PostgreSQL not reachable — skipping ACD foundation tests";
const withTx = makeTxRunner(pool);
const seedAgent = (agentId, overrides) => seedAgentIn(pool, agentId, overrides);
const seedQueue = (queueId, agentIds, overrides) => seedQueueIn(pool, queueId, agentIds, overrides);

async function makeQueuedWorkItem(queueId, overrides = {}) {
  return withTx(async (tx) => {
    const workItem = await createWorkItem(tx, {
      channel: overrides.channel || "voice",
      direction: "inbound",
      queueId,
      requiredSkills: overrides.requiredSkills || {},
      customerAddress: "+15550001111",
      actor: "test",
    });
    await applyTransition(tx, {
      workItemId: workItem.id,
      to: "queued",
      eventType: "work_item_queued",
      payload: { queue_id: queueId },
      actor: "test",
      patch: { queueId, enqueuedAt: overrides.enqueuedAt || new Date().toISOString() },
    });
    await openSegment(tx, { workItemId: workItem.id, kind: "queue_wait", queueId });
    return workItem;
  });
}

test("schema is idempotent", { skip }, async () => {
  const client = await pool.connect();
  try {
    await ensureAcdSchema(client);
    await ensureAcdSchema(client);
  } finally {
    client.release();
  }
});

test("transition map covers every state exactly once", { skip: false }, () => {
  const states = Object.keys(TRANSITIONS);
  assert.deepEqual(
    states.sort(),
    ["abandoned", "active", "completed", "failed", "offered", "open", "queued"].sort(),
  );
  for (const targets of Object.values(TRANSITIONS)) {
    for (const target of targets) assert.ok(states.includes(target));
  }
});

test("legal lifecycle chain with version bumps, events and outbox", { skip }, async () => {
  const workItem = await withTx((tx) =>
    createWorkItem(tx, { channel: "voice", direction: "inbound", actor: "test" }),
  );
  assert.equal(workItem.state, "open");
  assert.equal(Number(workItem.version), 0);

  const chain = [
    ["queued", "work_item_queued"],
    ["offered", "work_item_offered"],
    ["active", "work_item_answered"],
    ["completed", "work_item_completed"],
  ];
  let version = 0;
  for (const [to, eventType] of chain) {
    const result = await withTx((tx) =>
      applyTransition(tx, {
        workItemId: workItem.id,
        expectedVersion: version,
        to,
        eventType,
        actor: "test",
        patch: to === "completed" ? { terminalReason: "customer_hangup" } : {},
      }),
    );
    assert.equal(result.applied, true, `transition to ${to}`);
    version += 1;
    assert.equal(Number(result.workItem.version), version);
  }

  const final = await pool.query(`SELECT * FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(final.rows[0].state, "completed");
  assert.ok(final.rows[0].terminal_at);
  assert.equal(final.rows[0].terminal_reason, "customer_hangup");

  const events = await pool.query(
    `SELECT type FROM acd_events WHERE work_item_id = $1 ORDER BY id`,
    [workItem.id],
  );
  assert.deepEqual(
    events.rows.map((r) => r.type),
    ["work_item_created", "work_item_queued", "work_item_offered", "work_item_answered", "work_item_completed"],
  );

  const outbox = await readOutboxAfter(pool, { afterSeq: 0, topics: [`work_item:${workItem.id}`] });
  assert.equal(outbox.length, 5);
  assert.ok(outbox.every((row, i) => i === 0 || row.seq > outbox[i - 1].seq));
});

test("illegal transition is rejected and recorded, state unchanged", { skip }, async () => {
  const workItem = await withTx((tx) =>
    createWorkItem(tx, { channel: "voice", direction: "inbound", actor: "test" }),
  );
  const result = await withTx((tx) =>
    applyTransition(tx, {
      workItemId: workItem.id,
      to: "active", // open → active is not legal
      eventType: "bogus",
      actor: "test",
    }),
  );
  assert.equal(result.applied, false);
  assert.equal(result.reason, "illegal");

  const row = await pool.query(`SELECT state, version FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(row.rows[0].state, "open");
  assert.equal(Number(row.rows[0].version), 0);

  const recorded = await pool.query(
    `SELECT 1 FROM acd_events WHERE work_item_id = $1 AND type = 'illegal_transition_rejected'`,
    [workItem.id],
  );
  assert.equal(recorded.rows.length, 1);
});

test("terminal states absorb late events as noop", { skip }, async () => {
  const workItem = await withTx((tx) =>
    createWorkItem(tx, { channel: "voice", direction: "inbound", actor: "test" }),
  );
  await withTx((tx) =>
    applyTransition(tx, {
      workItemId: workItem.id, to: "abandoned", eventType: "work_item_abandoned",
      actor: "test", patch: { terminalReason: "customer_hangup_prequeue" },
    }),
  );
  // Replayed provider event tries to re-queue the dead work item.
  const late = await withTx((tx) =>
    applyTransition(tx, {
      workItemId: workItem.id, to: "queued", eventType: "work_item_queued", actor: "provider",
    }),
  );
  assert.equal(late.applied, false);
  assert.equal(late.reason, "terminal");
  const noop = await pool.query(
    `SELECT payload FROM acd_events WHERE work_item_id = $1 AND type = 'late_event_noop'`,
    [workItem.id],
  );
  assert.equal(noop.rows.length, 1);
  assert.equal(noop.rows[0].payload.terminal_state, "abandoned");
});

test("version CAS throws on concurrent modification", { skip }, async () => {
  const workItem = await withTx((tx) =>
    createWorkItem(tx, { channel: "voice", direction: "inbound", actor: "test" }),
  );
  await withTx((tx) =>
    applyTransition(tx, { workItemId: workItem.id, to: "queued", eventType: "work_item_queued", actor: "test" }),
  );
  await assert.rejects(
    withTx((tx) =>
      applyTransition(tx, {
        workItemId: workItem.id, expectedVersion: 0, to: "offered",
        eventType: "work_item_offered", actor: "test",
      }),
    ),
    TransitionConflictError,
  );
});

test("voice reservation is exclusive; fractional channels share capacity", { skip }, async () => {
  const agent = `agent-${randomUUID().slice(0, 8)}`;
  await seedAgent(agent, { capacity: 1.0 });
  const queueId = `chat-${randomUUID()}`;
  await seedQueue(queueId, [agent]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,4,0.25)", [queueId]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,4,0.25)", [agent]);
  await pool.query(
    `UPDATE acd_agent_sessions
        SET capabilities = capabilities || '{"chat":true}'::jsonb
      WHERE agent_id = $1`,
    [agent],
  );

  const voiceItem = await withTx((tx) =>
    createWorkItem(tx, { channel: "voice", direction: "inbound", actor: "test" }),
  );
  const reserved = await withTx((tx) =>
    tryOfferAndReserve(tx, {
      workItemId: voiceItem.id, agentId: agent, channel: "voice", offerDeadlineMs: 30_000,
    }),
  );
  assert.ok(reserved, "first voice reservation succeeds");
  assert.equal(reserved.generation, 1);

  // Voice occupies the agent exclusively → any second item fails.
  const chatItem = await withTx((tx) =>
    createWorkItem(tx, { channel: "chat", queueId, direction: "inbound", actor: "test" }),
  );
  const chatDuringVoice = await withTx((tx) =>
    tryOfferAndReserve(tx, {
      workItemId: chatItem.id, agentId: agent, channel: "chat", offerDeadlineMs: 30_000,
    }),
  );
  assert.equal(chatDuringVoice, null);

  // Release the voice reservation → agent takes chat items up to capacity.
  await withTx((tx) => releaseReservation(tx, reserved.reservationId, "test_cleanup"));
  await pool.query(`UPDATE acd_agent_state SET workflow_state = 'idle' WHERE agent_id = $1`, [agent]);

  const chatIds = [];
  for (let i = 0; i < 4; i += 1) {
    const item = await withTx((tx) =>
      createWorkItem(tx, { channel: "chat", queueId, direction: "inbound", actor: "test" }),
    );
    chatIds.push(item.id);
  }
  const results = [];
  for (const id of chatIds) {
    results.push(
      await withTx((tx) =>
        tryOfferAndReserve(tx, { workItemId: id, agentId: agent, channel: "chat", offerDeadlineMs: 30_000 }),
      ),
    );
  }
  // 4 × 0.25 = 1.0 fits exactly in capacity 1.0.
  assert.equal(results.filter(Boolean).length, 4);

  const occupancy = await withTx((tx) => agentLiveOccupancy(tx, agent));
  assert.equal(occupancy.liveWeight, 1.0);

  // Fifth chat exceeds capacity.
  const fifth = await withTx((tx) =>
    createWorkItem(tx, { channel: "chat", queueId, direction: "inbound", actor: "test" }),
  );
  const overflow = await withTx((tx) =>
    tryOfferAndReserve(tx, { workItemId: fifth.id, agentId: agent, channel: "chat", offerDeadlineMs: 30_000 }),
  );
  assert.equal(overflow, null);

  // And voice cannot start while fractional work is live (suspension is a Phase E policy).
  const voice2 = await withTx((tx) =>
    createWorkItem(tx, { channel: "voice", direction: "inbound", actor: "test" }),
  );
  const voiceDuringChat = await withTx((tx) =>
    tryOfferAndReserve(tx, { workItemId: voice2.id, agentId: agent, channel: "voice", offerDeadlineMs: 30_000 }),
  );
  assert.equal(voiceDuringChat, null);
});

test("reservation promotion chain and active-without-lease semantics", { skip }, async () => {
  const agent = `agent-${randomUUID().slice(0, 8)}`;
  await seedAgent(agent);
  const workItem = await withTx((tx) =>
    createWorkItem(tx, { channel: "voice", direction: "inbound", actor: "test" }),
  );
  const reserved = await withTx((tx) =>
    tryOfferAndReserve(tx, { workItemId: workItem.id, agentId: agent, channel: "voice", offerDeadlineMs: 30_000 }),
  );

  await assert.rejects(
    withTx((tx) => promoteReservation(tx, { reservationId: reserved.reservationId, to: "active" })),
    /handlingSessionId/,
  );

  const ringing = await withTx((tx) =>
    promoteReservation(tx, { reservationId: reserved.reservationId, to: "ringing", leaseMs: 40_000 }),
  );
  assert.ok(ringing);

  const handlingSessionId = randomUUID();
  const active = await withTx((tx) =>
    promoteReservation(tx, { reservationId: reserved.reservationId, to: "active", handlingSessionId }),
  );
  assert.ok(active);

  const row = await pool.query(`SELECT state, lease_expires_at, handling_session_id FROM acd_reservations WHERE id = $1`, [reserved.reservationId]);
  assert.equal(row.rows[0].state, "active");
  assert.equal(row.rows[0].lease_expires_at, null);
  assert.equal(row.rows[0].handling_session_id, handlingSessionId);

  // Double promotion is a no-op (returns null), release is idempotent.
  const again = await withTx((tx) =>
    promoteReservation(tx, { reservationId: reserved.reservationId, to: "ringing", leaseMs: 1000 }),
  );
  assert.equal(again, null);
  assert.ok(await withTx((tx) => releaseReservation(tx, reserved.reservationId, "completed")));
  assert.equal(await withTx((tx) => releaseReservation(tx, reserved.reservationId, "completed")), null);
});

test("offer generations increment across re-offers; one live offer enforced", { skip }, async () => {
  const agentA = `agent-${randomUUID().slice(0, 8)}`;
  const agentB = `agent-${randomUUID().slice(0, 8)}`;
  await seedAgent(agentA);
  await seedAgent(agentB);
  const workItem = await withTx((tx) =>
    createWorkItem(tx, { channel: "voice", direction: "inbound", actor: "test" }),
  );

  const first = await withTx((tx) =>
    tryOfferAndReserve(tx, { workItemId: workItem.id, agentId: agentA, channel: "voice", offerDeadlineMs: 30_000 }),
  );
  assert.equal(first.generation, 1);

  // Same work item, second agent, while the first offer is live → unique index blocks.
  const concurrent = await withTx((tx) =>
    tryOfferAndReserve(tx, { workItemId: workItem.id, agentId: agentB, channel: "voice", offerDeadlineMs: 30_000 }),
  );
  assert.equal(concurrent, null);

  // No-answer compensation: offer terminal, reservation released → re-offer gets generation 2.
  await withTx(async (tx) => {
    await resolveOffer(tx, first.offerId, "no_answer", { reason: "timeout" });
    await releaseReservation(tx, first.reservationId, "no_answer");
  });
  await pool.query(`UPDATE acd_agent_state SET workflow_state = 'idle' WHERE agent_id = $1`, [agentA]);

  const second = await withTx((tx) =>
    tryOfferAndReserve(tx, { workItemId: workItem.id, agentId: agentB, channel: "voice", offerDeadlineMs: 30_000 }),
  );
  assert.equal(second.generation, 2);
});

test("router: FIFO picks longest-available, routes and transitions atomically", { skip }, async () => {
  const queue = `queue-${randomUUID().slice(0, 8)}`;
  const idleLong = `agent-${randomUUID().slice(0, 8)}`;
  const idleShort = `agent-${randomUUID().slice(0, 8)}`;
  await seedAgent(idleLong);
  await seedAgent(idleShort);
  await seedQueue(queue, [idleLong, idleShort]);

  // Give idleShort a RECENT released reservation → longer-idle agent must win.
  await pool.query(
    `INSERT INTO acd_reservations (id, agent_id, channel, weight, state, released_at, released_reason)
     VALUES ($1, $2, 'voice', 1.0, 'released', now(), 'test_seed')`,
    [randomUUID(), idleShort],
  );

  const workItem = await makeQueuedWorkItem(queue);
  const result = await routeOne(pool, workItem.id);
  assert.equal(result.routed, true);
  assert.equal(result.agentId, idleLong);

  const wiRow = await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(wiRow.rows[0].state, "offered");
  const agentRow = await pool.query(`SELECT workflow_state FROM acd_agent_state WHERE agent_id = $1`, [idleLong]);
  assert.equal(agentRow.rows[0].workflow_state, "offered");

  // Second routeOne on the same work item: not claimable (state != queued).
  const again = await routeOne(pool, workItem.id);
  assert.deepEqual(again, { routed: false, reason: "not_claimable" });
});

test("router: two concurrent routers, one single-capacity agent → exactly one wins", { skip }, async () => {
  const queue = `queue-${randomUUID().slice(0, 8)}`;
  const onlyAgent = `agent-${randomUUID().slice(0, 8)}`;
  await seedAgent(onlyAgent);
  await seedQueue(queue, [onlyAgent]);

  const itemA = await makeQueuedWorkItem(queue);
  const itemB = await makeQueuedWorkItem(queue);

  const [resultA, resultB] = await Promise.all([
    routeOne(pool, itemA.id),
    routeOne(pool, itemB.id),
  ]);
  const winners = [resultA, resultB].filter((r) => r.routed);
  const losers = [resultA, resultB].filter((r) => !r.routed);
  assert.equal(winners.length, 1, `expected exactly one winner, got: ${JSON.stringify([resultA, resultB])}`);
  assert.equal(winners[0].agentId, onlyAgent);
  assert.ok(["all_reservations_failed", "no_candidates"].includes(losers[0].reason));

  // The loser's failure is observable, not silent.
  const loserId = resultA.routed ? itemB.id : itemA.id;
  const diagnostics = await pool.query(
    `SELECT type FROM acd_events WHERE work_item_id = $1
      AND type IN ('no_agent_reserved', 'reservation_race_lost')`,
    [loserId],
  );
  assert.ok(diagnostics.rows.length >= 1);
});

test("router: empty queue emits observable no_agent_reserved", { skip }, async () => {
  const queue = `queue-${randomUUID().slice(0, 8)}`;
  await seedQueue(queue, []);
  const workItem = await makeQueuedWorkItem(queue);
  const result = await routeOne(pool, workItem.id);
  assert.deepEqual(result, { routed: false, reason: "no_candidates" });
  const event = await pool.query(
    `SELECT payload FROM acd_events WHERE work_item_id = $1 AND type = 'no_agent_reserved'`,
    [workItem.id],
  );
  assert.equal(event.rows.length, 1);
  assert.equal(event.rows[0].payload.reason, "no_queue_members_online");
});

test("skills policy ranks full matches by score with LAA tie-break", { skip: false }, () => {
  const workItem = { required_skills: { english: 3, sales: 2 } };
  const candidates = [
    { agent_id: "a-partial", skills: { english: 5 }, live_weight: 0, last_released_at: null },
    { agent_id: "b-full-low", skills: { english: 3, sales: 2 }, live_weight: 0, last_released_at: null },
    { agent_id: "c-full-high", skills: { english: 5, sales: 5 }, live_weight: 0, last_released_at: null },
  ];
  const ranked = skillsPolicy.rank(candidates, workItem);
  assert.deepEqual(ranked.map((c) => c.agent_id), ["c-full-high", "b-full-low", "a-partial"].slice(0, ranked.length));
  assert.equal(ranked[0].agent_id, "c-full-high");
  assert.equal(ranked[1].agent_id, "b-full-low");
  // Partial matches are excluded while full matches exist.
  assert.equal(ranked.length, 2);

  // Standard skills routing must wait for a full match.
  const partialOnly = skillsPolicy.rank([candidates[0]], workItem);
  assert.deepEqual(partialOnly.map((c) => c.agent_id), []);

  // FIFO determinism.
  const fifo = fifoPolicy.rank([
    { agent_id: "b", live_weight: 0, last_released_at: "2026-08-01T10:00:00Z" },
    { agent_id: "a", live_weight: 0, last_released_at: "2026-08-01T09:00:00Z" },
  ]);
  assert.equal(fifo[0].agent_id, "a");
});

test("segments: queue transfer semantics (close + reopen, work item stays alive)", { skip }, async () => {
  const workItem = await withTx((tx) =>
    createWorkItem(tx, { channel: "voice", direction: "inbound", actor: "test" }),
  );
  await withTx(async (tx) => {
    await applyTransition(tx, { workItemId: workItem.id, to: "queued", eventType: "work_item_queued", actor: "test" });
    await openSegment(tx, { workItemId: workItem.id, kind: "queue_wait", queueId: "q1" });
  });
  await withTx(async (tx) => {
    await closeOpenSegment(tx, workItem.id, { outcome: "answered" });
    await openSegment(tx, { workItemId: workItem.id, kind: "agent", agentId: "agent-x" });
  });
  // Queue transfer: agent segment ends, new queue_wait opens, nothing terminal.
  await withTx(async (tx) => {
    await closeOpenSegment(tx, workItem.id, { outcome: "transferred" });
    await openSegment(tx, { workItemId: workItem.id, kind: "queue_wait", queueId: "q2" });
  });

  const segments = await pool.query(
    `SELECT seq, kind, queue_id, outcome, ended_at FROM acd_segments WHERE work_item_id = $1 ORDER BY seq`,
    [workItem.id],
  );
  assert.deepEqual(
    segments.rows.map((r) => [Number(r.seq), r.kind, r.outcome]),
    [[1, "queue_wait", "answered"], [2, "agent", "transferred"], [3, "queue_wait", null]],
  );
  const wiRow = await pool.query(`SELECT terminal_at FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(wiRow.rows[0].terminal_at, null);
});

test("invariants: clean by default, violations detected when seeded", { skip }, async () => {
  const clean = await checkInvariants(pool);
  assert.deepEqual(clean, {}, `expected no invariant violations, got: ${JSON.stringify(Object.keys(clean))}`);

  // Seed a live reservation on a terminal work item → must be detected.
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
    `INSERT INTO acd_reservations (id, agent_id, work_item_id, channel, weight, state, lease_expires_at)
     VALUES ($1, 'ghost-agent', $2, 'voice', 1.0, 'active', NULL)`,
    [badReservation, workItem.id],
  );
  const dirty = await checkInvariants(pool);
  assert.ok(dirty.live_reservation_on_terminal_work_item);

  await pool.query(`DELETE FROM acd_reservations WHERE id = $1`, [badReservation]);
  assert.deepEqual(await checkInvariants(pool), {});
});

test.after(async () => {
  await pool?.end().catch(() => {});
});
