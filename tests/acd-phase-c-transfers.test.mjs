import { test,after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  prepareAcdTestPool,
  makeTxRunner,
  seedAgent,
  seedQueue,
  makeFakeProvider,
} from "./helpers/acd-test-db.mjs";
import { createWorkItem, applyTransition, openSegment, checkInvariants } from "../lib/acd/lifecycle.mjs";
import { applySagaEvent as applyEngineSagaEvent, driveSaga, sweepDueSagas,clearSagaDeadlineWakeups } from "../lib/acd/saga-engine.mjs";
import {
  startBlindTransferSaga,
  startConsultSaga,
  startQueueTransferSaga,
} from "../lib/acd/sagas/transfers.mjs";
import { routeAcdVoiceEvent } from "../lib/acd/live-intake.mjs";
import { getTransferIntent } from "../lib/acd/transfer-intents.mjs";
import { agentMediaEvidence } from "../lib/acd/agent-media-evidence.mjs";

const pool = await prepareAcdTestPool("acd_core_test_phase_c");
const skip = pool ? false : "PostgreSQL not reachable — skipping Phase C tests";
const withTx = makeTxRunner(pool);
after(async()=>{clearSagaDeadlineWakeups();await pool?.end();});

// These saga unit scenarios inject canonical events. Mirror the leg evidence
// that the signed intake persists before invoking the engine in production.
async function applySagaEvent(db, event) {
  if (event.role && ['leg.answered', 'leg.ended', 'leg.bridged'].includes(event.name)) {
    let leg = (await db.query(`SELECT * FROM acd_legs WHERE work_item_id = $1 AND role = $2 ORDER BY created_at DESC LIMIT 1`, [event.workItemId, event.role])).rows[0];
    if (!leg && ['consult_target', 'transfer_target'].includes(event.role)) {
      const saga = (await db.query(`SELECT id FROM acd_sagas WHERE work_item_id = $1 AND type = $2 ORDER BY created_at DESC LIMIT 1`, [event.workItemId, event.role === 'consult_target' ? 'consult' : 'blind_transfer'])).rows[0];
      leg = (await db.query(`INSERT INTO acd_legs (id, work_item_id, role, provider_call_id, owner_saga_id, state) VALUES ($1,$2,$3,$4,$5,'ringing') RETURNING *`, [randomUUID(), event.workItemId, event.role, `v3:fixture-${randomUUID()}`, saga?.id])).rows[0];
    }
    if (leg) await db.query(`UPDATE acd_legs SET state = $2,
      ended_at = CASE WHEN $2 = 'ended' THEN now() ELSE ended_at END,
      answered_at = CASE WHEN $2 = 'answered' THEN now() ELSE answered_at END,
      bridged_at = CASE WHEN $2 = 'bridged' THEN now() ELSE bridged_at END
      WHERE id = $1`, [leg.id, event.name.split('.')[1]]);
  }
  return applyEngineSagaEvent(db, event);
}

async function confirmConsultantEnded(call,sagaId,provider) {
  const saga=(await pool.query("SELECT state FROM acd_sagas WHERE id=$1",[sagaId])).rows[0];
  assert.ok(["running","compensating"].includes(saga.state),"Hangup acceptance must retain saga ownership");
  assert.equal((await pool.query("SELECT handoff_saga_id FROM acd_work_items WHERE id=$1",[call.workItem.id])).rows[0].handoff_saga_id,sagaId);
  await applySagaEvent(pool,{workItemId:call.workItem.id,name:"leg.ended",role:"consult_target",provider});
}

async function activeCall() {
  const agentId = `agent-${randomUUID().slice(0, 8)}`;
  const queueId = `queue-${randomUUID().slice(0, 8)}`;
  await seedAgent(pool, agentId, { workflowState: "handling" });
  await seedQueue(pool, queueId, [agentId]);
  const ids = {
    customer: `v3:customer-${randomUUID()}`,
    agent: `v3:agent-${randomUUID()}`,
    reservation: randomUUID(),
    offer: randomUUID(),
  };
  const workItem = await withTx(async (tx) => {
    const wi = await createWorkItem(tx, {
      channel: "voice",
      direction: "inbound",
      queueId,
      customerAddress: "+15550001001",
      ccAddress: "+15550001002",
      attributes: {
        engine: "acd_core",
        customer_call_control_id: ids.customer,
        call_session_id: `session-${randomUUID()}`,
      },
      actor: "test",
    });
    await applyTransition(tx, {
      workItemId: wi.id,
      to: "queued",
      eventType: "work_item_queued",
      actor: "test",
      patch: { queueId, enqueuedAt: new Date().toISOString() },
    });
    await applyTransition(tx, {
      workItemId: wi.id,
      to: "offered",
      eventType: "work_item_offered",
      actor: "test",
    });
    await applyTransition(tx, {
      workItemId: wi.id,
      to: "active",
      eventType: "work_item_answered",
      payload: { agent_id: agentId },
      actor: "test",
    });
    await openSegment(tx, {
      workItemId: wi.id,
      kind: "agent",
      queueId,
      agentId,
      answeredAt: new Date().toISOString(),
    });
    await tx.query(
      `INSERT INTO acd_offers
         (id, work_item_id, agent_id, generation, state, deadline_at)
       VALUES ($1, $2, $3, 1, 'accepted', now() + interval '1 hour')`,
      [ids.offer, wi.id, agentId],
    );
    await tx.query(
      `INSERT INTO acd_reservations
         (id, agent_id, work_item_id, channel, state, handling_session_id)
       VALUES ($1, $2, $3, 'voice', 'active', $4)`,
      [ids.reservation, agentId, wi.id, randomUUID()],
    );
    await tx.query(
      `INSERT INTO acd_legs
         (id, work_item_id, role, provider_call_id, state, answered_at)
       VALUES ($1, $2, 'customer', $3, 'bridged', now()),
              ($4, $2, 'agent_device', $5, 'bridged', now())`,
      [randomUUID(), wi.id, ids.customer, randomUUID(), ids.agent],
    );
    return wi;
  });
  return { workItem, agentId, queueId, ids };
}

function baseParams(call, target) {
  return {
    workItemId: call.workItem.id,
    interactionId: call.workItem.id,
    agentId: call.agentId,
    agentUsername: `${call.agentId}@test.local`,
    reservationId: call.ids.reservation,
    offerId: call.ids.offer,
    customerProviderCallId: call.ids.customer,
    agentProviderCallId: call.ids.agent,
    connectionId: "connection-test",
    fromNumber: "+15550001002",
    target,
    targetKind: "manual",
    sourceQueueId: call.queueId,
    sourceQueueName: "Source Core",
    sourceQueueEngineOwner: "acd_core",
    sourceQueueAudioMediaName: "source-queue-hold",
  };
}

test("Phase C intents authorize from the live Core agent segment", { skip }, async () => {
  const call = await activeCall();
  assert.equal(
    await getTransferIntent(pool, {
      interactionId: call.workItem.id,
      username: `${call.agentId}@test.local`,
    }),
    null,
  );
  await assert.rejects(
    getTransferIntent(pool, {
      interactionId: call.workItem.id,
      username: "other-agent@test.local",
    }),
    (error) => error?.code === "ACD_NOT_OWNER" && error?.status === 403,
  );
});

test("Phase C rejects transfers for credential-only direct calls without a customer leg", { skip }, async () => {
  const call = await activeCall();
  await pool.query(`DELETE FROM acd_legs WHERE work_item_id=$1 AND role='customer'`, [call.workItem.id]);
  await pool.query(`UPDATE acd_work_items
    SET queue_id=NULL, attributes=attributes || '{"voice_occupancy_kind":"direct_inbound","transfer_capable":false}'::jsonb
    WHERE id=$1`, [call.workItem.id]);
  await assert.rejects(
    getTransferIntent(pool, {
      interactionId: call.workItem.id,
      username: `${call.agentId}@test.local`,
    }),
    (error) => error?.code === "ACD_TOPOLOGY_INCOMPLETE"
      && /Voice API/.test(error.message),
  );
});

test("Phase C transfers a queue-less Voice API direct call and skips wrap-up", { skip }, async () => {
  const call = await activeCall();
  await pool.query(`UPDATE acd_work_items
    SET queue_id=NULL, attributes=attributes || '{"voice_occupancy_kind":"direct_inbound","transfer_capable":true,"suppress_wrapup":true}'::jsonb
    WHERE id=$1`, [call.workItem.id]);
  const targetCcid = `v3:direct-target-${randomUUID()}`;
  const provider = makeFakeProvider([
    { outcome: "accepted", response: { data: { call_control_id: targetCcid } } },
  ]);
  const { sagaId } = await withTx((tx) =>
    startBlindTransferSaga(tx, baseParams(call, "+15550001995")),
  );
  await driveSaga(pool, sagaId, { provider });
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.answered",
    role: "transfer_target",
    provider,
  });
  assert.equal((await pool.query(`SELECT state FROM acd_work_items WHERE id=$1`,
    [call.workItem.id])).rows[0].state, "completed");
  assert.deepEqual((await pool.query(`SELECT workflow_state,workflow_work_item_id
    FROM acd_agent_state WHERE agent_id=$1`, [call.agentId])).rows[0], {
    workflow_state: "idle",
    workflow_work_item_id: null,
  });
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`,
    [call.ids.reservation])).rows[0].state, "released");
});

test("Phase C blind transfer finalizes the agent and keeps symmetric leg teardown ownership", { skip }, async () => {
  const call = await activeCall();
  const targetCcid = `v3:target-${randomUUID()}`;
  const provider = makeFakeProvider([
    { outcome: "accepted", response: { data: { call_control_id: targetCcid } } },
  ]);
  const { sagaId } = await withTx((tx) =>
    startBlindTransferSaga(tx, {
      ...baseParams(call, "+15550001999"),
      targetLabel: "External support",
    }),
  );
  const driven = await driveSaga(pool, sagaId, { provider });
  assert.equal(driven.step, "await_target");
  assert.equal((await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [call.workItem.id])).rows[0].state, "active");

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.answered",
    role: "transfer_target",
    provider,
  });
  const workItem = (await pool.query(`SELECT state, terminal_reason FROM acd_work_items WHERE id = $1`, [call.workItem.id])).rows[0];
  assert.deepEqual(workItem, { state: "completed", terminal_reason: "blind_transfer" });
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id = $1`, [call.ids.reservation])).rows[0].state, "released");
  assert.equal((await pool.query(`SELECT workflow_state FROM acd_agent_state WHERE agent_id = $1`, [call.agentId])).rows[0].workflow_state, "wrapup");
  assert.deepEqual(
    (await pool.query(`SELECT state, step FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0],
    { state: "running", step: "monitor_transfer" },
  );
  const transferEvent = (
    await pool.query(
      `SELECT payload FROM acd_events
        WHERE work_item_id = $1 AND type = 'work_item_transferred'
        ORDER BY id DESC LIMIT 1`,
      [call.workItem.id],
    )
  ).rows[0];
  assert.equal(transferEvent.payload.target_label, "External support");

  provider.calls.length = 0;
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "transfer_target",
    provider,
  });
  assert.equal(provider.calls[0].operation, "blind_transfer_hangup_customer");
  assert.match(provider.calls[0].endpoint, new RegExp(encodeURIComponent(call.ids.customer)));
  assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state, "running", "HTTP acceptance retains media ownership");
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.ended", role: "customer", provider });
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state,
    "succeeded",
  );
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C blind transfer hangs up the destination when the customer ends first", { skip }, async () => {
  const call = await activeCall();
  const targetCcid = `v3:target-${randomUUID()}`;
  const provider = makeFakeProvider([
    { outcome: "accepted", response: { data: { call_control_id: targetCcid } } },
  ]);
  const { sagaId } = await withTx((tx) =>
    startBlindTransferSaga(tx, baseParams(call, "+15550001996")),
  );
  await driveSaga(pool, sagaId, { provider });
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.answered",
    role: "transfer_target",
    provider,
  });

  provider.calls.length = 0;
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "customer",
    provider,
  });
  assert.equal(provider.calls[0].operation, "blind_transfer_hangup_target");
  assert.match(provider.calls[0].endpoint, new RegExp(encodeURIComponent(targetCcid)));
  assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state, "running", "HTTP acceptance retains media ownership");
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.ended", role: "transfer_target", provider });
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state,
    "succeeded",
  );
});

test("Phase C rejected blind transfer preserves the original active conversation", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider([{ outcome: "failed", error: "target rejected" }]);
  const { sagaId } = await withTx((tx) =>
    startBlindTransferSaga(tx, baseParams(call, "+15550001998")),
  );
  await driveSaga(pool, sagaId, { provider });
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state,
    "cancelled",
  );
  assert.equal(
    (await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [call.workItem.id])).rows[0].state,
    "active",
  );
  assert.equal(
    (await pool.query(`SELECT state FROM acd_reservations WHERE id = $1`, [call.ids.reservation])).rows[0].state,
    "active",
  );
});

test("Phase C blind target no-answer requeues the customer to the source queue", { skip }, async () => {
  const call = await activeCall();
  const targetCcid = `v3:target-${randomUUID()}`;
  const provider = makeFakeProvider([
    { outcome: "accepted", response: { data: { call_control_id: targetCcid } } },
    { outcome: "accepted", response: {} },
  ]);
  const { sagaId } = await withTx((tx) =>
    startBlindTransferSaga(tx, baseParams(call, "+15550001997")),
  );
  await driveSaga(pool, sagaId, { provider });
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "transfer_target",
    provider,
  });
  assert.equal(provider.calls.at(-1).operation, "blind_transfer_requeue_source");
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.enqueued",
    role: "customer",
    provider,
  });
  const workItem = (
    await pool.query(`SELECT state, queue_id FROM acd_work_items WHERE id = $1`, [call.workItem.id])
  ).rows[0];
  assert.deepEqual(workItem, { state: "queued", queue_id: call.queueId });
  assert.equal(
    (await pool.query(`SELECT workflow_state FROM acd_agent_state WHERE agent_id = $1`, [call.agentId])).rows[0].workflow_state,
    "wrapup",
  );
  const source = (await pool.query(`SELECT ended_at,wrapup_ended_at,wrapup_deadline_at FROM acd_segments
    WHERE work_item_id=$1 AND agent_id=$2 AND kind='agent'`,[call.workItem.id,call.agentId])).rows[0];
  assert.ok(source.ended_at);assert.equal(source.wrapup_ended_at,null);assert.ok(source.wrapup_deadline_at);
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C queue transfer reopens a Core queue segment and preserves a live work item", { skip }, async () => {
  const call = await activeCall();
  const targetQueueId = `queue-${randomUUID().slice(0, 8)}`;
  const targetAgentId = `agent-${randomUUID().slice(0, 8)}`;
  await seedAgent(pool, targetAgentId);
  await seedQueue(pool, targetQueueId, [targetAgentId], { name: "Target Core" });
  const provider = makeFakeProvider();
  const { sagaId } = await withTx((tx) =>
    startQueueTransferSaga(tx, {
      ...baseParams(call, targetQueueId),
      targetQueueId,
      targetQueueName: "Target Core",
    }),
  );
  const driven = await driveSaga(pool, sagaId, { provider });
  assert.equal(driven.waiting, "confirmation");
  const routedEvent = await routeAcdVoiceEvent(
    pool,
    provider,
    {
      eventId: `evt-${randomUUID()}`,
      eventType: "call.enqueued",
      occurredAt: new Date().toISOString(),
      payload: {
        queue: "Target Core",
        call_control_id: call.ids.customer,
        call_session_id: call.workItem.attributes.call_session_id,
        from: "+15550001001",
        to: "+15550001002",
      },
    },
    { node: "phase-c-core-transfer" },
  );
  assert.equal(routedEvent.handled, true);
  assert.equal(routedEvent.error, undefined, JSON.stringify(routedEvent));
  const workItem = (await pool.query(`SELECT state, queue_id, terminal_at FROM acd_work_items WHERE id = $1`, [call.workItem.id])).rows[0];
  assert.equal(workItem.state, "offered");
  assert.equal(workItem.queue_id, targetQueueId);
  assert.equal(workItem.terminal_at, null);
  const segments = await pool.query(`SELECT kind, queue_id, outcome, ended_at FROM acd_segments WHERE work_item_id = $1 ORDER BY seq`, [call.workItem.id]);
  assert.equal(segments.rows.at(-1).kind, "queue_wait");
  assert.equal(segments.rows.at(-1).queue_id, targetQueueId);
  assert.equal(segments.rows[0].outcome, "transferred");
  const latestOffer = await pool.query(
    `SELECT agent_id, state FROM acd_offers
      WHERE work_item_id = $1 ORDER BY generation DESC LIMIT 1`,
    [call.workItem.id],
  );
  assert.deepEqual(latestOffer.rows[0], {
    agent_id: targetAgentId,
    state: "ringing",
  });
  assert.equal((await pool.query(`SELECT workflow_state FROM acd_agent_state WHERE agent_id = $1`, [call.agentId])).rows[0].workflow_state, "wrapup");
  assert.equal((await pool.query(`SELECT workflow_state FROM acd_agent_state WHERE agent_id = $1`, [targetAgentId])).rows[0].workflow_state, "offered");
  assert.deepEqual(await checkInvariants(pool), {});
});

for (const preserveRoutingOptions of [true, false, undefined]) {
  test(`Phase C queue transfer applies routing options only on confirmation: ${preserveRoutingOptions}`, { skip }, async () => {
    const call = await activeCall();
    const targetQueueId = `queue-${randomUUID().slice(0, 8)}`;
    await seedQueue(pool, targetQueueId, []);
    const original = { priority: 5, required_skills: { old: 4 }, attributes: {
      ...call.workItem.attributes,
      client_state: { call_priority: 5, required_skills: { old: 4 }, retained: 'yes' },
      routing_requirements: { source: 'flow', original: { old: 4 }, unknown: ['old'], invalid: [] },
    } };
    await pool.query(`UPDATE acd_work_items SET priority=$2, required_skills=$3, attributes=$4 WHERE id=$1`,
      [call.workItem.id, original.priority, original.required_skills, original.attributes]);
    // An unknown destination requirement must remain blocking after reset.
    await pool.query(`UPDATE cc_queues SET skill_requirements=$2 WHERE id=$1`, [targetQueueId, { destination: 3 }]);
    const read = async () => (await pool.query(`SELECT priority,required_skills,attributes FROM acd_work_items WHERE id=$1`, [call.workItem.id])).rows[0];
    const provider = makeFakeProvider();
    const { sagaId } = await withTx(tx => startQueueTransferSaga(tx, {
      ...baseParams(call, targetQueueId), targetQueueId, targetQueueName: targetQueueId, preserveRoutingOptions,
    }));
    await driveSaga(pool, sagaId, { provider });
    assert.deepEqual(await read(), original);
    await applySagaEvent(pool, { workItemId: call.workItem.id, name: 'leg.enqueued', role: 'customer', provider });
    const after = await read();
    assert.equal(after.priority, preserveRoutingOptions === false ? 0 : 5);
    assert.deepEqual(after.required_skills, preserveRoutingOptions === false ? { destination: 3 } : original.required_skills);
    assert.deepEqual(after.attributes.routing_requirements, preserveRoutingOptions === false
      ? { source: 'queue', original: { destination: 3 }, unknown: ['destination'], invalid: [] }
      : original.attributes.routing_requirements);
    assert.deepEqual(after.attributes.client_state, preserveRoutingOptions === false ? { retained: 'yes' } : original.attributes.client_state);
    await applySagaEvent(pool, { workItemId: call.workItem.id, name: 'leg.enqueued', role: 'customer', provider });
    assert.deepEqual(await read(), after);
  });
}

test("Phase C rejected queue transfer preserves the original conversation", { skip }, async () => {
  const call = await activeCall();
  const targetQueueId = `queue-${randomUUID().slice(0, 8)}`;
  await seedQueue(pool, targetQueueId, [], { name: "Rejected Core" });
  await pool.query(`UPDATE acd_work_items SET priority=5, required_skills='{"original":4}'::jsonb WHERE id=$1`, [call.workItem.id]);
  const provider = makeFakeProvider([{ outcome: "failed", error: "enqueue rejected" }]);
  const { sagaId } = await withTx((tx) =>
    startQueueTransferSaga(tx, {
      ...baseParams(call, targetQueueId),
      targetQueueId,
      targetQueueName: "Rejected Core",
      preserveRoutingOptions: false,
    }),
  );
  await driveSaga(pool, sagaId, { provider });
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state,
    "cancelled",
  );
  assert.equal(
    (await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [call.workItem.id])).rows[0].state,
    "active",
  );
  assert.deepEqual((await pool.query(`SELECT priority,required_skills FROM acd_work_items WHERE id=$1`, [call.workItem.id])).rows[0],
    { priority: 5, required_skills: { original: 4 } });
});

async function bindBrowserConsultOriginator(call, sagaId, provider) {
  const browserCcid = `v3:consult-browser-${randomUUID()}`;
  await pool.query(
    `INSERT INTO acd_legs
       (id, work_item_id, role, agent_id, provider_call_id, owner_saga_id, state)
     VALUES ($1, $2, 'agent_device', $3, $4, $5, 'dialing')`,
    [randomUUID(), call.workItem.id, call.agentId, browserCcid, sagaId],
  );
  await pool.query(
    `UPDATE acd_sagas
        SET data = data || jsonb_build_object('agentProviderCallId', $2::text)
      WHERE id = $1`,
    [sagaId, browserCcid],
  );
  await applyEngineSagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.initiated",
    role: "agent_device",
    payload: { owner_saga_id: sagaId, provider_call_id: browserCcid },
    provider,
  });
  return browserCcid;
}

test("Phase C rejected consultation restores an unanswered source browser from the answered customer", { skip }, async () => {
  const call = await activeCall(), provider = makeFakeProvider();
  const { sagaId } = await withTx(tx => startConsultSaga(tx, baseParams(call, "+15550001777")));
  await driveSaga(pool, sagaId, { provider });
  const browserCcid = await bindBrowserConsultOriginator(call, sagaId, provider);
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: 'leg.ended', role: 'consult_target', provider });
  const restore = provider.calls.find(c => c.operation === 'consult_restore_customer');
  assert.ok(restore);
  assert.ok(restore.endpoint.includes(encodeURIComponent(call.ids.customer)));
  assert.equal(restore.request.call_control_id, browserCcid);
  assert.equal(restore.request.park_after_unbridge, 'self');
  assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id=$1`, [sagaId])).rows[0].state, 'compensating');
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: 'leg.bridged', role: 'customer', provider });
  assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id=$1`, [sagaId])).rows[0].state, 'cancelled');
  assert.equal((await pool.query(`SELECT state FROM acd_work_items WHERE id=$1`, [call.workItem.id])).rows[0].state, 'active');
});

test("Phase C target capacity evidence excludes the source agent sharing its consult saga", { skip }, async () => {
  const call = await activeCall(), provider = makeFakeProvider();
  const { sagaId } = await withTx(tx => startConsultSaga(tx, baseParams(call, "+15550001777")));
  await driveSaga(pool, sagaId, { provider });
  await bindBrowserConsultOriginator(call, sagaId, provider);
  const target = `agent-${randomUUID()}`, targetLeg = randomUUID();
  await seedAgent(pool, target);
  await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,agent_id,owner_saga_id,state)
    VALUES($1,$2,'consult_target',$3,$4,$5,'ringing')`, [targetLeg,call.workItem.id,`v3:${randomUUID()}`,target,sagaId]);
  const reservation = { id: randomUUID(), channel:'voice', work_item_id:call.workItem.id, owner_saga_id:sagaId, agent_id:target };
  assert.equal((await agentMediaEvidence(pool, reservation)).leg.id, targetLeg);
  await pool.query(`UPDATE acd_legs SET ended_at=now(),state='ended' WHERE id=$1`, [targetLeg]);
  assert.equal((await agentMediaEvidence(pool, reservation)).ended, true);
});

test("Phase C early target bridge cannot skip the explicit consultation bridge", { skip }, async () => {
  const call = await activeCall(), provider = makeFakeProvider();
  const { sagaId } = await withTx(tx => startConsultSaga(tx, baseParams(call, "+15550001777")));
  await driveSaga(pool, sagaId, { provider });
  const browserCcid = await bindBrowserConsultOriginator(call, sagaId, provider);
  const targetCcid = `v3:${randomUUID()}`, transportCcid = `v3:${randomUUID()}`;
  await pool.query("UPDATE acd_sagas SET data=data || $2::jsonb WHERE id=$1",
    [sagaId, JSON.stringify({ target: "sip:consultant@test.invalid", targetKind: "agents", targetUserId: "consultant" })]);
  for (const [role, ccid] of [["consult_target", targetCcid], ["consult_transport", transportCcid]]) {
    await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,owner_saga_id,state)
      VALUES($1,$2,$3,$4,$5,'ringing')`, [randomUUID(), call.workItem.id, role, ccid, sagaId]);
  }
  // Device-to-transport bridge notifications may precede call.answered. They
  // do not establish that the fresh source browser is connected to B.
  for (const role of ["consult_target", "consult_transport", "consult_target"]) {
    await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.bridged", role,
      payload: { owner_saga_id: sagaId }, provider });
    assert.equal((await pool.query("SELECT step FROM acd_sagas WHERE id=$1", [sagaId])).rows[0].step, "await_target");
  }
  assert.equal((await pool.query("SELECT id FROM acd_events WHERE work_item_id=$1 AND type='consult_connected'", [call.workItem.id])).rowCount, 0);
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.answered", role: "consult_target",
    payload: { owner_saga_id: sagaId }, provider });
  const bridges = provider.calls.filter(c => c.operation === "consult_bridge_initial_target");
  assert.equal(bridges.length, 1);
  assert.ok(bridges[0].endpoint.includes(encodeURIComponent(transportCcid)));
  assert.equal(bridges[0].request.call_control_id, browserCcid);
  assert.equal((await pool.query("SELECT step FROM acd_sagas WHERE id=$1", [sagaId])).rows[0].step, "await_target_bridge");
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.bridged", role: "consult_transport",
    payload: { owner_saga_id: sagaId }, provider });
  assert.equal((await pool.query("SELECT step FROM acd_sagas WHERE id=$1", [sagaId])).rows[0].step, "in_consult");
});

async function activeConsult(call, provider) {
  const targetCcid = `v3:consult-${randomUUID()}`;
  provider.calls.length = 0;
  const { sagaId } = await withTx((tx) =>
    startConsultSaga(tx, baseParams(call, "+15550001777")),
  );
  await driveSaga(pool, sagaId, { provider });
  assert.equal(provider.calls[0].operation, "consult_release_source_agent");
  assert.equal(
    (await pool.query(`SELECT step FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].step,
    "await_browser_originator",
  );
  const browserCcid = await bindBrowserConsultOriginator(
    call,
    sagaId,
    provider,
  );
  const dial = provider.calls.find((entry) => entry.operation === "consult_dial");
  assert.equal(
    dial.request.park_after_unbridge,
    undefined,
    "Dial must not combine park_after_unbridge with an explicit post-answer bridge",
  );
  assert.equal(dial.request.bridge_on_answer, undefined);
  assert.equal(dial.request.link_to, undefined);
  assert.equal(
    dial.request.bridge_intent,
    undefined,
    "PSTN consult Dial must not bind its lifecycle to the browser bridge",
  );
  await pool.query(
    `INSERT INTO acd_legs
       (id, work_item_id, role, provider_call_id, owner_saga_id, state)
     VALUES ($1, $2, 'consult_target', $3, $4, 'ringing')
     ON CONFLICT (provider_call_id) DO NOTHING`,
    [randomUUID(), call.workItem.id, targetCcid, sagaId],
  );
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.initiated",
    role: "consult_target",
    provider,
  });
  assert.equal(
    provider.calls.some(
      (entry) => entry.operation === "consult_start_customer_hold_audio",
    ),
    true,
    "customer hold media must start after the source browser leg is released",
  );

  await pool.query(
    `UPDATE acd_legs SET answered_at = now(), state = 'answered'
      WHERE provider_call_id = $1`,
    [targetCcid],
  );
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.answered",
    role: "consult_target",
    provider,
  });
  const initialBridge = provider.calls.find(
    (entry) => entry.operation === "consult_bridge_initial_target",
  );
  assert.ok(initialBridge, "Core must explicitly establish the initial consult bridge");
  assert.match(
    initialBridge.endpoint,
    new RegExp(`${encodeURIComponent(targetCcid)}/actions/bridge$`),
  );
  assert.equal(initialBridge.request.call_control_id, browserCcid);
  assert.equal(initialBridge.request.park_after_unbridge, "self");
  await pool.query(
    `UPDATE acd_legs SET bridged_at = now(), state = 'bridged'
      WHERE provider_call_id = $1`,
    [targetCcid],
  );
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "consult_target",
    provider,
  });
  assert.deepEqual(
    (await pool.query(`SELECT state, step FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0],
    { state: "running", step: "in_consult" },
  );
  const hold = provider.calls.find((entry) =>
    entry.operation === "consult_start_customer_hold_audio",
  );
  assert.match(hold.endpoint, new RegExp(`${encodeURIComponent(call.ids.customer)}/actions/playback_start$`));
  assert.equal(hold.request.media_name, "source-queue-hold");
  assert.equal(hold.request.loop, "infinity");
  return { sagaId, targetCcid, browserCcid };
}

test("Phase C consult ignores the WebRTC transport sibling hangup", { skip }, async () => {
  const call = await activeCall();
  const transportCcid = `v3:consult-transport-${randomUUID()}`;
  const provider = makeFakeProvider([
    {
      outcome: "accepted",
      httpStatus: 200,
      response: { data: { call_control_id: transportCcid } },
    },
  ]);
  const targetAgentId = `consult-user-${randomUUID()}`;
  await seedAgent(pool, targetAgentId, { telephonyUserName: "consult-user" });
  const { sagaId } = await withTx((tx) =>
    startConsultSaga(tx, {
      ...baseParams(call, "sip:consult-user@test.invalid"),
      targetKind: "agents",
      targetUserId: targetAgentId,
    }),
  );
  await driveSaga(pool, sagaId, { provider });
  await bindBrowserConsultOriginator(call, sagaId, provider);

  const dial = provider.calls.find((entry) => entry.operation === "consult_dial");
  assert.equal(dial.request.link_to, undefined,
    "A WebRTC consult transport must survive when the source browser switches away");
  assert.equal(dial.request.bridge_intent, undefined,
    "Consult transport lifecycle must not remain bound to the source browser");
  assert.equal(dial.request.bridge_on_answer, undefined);
  assert.equal(dial.request.park_after_unbridge, undefined);
  assert.equal(dial.request.custom_headers.some(header =>
    header.name === "X-CC-Direct-Agent-User-Id" && header.value === targetAgentId), true);


  const transport = (
    await pool.query(
      `SELECT role FROM acd_legs WHERE provider_call_id = $1`,
      [transportCcid],
    )
  ).rows[0];
  assert.equal(transport.role, "consult_transport");

  await pool.query(
    `UPDATE acd_legs SET state = 'ended', ended_at = now()
      WHERE provider_call_id = $1`,
    [transportCcid],
  );
  const advanced = await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "consult_transport",
    provider,
  });
  assert.equal(advanced, null);
  const saga = (
    await pool.query(`SELECT state, step FROM acd_sagas WHERE id = $1`, [sagaId])
  ).rows[0];
  assert.equal(saga.state, "running");
  assert.equal(saga.step, "await_target");
});

test("Phase C treats a user's PSTN number as the protected consult target", { skip }, async () => {
  const call = await activeCall();
  const targetCcid = `v3:user-pstn-consult-${randomUUID()}`;
  const provider = makeFakeProvider([
    {
      outcome: "accepted",
      httpStatus: 200,
      response: { data: { call_control_id: targetCcid } },
    },
  ]);
  const targetAgentId = `consult-user-${randomUUID()}`;
  await seedAgent(pool, targetAgentId, { telephonyUserName: "consult-user" });
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_number TEXT`);
  await pool.query(`UPDATE users SET voice_number = '+15550001998' WHERE id = $1`, [targetAgentId]);
  const { sagaId } = await withTx((tx) =>
    startConsultSaga(tx, {
      ...baseParams(call, "+15550001998"),
      targetKind: "agents",
      targetUserId: targetAgentId,
      targetUsername: "consult.user@test.local",
    }),
  );
  await driveSaga(pool, sagaId, { provider });
  const browserCcid = await bindBrowserConsultOriginator(
    call,
    sagaId,
    provider,
  );

  assert.equal(
    (await pool.query(
      `SELECT role FROM acd_legs WHERE provider_call_id = $1`,
      [targetCcid],
    )).rows[0].role,
    "consult_target",
  );
  assert.equal(
    provider.calls.find((entry) => entry.operation === "consult_dial").request.custom_headers.some(
      (header) => header.name === "X-CC-Direct-Agent-Call",
    ),
    false,
  );
});

test("Phase C does not apply agent capacity to a manual number that matches a user", { skip }, async () => {
  const call = await activeCall();
  const targetCcid = `v3:manual-number-${randomUUID()}`;
  const targetAgentId = `manual-number-user-${randomUUID()}`;
  await seedAgent(pool, targetAgentId, { telephonyUserName: "manual-number-user" });
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_number TEXT`);
  await pool.query(`UPDATE users SET voice_number = '+15550001997' WHERE id = $1`, [targetAgentId]);

  // Occupy the matching user's only voice slot. A manual transfer must still
  // dial the external number and must not create a target reservation.
  await pool.query(
    `UPDATE users SET max_concurrent_calls = 0 WHERE id = $1`,
    [targetAgentId],
  );
  const provider = makeFakeProvider([{
    outcome: "accepted",
    httpStatus: 200,
    response: { data: { call_control_id: targetCcid } },
  }]);
  const { sagaId } = await withTx((tx) =>
    startConsultSaga(tx, {
      ...baseParams(call, "+15550001997"),
      targetKind: "manual",
    }),
  );
  await driveSaga(pool, sagaId, { provider });

  assert.equal(provider.calls[0].operation, "consult_release_source_agent");
  await bindBrowserConsultOriginator(call, sagaId, provider);
  assert.equal(
    provider.calls.find((entry) => entry.operation === "consult_dial").request.link_to,
    undefined,
  );
  assert.equal(
    (await pool.query(
      `SELECT data->>'targetReservationId' AS reservation_id FROM acd_sagas WHERE id = $1`,
      [sagaId],
    )).rows[0].reservation_id,
    null,
  );
});

test("Phase C browser-originated consult parks the customer before dialing the target", { skip }, async () => {
  const call = await activeCall();
  const targetCcid = `v3:manual-consult-${randomUUID()}`;
  const provider = makeFakeProvider([
    {
      outcome: "accepted",
      httpStatus: 200,
      response: { data: { call_control_id: targetCcid } },
    },
  ]);
  const { sagaId } = await withTx((tx) =>
    startConsultSaga(tx, {
      ...baseParams(call, "+15550001999"),
      targetKind: "manual",
    }),
  );
  await driveSaga(pool, sagaId, { provider });
  assert.equal(provider.calls[0].operation, "consult_release_source_agent");
  assert.deepEqual(
    (await pool.query(`SELECT state, step FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0],
    { state: "running", step: "await_browser_originator" },
  );
  assert.equal(
    provider.calls.some(
      ({ operation }) => operation === "consult_start_customer_hold_audio",
    ),
    true,
  );

  provider.calls.length = 0;
  const browserCcid = await bindBrowserConsultOriginator(call, sagaId, provider);
  const dial = provider.calls.find(({ operation }) => operation === "consult_dial");
  assert.equal(dial.request.link_to, undefined);
  assert.equal(dial.request.bridge_intent, undefined);
  assert.equal(dial.request.bridge_on_answer, undefined);
  assert.equal(dial.request.park_after_unbridge, undefined);
});

test("Phase C binds the browser consult leg from signed Core headers", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId } = await withTx((tx) =>
    startConsultSaga(tx, baseParams(call, "+15550001995")),
  );
  await driveSaga(pool, sagaId, { provider });
  const intent = await getTransferIntent(pool, {
    interactionId: call.workItem.id,
    username: `${call.agentId}@test.local`,
  });
  assert.equal(intent.step, "await_browser_originator");
  assert.equal(intent.browserCall.destinationNumber, "+15550001995");

  const browserCcid = `v3:header-consult-${randomUUID()}`;
  const admitted = await routeAcdVoiceEvent(
    pool,
    provider,
    {
      eventId: `evt-${randomUUID()}`,
      eventType: "call.initiated",
      occurredAt: new Date().toISOString(),
      payload: {
        call_control_id: browserCcid,
        call_session_id: `session-${randomUUID()}`,
        direction: "outgoing",
        custom_headers: intent.browserCall.customHeaders,
      },
    },
    { node: "test" },
  );
  assert.equal(admitted.outcome, "applied");
  assert.equal(admitted.skipAdapterEffects, true);
  assert.equal(
    provider.calls.find(({ operation }) => operation === "consult_dial").request.link_to,
    undefined,
  );
  const source = (await pool.query(
    `SELECT role, agent_id, owner_saga_id
       FROM acd_legs WHERE provider_call_id = $1`,
    [browserCcid],
  )).rows[0];
  assert.deepEqual(source, {
    role: "agent_device",
    agent_id: call.agentId,
    owner_saga_id: sagaId,
  });
});

test("Phase C consult announces hold state and repeats the configured TTS message", { skip }, async () => {
  const call = await activeCall();
  const targetCcid = `v3:announcement-consult-${randomUUID()}`;
  const provider = makeFakeProvider([{
    outcome: "accepted",
    httpStatus: 200,
    response: { data: { call_control_id: targetCcid } },
  }]);
  const { sagaId } = await withTx((tx) =>
    startConsultSaga(tx, {
      ...baseParams(call, "+15550001996"),
      sourceQueueAudioMediaName: null,
      consultHoldMediaName: null,
      consultHoldAnnouncementEnabled: true,
      consultHoldAnnouncementText: "Please hold for the consultation.",
      consultHoldAnnouncementVoice: "Telnyx.Ultra.test-voice",
      consultHoldAnnouncementLanguage: "en-US",
      consultHoldAnnouncementIntervalSeconds: 10,
    }),
  );
  await driveSaga(pool, sagaId, { provider });
  await bindBrowserConsultOriginator(call, sagaId, provider);
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.initiated",
    role: "consult_target",
    provider,
  });

  assert.equal(
    provider.calls.some(
      ({ operation }) => operation === "consult_speak_customer_hold_announcement",
    ),
    true,
    "announcement must start after the source browser leg is released",
  );

  await pool.query(
    `UPDATE acd_legs SET answered_at = now(), state = 'answered'
      WHERE provider_call_id = $1`,
    [targetCcid],
  );
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.answered",
    role: "consult_target",
    provider,
  });
  await pool.query(
    `UPDATE acd_legs SET bridged_at = now(), state = 'bridged'
      WHERE provider_call_id = $1`,
    [targetCcid],
  );
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "consult_target",
    provider,
  });
  const initialSpeak = provider.calls.find(
    ({ operation }) => operation === "consult_speak_customer_hold_announcement",
  );
  assert.match(initialSpeak.endpoint, new RegExp(`${encodeURIComponent(call.ids.customer)}/actions/speak$`));
  assert.deepEqual(initialSpeak.request, {
    payload: "Please hold for the consultation.",
    voice: "Telnyx.Ultra.test-voice",
    target_legs: "self",
    language: "en-US",
  });
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "media.speak_ended",
    role: "customer",
    provider,
  });
  assert.equal(
    (await pool.query(`SELECT step FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].step,
    "in_consult",
  );

  const speakCount = provider.calls.filter(
    ({ operation }) => operation === "consult_speak_customer_hold_announcement",
  ).length;
  await pool.query(`UPDATE acd_sagas SET deadline_at = now() - interval '1 second' WHERE id = $1`, [sagaId]);
  await sweepDueSagas(pool, { provider, node: "announcement-test" });
  assert.equal(
    provider.calls.filter(
      ({ operation }) => operation === "consult_speak_customer_hold_announcement",
    ).length,
    speakCount + 1,
  );
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "media.speak_ended",
    role: "customer",
    provider,
  });
  assert.equal(
    (await pool.query(`SELECT step FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].step,
    "in_consult",
  );

  const targetSpeakCount = provider.calls.filter(
    ({ operation }) => operation === "consult_speak_consultant_hold_announcement",
  ).length;
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.switch_customer",
    provider,
    actor: "agent",
  });
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "customer",
    provider,
  });
  const targetSpeak = provider.calls.filter(
    ({ operation }) => operation === "consult_speak_consultant_hold_announcement",
  );
  assert.equal(targetSpeak.length, targetSpeakCount + 1);
  assert.match(
    targetSpeak.at(-1).endpoint,
    new RegExp(`${encodeURIComponent(targetCcid)}/actions/speak$`),
  );
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "media.speak_ended",
    role: "consult_target",
    provider,
  });
  assert.equal(
    (await pool.query(`SELECT step FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].step,
    "in_consult",
  );
});

test("Phase C consult switches legs and cancel restores the customer", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId, targetCcid, browserCcid } = await activeConsult(call, provider);
  let saga = (await pool.query(`SELECT step, data FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0];
  assert.equal(saga.step, "in_consult");
  assert.equal(saga.data.activeLeg, "consultant");
  const handoff = (
    await pool.query(`SELECT handoff_saga_id, attributes FROM acd_work_items WHERE id = $1`, [call.workItem.id])
  ).rows[0];
  assert.equal(handoff.handoff_saga_id, sagaId);
  assert.equal(handoff.attributes.handoff_pending, undefined);
  assert.equal(handoff.attributes.handoff_saga_id, undefined);

  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "intent.switch_customer", provider, actor: "agent" });
  const switchCustomer = provider.calls.find((entry) => entry.operation === "consult_switch_customer");
  assert.equal(switchCustomer.request.park_after_unbridge, "self");
  assert.match(
    switchCustomer.endpoint,
    new RegExp(`${encodeURIComponent(call.ids.customer)}/actions/bridge$`),
  );
  assert.equal(switchCustomer.request.call_control_id, browserCcid);
  assert.equal(switchCustomer.request.prevent_double_bridge, undefined);
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.bridged", role: "customer", provider });
  saga = (await pool.query(`SELECT step, data FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0];
  assert.equal(saga.step, "in_consult");
  assert.equal(saga.data.activeLeg, "parked");
  const consultantHold = provider.calls.find(
    (entry) => entry.operation === "consult_start_consultant_hold_audio",
  );
  assert.match(
    consultantHold.endpoint,
    new RegExp(`${encodeURIComponent(targetCcid)}/actions/playback_start$`),
  );
  assert.equal(consultantHold.request.media_name, "source-queue-hold");

  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "intent.switch_consultant", provider, actor: "agent" });
  const consultantStop = provider.calls.find(
    (entry) => entry.operation === "consult_stop_consultant_hold_audio",
  );
  assert.match(
    consultantStop.endpoint,
    new RegExp(`${encodeURIComponent(targetCcid)}/actions/playback_stop$`),
  );
  const switchConsultant = provider.calls.find((entry) => entry.operation === "consult_switch_target");
  assert.equal(switchConsultant.request.park_after_unbridge, "self");
  assert.match(
    switchConsultant.endpoint,
    new RegExp(`${encodeURIComponent(targetCcid)}/actions/bridge$`),
  );
  assert.equal(switchConsultant.request.call_control_id, browserCcid);
  assert.equal(switchConsultant.request.prevent_double_bridge, undefined);
  await pool.query(
    `UPDATE acd_legs SET bridged_at = now(), state = 'bridged'
      WHERE provider_call_id = $1`,
    [targetCcid],
  );
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.bridged", role: "consult_target", provider });
  saga = (await pool.query(`SELECT step, data FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0];
  assert.equal(saga.step, "in_consult");
  assert.equal(saga.data.activeLeg, "consultant");

  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "intent.switch_customer", provider, actor: "agent" });
  const customerSwitches = provider.calls.filter(
    (entry) => entry.operation === "consult_switch_customer",
  );
  assert.equal(customerSwitches.length, 2);
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.bridged", role: "customer", provider });
  saga = (await pool.query(`SELECT step, data FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0];
  assert.equal(saga.step, "in_consult");
  assert.equal(saga.data.activeLeg, "parked");
  const repeatedCommands = (
    await pool.query(
      `SELECT command_id, step_sequence
         FROM acd_commands
        WHERE saga_id = $1 AND step = 'bridge_customer'
        ORDER BY step_sequence`,
      [sagaId],
    )
  ).rows;
  assert.equal(repeatedCommands.length, 2);
  assert.notEqual(repeatedCommands[0].command_id, repeatedCommands[1].command_id);
  assert.notEqual(
    Number(repeatedCommands[0].step_sequence),
    Number(repeatedCommands[1].step_sequence),
  );

  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "intent.switch_consultant", provider, actor: "agent" });
  const consultantSwitches = provider.calls.filter(
    (entry) => entry.operation === "consult_switch_target",
  );
  assert.equal(consultantSwitches.length, 2);
  await pool.query(
    `UPDATE acd_legs SET bridged_at = now(), state = 'bridged'
      WHERE provider_call_id = $1`,
    [targetCcid],
  );
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.bridged", role: "consult_target", provider });
  saga = (await pool.query(`SELECT step, data FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0];
  assert.equal(saga.step, "in_consult");
  assert.equal(saga.data.activeLeg, "consultant");

  provider.calls.length = 0;
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "intent.cancel", provider, actor: "agent" });
  assert.deepEqual(
    provider.calls.map(({ operation }) => operation),
    [
      "consult_stop_customer_hold_before_cancel",
      "consult_restore_customer_before_cancel",
    ],
  );
  assert.equal(
    provider.calls.some(({ operation }) => operation === "consult_cancel_target"),
    false,
  );
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.bridged", role: "customer", provider });
  const cancelAfterRestore = provider.calls.find(
    ({ operation }) => operation === "consult_cancel_target",
  );
  assert.ok(cancelAfterRestore);
  assert.match(
    cancelAfterRestore.endpoint,
    new RegExp(`${encodeURIComponent(targetCcid)}/actions/hangup$`),
  );
  assert.ok(
    provider.calls.findIndex(
      ({ operation }) => operation === "consult_restore_customer_before_cancel",
    ) <
      provider.calls.findIndex(
        ({ operation }) => operation === "consult_cancel_target",
      ),
  );
  assert.equal(
    provider.calls.some(
      ({ endpoint, operation }) =>
        operation.includes("hangup") &&
        (endpoint.includes(encodeURIComponent(browserCcid)) ||
          endpoint.includes(encodeURIComponent(call.ids.customer))),
    ),
    false,
  );
  await confirmConsultantEnded(call,sagaId,provider);
  saga = (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0];
  assert.equal(saga.state, "cancelled");
  const workItem = (
    await pool.query(`SELECT state, handoff_saga_id, attributes FROM acd_work_items WHERE id = $1`, [call.workItem.id])
  ).rows[0];
  assert.equal(workItem.state, "active");
  assert.equal(workItem.handoff_saga_id, null);
  assert.equal(workItem.attributes.handoff_pending, undefined);
  assert.equal(workItem.attributes.handoff_saga_id, undefined);
  const resumedAssignment = (
    await pool.query(
      `SELECT id, state, step, data
         FROM acd_sagas
        WHERE work_item_id = $1 AND type = 'connect'
          AND state IN ('running', 'compensating')
        ORDER BY created_at DESC LIMIT 1`,
      [call.workItem.id],
    )
  ).rows[0];
  assert.equal(resumedAssignment.step, "in_call");
  assert.equal(resumedAssignment.data.customerProviderCallId, call.ids.customer);
  assert.equal(
    (
      await pool.query(
        `SELECT owner_saga_id FROM acd_legs
          WHERE provider_call_id = $1`,
        [browserCcid],
      )
    ).rows[0].owner_saga_id,
    resumedAssignment.id,
  );
  const consultEvents = (
    await pool.query(
      `SELECT type FROM acd_events
        WHERE work_item_id = $1 AND type LIKE 'consult_%'
        ORDER BY id`,
      [call.workItem.id],
    )
  ).rows.map((event) => event.type);
  assert.deepEqual(consultEvents, [
    "consult_started",
    "consult_ringing",
    "consult_connected",
    "consult_customer_active",
    "consult_consultant_active",
    "consult_customer_active",
    "consult_consultant_active",
    "consult_customer_restored",
    "consult_assignment_resumed",
  ]);
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C restored consult remains owned until the customer hangs up", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId } = await activeConsult(call, provider);

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.cancel",
    provider,
    actor: "agent",
  });
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "customer",
    provider,
  });
  await confirmConsultantEnded(call,sagaId,provider);
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state,
    "cancelled",
  );

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "agent_device",
    provider,
  });
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "customer",
    provider,
  });

  assert.deepEqual(
    (
      await pool.query(
        `SELECT state, terminal_reason FROM acd_work_items WHERE id = $1`,
        [call.workItem.id],
      )
    ).rows[0],
    { state: "completed", terminal_reason: "call_ended" },
  );
  assert.equal(
    (
      await pool.query(
        `SELECT state FROM acd_reservations WHERE id = $1`,
        [call.ids.reservation],
      )
    ).rows[0].state,
    "released",
  );
  assert.equal(
    (
      await pool.query(
        `SELECT ended_at IS NOT NULL AS ended FROM acd_segments
          WHERE work_item_id = $1 AND kind = 'agent'
          ORDER BY seq DESC LIMIT 1`,
        [call.workItem.id],
      )
    ).rows[0].ended,
    true,
  );
});

test("Phase C consult cancellation is accepted during a leg switch", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId } = await activeConsult(call, provider);

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.switch_customer",
    provider,
    actor: "agent",
  });
  assert.equal(
    (await pool.query(`SELECT step FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].step,
    "bridge_customer",
  );

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.cancel",
    provider,
    actor: "agent",
  });
  assert.ok(
    provider.calls.some(
      (entry) => entry.operation === "consult_restore_customer_before_cancel",
    ),
  );
  assert.equal(
    provider.calls.some((entry) => entry.operation === "consult_cancel_target"),
    false,
  );

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "customer",
    provider,
  });
  assert.ok(provider.calls.some((entry) => entry.operation === "consult_cancel_target"));
  await confirmConsultantEnded(call,sagaId,provider);
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state,
    "cancelled",
  );
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C WebRTC consult cancellation hangs up only the consultant device leg", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId, targetCcid, browserCcid } = await activeConsult(call, provider);
  const transportCcid = `v3:consult-transport-${randomUUID()}`;
  const targetAgentId = `consult-user-${randomUUID()}`;

  await pool.query(
    `INSERT INTO acd_legs
       (id, work_item_id, role, provider_call_id, owner_saga_id, state,
        answered_at, bridged_at)
     VALUES ($1, $2, 'consult_transport', $3, $4, 'bridged', now(), now())`,
    [randomUUID(), call.workItem.id, transportCcid, sagaId],
  );
  await pool.query(
    `UPDATE acd_sagas
        SET data = data || jsonb_build_object(
          'target', 'sip:consult-user@test.invalid',
          'targetKind', 'agents',
          'targetUserId', $2::text
        )
      WHERE id = $1`,
    [sagaId, targetAgentId],
  );

  provider.calls.length = 0;
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.cancel",
    provider,
    actor: "agent",
  });

  const restore = provider.calls.find(
    ({ operation }) => operation === "consult_restore_customer_before_cancel",
  );
  assert.ok(restore);
  assert.match(
    restore.endpoint,
    new RegExp(`${encodeURIComponent(browserCcid)}/actions/bridge$`),
  );
  assert.equal(restore.request.call_control_id, call.ids.customer);
  assert.equal(restore.request.park_after_unbridge, "self");
  assert.equal(
    provider.calls.some(({ operation }) => operation === "consult_cancel_target"),
    false,
  );

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "customer",
    provider,
  });

  const cancel = provider.calls.find(
    ({ operation }) => operation === "consult_cancel_target",
  );
  assert.ok(cancel);
  assert.match(
    cancel.endpoint,
    new RegExp(`${encodeURIComponent(targetCcid)}/actions/hangup$`),
  );
  assert.doesNotMatch(cancel.endpoint, new RegExp(encodeURIComponent(transportCcid)));
  assert.equal(
    provider.calls.some(
      ({ endpoint, operation }) =>
        operation === "consult_cancel_target" &&
        (endpoint.includes(encodeURIComponent(browserCcid)) ||
          endpoint.includes(encodeURIComponent(call.ids.customer))),
    ),
    false,
  );
  await confirmConsultantEnded(call,sagaId,provider);
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId]))
      .rows[0].state,
    "cancelled",
  );
});

test("Phase C restores the customer when the consultant ends during a customer switch", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId, targetCcid } = await activeConsult(call, provider);

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.switch_customer",
    provider,
    actor: "agent",
  });
  assert.equal(
    (await pool.query(`SELECT step FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].step,
    "bridge_customer",
  );

  provider.calls.length = 0;
  await pool.query(
    `UPDATE acd_legs SET state = 'ended', ended_at = now()
      WHERE provider_call_id = $1`,
    [targetCcid],
  );
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "consult_target",
    provider,
  });

  assert.deepEqual(
    provider.calls.map(({ operation }) => operation),
    ["consult_stop_customer_hold_audio", "consult_restore_customer"],
  );
  assert.equal(
    provider.calls.some(({ endpoint }) => endpoint.includes("unknown")),
    false,
  );
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "customer",
    provider,
  });
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state,
    "cancelled",
  );
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C cancellation skips a consultant leg that already ended", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId, targetCcid } = await activeConsult(call, provider);

  await pool.query(
    `UPDATE acd_legs SET state = 'ended', ended_at = now()
      WHERE provider_call_id = $1`,
    [targetCcid],
  );
  provider.calls.length = 0;
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.cancel",
    provider,
    actor: "agent",
  });

  assert.deepEqual(
    provider.calls.map(({ operation }) => operation),
    [
      "consult_stop_customer_hold_before_cancel",
      "consult_restore_customer_before_cancel",
    ],
  );
  assert.equal(
    provider.calls.some(
      ({ operation, endpoint }) =>
        operation === "consult_cancel_target" || endpoint.includes("unknown"),
    ),
    false,
  );
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "customer",
    provider,
  });
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state,
    "cancelled",
  );
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C remote consultant hangup retries and restores the agent/customer bridge", { skip }, async () => {
  const call = await activeCall();
  let rejectFirstRestore = true;
  const provider = {
    name: "fake",
    calls: [],
    async send({ endpoint, request, commandId, operation }) {
      this.calls.push({ endpoint, request, commandId, operation });
      if (operation === "consult_restore_customer" && rejectFirstRestore) {
        rejectFirstRestore = false;
        return {
          outcome: "failed",
          httpStatus: 409,
          response: { error: "surviving agent leg is still unbridging" },
        };
      }
      return {
        outcome: "accepted",
        httpStatus: 200,
        response: { data: { result: "ok" } },
      };
    },
  };
  const { sagaId, targetCcid, browserCcid } = await activeConsult(call, provider);
  provider.calls.length = 0;

  await pool.query(
    `UPDATE acd_legs SET state = 'ended', ended_at = now()
      WHERE provider_call_id = $1`,
    [targetCcid],
  );
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "consult_target",
    provider,
  });

  assert.deepEqual(
    provider.calls.map(({ operation }) => operation),
    [
      "consult_stop_customer_hold_audio",
      "consult_restore_customer",
      "consult_restore_customer_retry",
    ],
  );
  assert.deepEqual(
    (await pool.query(`SELECT state, step FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0],
    { state: "compensating", step: "restore_customer_retry" },
  );
  for (const command of provider.calls.filter(({ operation }) => operation.startsWith("consult_restore_customer"))) {
    assert.match(command.endpoint, new RegExp(`${encodeURIComponent(browserCcid)}/actions/bridge$`));
    assert.equal(command.request.call_control_id, call.ids.customer);
    assert.equal(command.request.park_after_unbridge, "self");
  }

  // Telnyx may confirm this bridge on the agent device leg first.
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "agent_device",
    provider,
  });

  assert.deepEqual(
    (await pool.query(`SELECT state, step, last_error FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0],
    { state: "cancelled", step: "consult_cancelled", last_error: null },
  );
  assert.equal(
    (await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [call.workItem.id])).rows[0].state,
    "active",
  );
  assert.equal(
    (await pool.query(`SELECT state FROM acd_reservations WHERE id = $1`, [call.ids.reservation])).rows[0].state,
    "active",
  );
  const intent = await getTransferIntent(pool, {
    interactionId: call.workItem.id,
    username: `${call.agentId}@test.local`,
  });
  assert.equal(intent.state, "cancelled");
  assert.equal(intent.activeLeg, "parked");
  assert.equal(intent.error, null);
  assert.equal(
    provider.calls.some(({ operation }) => operation === "consult_requeue_source"),
    false,
  );
  const restoredEvent = (
    await pool.query(
      `SELECT payload FROM acd_events
        WHERE work_item_id = $1 AND type = 'consult_customer_restored'
        ORDER BY id DESC LIMIT 1`,
      [call.workItem.id],
    )
  ).rows[0];
  assert.equal(restoredEvent.payload.reason, "Consult target disconnected");
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C consult complete bridges customer to target and releases the agent", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId } = await activeConsult(call, provider);
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "intent.complete", provider, actor: "agent" });
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.bridged", role: "customer", provider });
  const saga = (await pool.query(`SELECT state, step FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0];
  assert.deepEqual(saga, { state: "running", step: "monitor_transfer" });
  assert.equal((await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [call.workItem.id])).rows[0].state, "completed");
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id = $1`, [call.ids.reservation])).rows[0].state, "released");

  provider.calls.length = 0;
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "consult_target",
    provider,
  });
  assert.equal(provider.calls[0].operation, "consult_transfer_hangup_customer");
  assert.match(provider.calls[0].endpoint, new RegExp(encodeURIComponent(call.ids.customer)));
  assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state, "running", "HTTP acceptance retains media ownership");
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.ended", role: "customer", provider });
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state,
    "succeeded",
  );
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C consult completes from provider evidence when the final bridge webhook is missing", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const baseSend = provider.send.bind(provider);
  provider.send = async (command) => {
    if (command.operation !== "verify_consult_completion") {
      return baseSend(command);
    }
    provider.calls.push(command);
    return {
      outcome: "accepted",
      httpStatus: 200,
      response: {
        data: {
          conclusive: true,
          transferred: true,
          allEnded: false,
          checkedAt: new Date().toISOString(),
          calls: {
            customer: {
              callControlId: command.request.customerCallId,
              isAlive: true,
            },
            target: {
              callControlId: command.request.targetCallId,
              isAlive: true,
            },
            agent: {
              callControlId: command.request.agentCallId,
              isAlive: false,
            },
          },
        },
      },
    };
  };
  const { sagaId, browserCcid } = await activeConsult(call, provider);

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.complete",
    provider,
    actor: "agent",
  });
  assert.equal(
    (await pool.query(`SELECT step FROM acd_sagas WHERE id=$1`, [sagaId])).rows[0].step,
    "complete_bridge",
  );

  await pool.query(
    `UPDATE acd_sagas SET deadline_at = now() - interval '1 second' WHERE id=$1`,
    [sagaId],
  );
  await sweepDueSagas(pool, { provider, node: "missing-complete-bridge-test" });

  assert.ok(provider.calls.some(({ operation }) => operation === "verify_consult_completion"));
  assert.deepEqual(
    (await pool.query(`SELECT state,step FROM acd_sagas WHERE id=$1`, [sagaId])).rows[0],
    { state: "running", step: "monitor_transfer" },
  );
  assert.deepEqual(
    (await pool.query(`SELECT state,terminal_reason FROM acd_work_items WHERE id=$1`, [call.workItem.id])).rows[0],
    { state: "completed", terminal_reason: "consult_transfer" },
  );
  assert.equal(
    (await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`, [call.ids.reservation])).rows[0].state,
    "released",
  );
  assert.deepEqual(
    (await pool.query(`SELECT state,ended_reason,ended_at IS NOT NULL AS ended FROM acd_legs WHERE provider_call_id=$1`, [browserCcid])).rows[0],
    { state: "ended", ended_reason: "provider_absence_verified", ended: true },
  );
  assert.equal(
    (await pool.query(`SELECT COUNT(*)::int AS count FROM acd_events WHERE work_item_id=$1 AND type='consult_completion_reconciled'`, [call.workItem.id])).rows[0].count,
    1,
  );
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C consult accepts final bridge evidence from the consultant leg", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId } = await activeConsult(call, provider);
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.complete",
    provider,
    actor: "agent",
  });
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "consult_target",
    provider,
  });
  assert.deepEqual(
    (await pool.query(`SELECT state,step FROM acd_sagas WHERE id=$1`, [sagaId])).rows[0],
    { state: "running", step: "monitor_transfer" },
  );
  assert.equal(
    provider.calls.some(({ operation }) => operation === "verify_consult_completion"),
    false,
  );
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C failed requeue consumes a late customer hangup and releases the agent", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const baseSend = provider.send.bind(provider);
  provider.send = async (command) => {
    if (command.operation === "verify_consult_completion") {
      provider.calls.push(command);
      return {
        outcome: "failed",
        httpStatus: 503,
        response: { error: "status unavailable" },
      };
    }
    if (["consult_restore_customer", "consult_restore_customer_retry"].includes(command.operation)) {
      provider.calls.push(command);
      return {
        outcome: "failed",
        httpStatus: 422,
        response: { errors: [{ code: "90018", title: "Call has already ended" }] },
      };
    }
    return baseSend(command);
  };
  const { sagaId } = await activeConsult(call, provider);
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.complete",
    provider,
    actor: "agent",
  });

  await pool.query(
    `UPDATE acd_sagas SET deadline_at = now() - interval '1 second' WHERE id=$1`,
    [sagaId],
  );
  await sweepDueSagas(pool, { provider, node: "failed-complete-recovery-test" });
  assert.equal(provider.calls.some(entry=>entry.operation==="consult_requeue_source"),false);
  await applySagaEvent(pool,{workItemId:call.workItem.id,name:"leg.ended",role:"consult_target",provider});
  assert.equal(
    (await pool.query(`SELECT step FROM acd_sagas WHERE id=$1`, [sagaId])).rows[0].step,
    "requeue_customer",
  );

  await pool.query(
    `UPDATE acd_sagas SET deadline_at = now() - interval '1 second' WHERE id=$1`,
    [sagaId],
  );
  await sweepDueSagas(pool, { provider, node: "failed-requeue-late-hangup-test" });
  assert.deepEqual(
    (await pool.query(`SELECT state,step,data->>'consultState' AS consult_state FROM acd_sagas WHERE id=$1`, [sagaId])).rows[0],
    {
      state: "compensating",
      step: "await_failed_recovery_end",
      consult_state: "failed",
    },
  );
  const presented = await getTransferIntent(pool, {
    interactionId: call.workItem.id,
    username: `${call.agentId}@test.local`,
  });
  assert.equal(presented.state, "failed", "the modal must close while cleanup keeps consuming evidence");

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "customer",
    provider,
  });
  assert.equal(
    (await pool.query(`SELECT state FROM acd_work_items WHERE id=$1`, [call.workItem.id])).rows[0].state,
    "completed",
  );
  assert.equal(
    (await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`, [call.ids.reservation])).rows[0].state,
    "released",
  );
  assert.equal(
    (await pool.query(`SELECT workflow_state FROM acd_agent_state WHERE agent_id=$1`, [call.agentId])).rows[0].workflow_state,
    "wrapup",
  );
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C consult can complete while the agent is speaking with the customer", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId, targetCcid } = await activeConsult(call, provider);

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.switch_customer",
    provider,
    actor: "agent",
  });
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "customer",
    provider,
  });
  assert.equal(
    (await pool.query(`SELECT data->>'activeLeg' AS active_leg FROM acd_sagas WHERE id=$1`, [sagaId])).rows[0].active_leg,
    "parked",
  );

  provider.calls.length = 0;
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.complete",
    provider,
    actor: "agent",
  });
  assert.deepEqual(
    provider.calls.slice(0, 2).map(({ operation }) => operation),
    ["consult_stop_consultant_hold_audio", "consult_complete_bridge"],
  );
  const completeBridge = provider.calls.find(
    ({ operation }) => operation === "consult_complete_bridge",
  );
  assert.match(
    completeBridge.endpoint,
    new RegExp(`${encodeURIComponent(call.ids.customer)}/actions/bridge$`),
  );
  assert.equal(completeBridge.request.call_control_id, targetCcid);

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "customer",
    provider,
  });
  assert.deepEqual(
    (await pool.query(`SELECT state, step FROM acd_sagas WHERE id=$1`, [sagaId])).rows[0],
    { state: "running", step: "monitor_transfer" },
  );
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C completed consult hangs up the consultant when the customer ends first", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId, targetCcid } = await activeConsult(call, provider);
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.complete",
    provider,
    actor: "agent",
  });
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "customer",
    provider,
  });

  provider.calls.length = 0;
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "customer",
    provider,
  });
  assert.equal(provider.calls[0].operation, "consult_transfer_hangup_target");
  assert.match(provider.calls[0].endpoint, new RegExp(encodeURIComponent(targetCcid)));
  assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state, "running", "HTTP acceptance retains media ownership");
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: "leg.ended", role: "consult_target", provider });
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state,
    "succeeded",
  );
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C consult target no-answer restores the parked customer to the browser agent", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId } = await withTx((tx) =>
    startConsultSaga(tx, baseParams(call, "+15550001666")),
  );
  await driveSaga(pool, sagaId, { provider });
  await bindBrowserConsultOriginator(call, sagaId, provider);
  await pool.query(
    `INSERT INTO acd_legs (id, work_item_id, role, provider_call_id, owner_saga_id, state, ended_at)
     VALUES ($1, $2, 'consult_target', $3, $4, 'ended', now())`,
    [randomUUID(), call.workItem.id, `v3:no-answer-${randomUUID()}`, sagaId],
  );
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "consult_target",
    provider,
  });
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.bridged",
    role: "customer",
    provider,
  });
  assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state, "cancelled");
  assert.equal((await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [call.workItem.id])).rows[0].state, "active");
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id = $1`, [call.ids.reservation])).rows[0].state, "active");
  const attributes = (
    await pool.query(`SELECT attributes FROM acd_work_items WHERE id = $1`, [call.workItem.id])
  ).rows[0].attributes;
  assert.equal(attributes.handoff_pending, undefined);
});

test("Phase C consult can be cancelled while the destination is still ringing", { skip }, async () => {
  const call = await activeCall();
  const targetCcid = `v3:ringing-consult-${randomUUID()}`;
  const provider = makeFakeProvider([
    { outcome: "accepted", response: { data: { call_control_id: targetCcid } } },
  ]);
  const { sagaId } = await withTx((tx) =>
    startConsultSaga(tx, baseParams(call, "+15550001665")),
  );
  await driveSaga(pool, sagaId, { provider });
  await bindBrowserConsultOriginator(call, sagaId, provider);
  provider.calls.length = 0;
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.cancel",
    provider,
    actor: "agent",
  });
  assert.equal(provider.calls[0].operation, "consult_cancel_ringing_target");
  assert.match(provider.calls[0].endpoint, new RegExp(encodeURIComponent(targetCcid)));
  const restore = provider.calls.find(c => c.operation === 'consult_restore_customer');
  assert.ok(restore, 'Cancelling ringing consultation must restore the customer media');
  assert.ok(restore.endpoint.includes(encodeURIComponent(call.ids.customer)));
  assert.notEqual(restore.request.call_control_id, call.ids.agent, 'Restore must use the fresh browser');
  assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id=$1`, [sagaId])).rows[0].state, 'compensating');
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: 'leg.bridged', role: 'customer', provider });
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state,
    "cancelled",
  );
  assert.equal(
    (await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [call.workItem.id])).rows[0].state,
    "active",
  );
});

test("Phase C consult cancellation waits for a late target call-control id", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider([
    { outcome: "accepted", response: { data: {} } },
  ]);
  const { sagaId } = await withTx((tx) =>
    startConsultSaga(tx, baseParams(call, "+15550001664")),
  );
  await driveSaga(pool, sagaId, { provider });
  await bindBrowserConsultOriginator(call, sagaId, provider);
  provider.calls.length = 0;

  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "intent.cancel",
    provider,
    actor: "agent",
  });
  assert.deepEqual(
    (await pool.query(`SELECT state, step FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0],
    { state: "compensating", step: "await_cancel_target" },
  );
  assert.equal(provider.calls.length, 0, "must not send hangup to an unknown call id");

  const targetCcid = `v3:late-consult-${randomUUID()}`;
  const initiated = await routeAcdVoiceEvent(
    pool,
    provider,
    {
      eventId: `evt-${randomUUID()}`,
      eventType: "call.initiated",
      occurredAt: new Date().toISOString(),
      payload: {
        call_control_id: targetCcid,
        call_session_id: `session-${randomUUID()}`,
        direction: "outgoing",
        custom_headers: [
          { name: "X-CC-Work-Item-Id", value: call.workItem.id },
          { name: "X-CC-Leg-Role", value: "consult_target" },
          { name: "X-CC-Saga-Id", value: sagaId },
        ],
      },
    },
    { node: "test" },
  );
  assert.equal(initiated.outcome, "applied");
  assert.equal(provider.calls[0].operation, "consult_cancel_ringing_target");
  assert.match(provider.calls[0].endpoint, new RegExp(encodeURIComponent(targetCcid)));
  assert.doesNotMatch(provider.calls[0].endpoint, /unknown/);
  const restore = provider.calls.find(c => c.operation === 'consult_restore_customer');
  assert.ok(restore, 'Cancelling ringing consultation must restore the customer media');
  assert.ok(restore.endpoint.includes(encodeURIComponent(call.ids.customer)));
  assert.notEqual(restore.request.call_control_id, call.ids.agent, 'Restore must use the fresh browser');
  assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id=$1`, [sagaId])).rows[0].state, 'compensating');
  await applySagaEvent(pool, { workItemId: call.workItem.id, name: 'leg.bridged', role: 'customer', provider });
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state,
    "cancelled",
  );
  assert.deepEqual(await checkInvariants(pool), {});
});

test("Phase C customer hangup during consult cleans up the consult target", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId, targetCcid } = await activeConsult(call, provider);
  provider.calls.length = 0;
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "customer",
    provider,
  });
  assert.equal(provider.calls[0].operation, "consult_customer_hangup_cleanup");
  assert.match(provider.calls[0].endpoint, new RegExp(encodeURIComponent(targetCcid)));
  await confirmConsultantEnded(call,sagaId,provider);
  assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state, "cancelled");
});

test("Phase C agent crash during consult cleans up the consult target", { skip }, async () => {
  const call = await activeCall();
  const provider = makeFakeProvider();
  const { sagaId, targetCcid } = await activeConsult(call, provider);
  provider.calls.length = 0;
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.ended",
    role: "agent_device",
    provider,
  });
  assert.equal(provider.calls[0].operation, "consult_agent_crash_cleanup");
  assert.match(provider.calls[0].endpoint, new RegExp(encodeURIComponent(targetCcid)));
  assert.equal(provider.calls.some(entry=>entry.operation==="consult_requeue_source"),false);
  await applySagaEvent(pool,{workItemId:call.workItem.id,name:"leg.ended",role:"consult_target",provider});
  assert.equal(provider.calls.at(-1).operation, "consult_requeue_source");
  await applySagaEvent(pool, {
    workItemId: call.workItem.id,
    name: "leg.enqueued",
    role: "customer",
    provider,
  });
  assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id = $1`, [sagaId])).rows[0].state, "cancelled");
  assert.equal((await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [call.workItem.id])).rows[0].state, "queued");
  assert.deepEqual(await checkInvariants(pool), {});
});

test('Phase C adopted SIP transfer retains the exact transport/device bridge evidence', {skip}, async()=>{
  const {agentBridgeEvidence}=await import('../lib/acd/voice-bridge-evidence.mjs');
  const call=await activeCall(),agentId=`target-${randomUUID()}`,transport=`v3:transfer-transport-${randomUUID()}`,device=`v3:transfer-device-${randomUUID()}`;
  await seedAgent(pool,agentId,{telephonyUserName:'adoption-target'});
  const provider=makeFakeProvider([{outcome:'accepted',response:{data:{call_control_id:transport}}}]);
  const {sagaId}=await withTx(tx=>startBlindTransferSaga(tx,{...baseParams(call,'sip:adoption-target@test.invalid'),targetKind:'agents',targetUserId:agentId}));
  await driveSaga(pool,sagaId,{provider});
  await pool.query(`UPDATE acd_legs SET bridged_at=now(),bridged_peer_call_id=$2,bridged_event_id=$3 WHERE provider_call_id=$1`,[call.ids.customer,transport,randomUUID()]);
  await pool.query(`UPDATE acd_legs SET state='bridged',bridged_at=now(),answered_at=now(),bridged_peer_call_id=$2 WHERE provider_call_id=$1`,[transport,call.ids.customer]);
  await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,owner_saga_id,state,answered_at)
    VALUES($1,$2,'transfer_target',$3,$4,'answered',now())`,[randomUUID(),call.workItem.id,device,sagaId]);
  await applyEngineSagaEvent(pool,{workItemId:call.workItem.id,name:'leg.answered',role:'transfer_target',payload:{owner_saga_id:sagaId,provider_call_id:device},provider});
  const legs=(await pool.query('SELECT * FROM acd_legs WHERE work_item_id=$1',[call.workItem.id])).rows;
  const intents=(await pool.query('SELECT * FROM acd_leg_intents WHERE work_item_id=$1',[call.workItem.id])).rows;
  const adopted=legs.find(l=>l.provider_call_id===device),sibling=legs.find(l=>l.provider_call_id===transport);
  assert.equal(adopted.role,'agent_device');assert.equal(adopted.agent_id,agentId);assert.equal(adopted.bridged_at,null);
  assert.equal(sibling.owner_saga_id,adopted.owner_saga_id);assert.equal(sibling.role,'agent_transport');
  assert.ok(agentBridgeEvidence(legs,intents,agentId,{live:true}));
  assert.equal(intents.find(i=>i.bound_leg_id===adopted.id)?.transport_call_id,transport);
});

test('Phase C SIP adoption waits for an unambiguous owned transport and an answered device', {skip}, async()=>{
  const {transferTargetReadyForAdoption}=await import('../lib/acd/transfer-capacity.mjs');
  const call=await activeCall(),sagaId=randomUUID(),deviceId=randomUUID();
  const ctx={saga:{id:sagaId},workItem:call.workItem,data:{targetReservationId:'reservation',target:'sip:target@test.invalid'}};
  await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,owner_saga_id,state)
    VALUES($1,$2,'transfer_target',$3,$4,'ringing')`,[deviceId,call.workItem.id,`v3:${randomUUID()}`,sagaId]);
  assert.equal(await transferTargetReadyForAdoption(pool,ctx),false);
  await pool.query('UPDATE acd_legs SET answered_at=now() WHERE id=$1',[deviceId]);
  assert.equal(await transferTargetReadyForAdoption(pool,ctx),false);
  await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,owner_saga_id,state)
    VALUES($1,$2,'transfer_transport',$3,$4,'bridged')`,[randomUUID(),call.workItem.id,`v3:${randomUUID()}`,randomUUID()]);
  assert.equal(await transferTargetReadyForAdoption(pool,ctx),false,'another saga cannot supply bridge topology');
  const first=randomUUID(),second=randomUUID();
  for(const id of [first,second])await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,owner_saga_id,state)
    VALUES($1,$2,'transfer_transport',$3,$4,'bridged')`,[id,call.workItem.id,`v3:${randomUUID()}`,sagaId]);
  assert.equal(await transferTargetReadyForAdoption(pool,ctx),false,'two possible transports are ambiguous');
  await pool.query('UPDATE acd_legs SET ended_at=now() WHERE id=$1',[second]);
  assert.equal(await transferTargetReadyForAdoption(pool,ctx),true);
});

test("Phase C cancellation keeps consultant capacity until an exact provider end proof", {skip},async()=>{
  const call=await activeCall(),provider=makeFakeProvider();
  const {sagaId,targetCcid}=await activeConsult(call,provider);
  const targetId=`target-${randomUUID()}`,reservationId=randomUUID();
  await seedAgent(pool,targetId,{workflowState:"handling"});
  await pool.query(`INSERT INTO acd_reservations(id,agent_id,work_item_id,channel,state,owner_saga_id)
    VALUES($1,$2,$3,'voice','active',$4)`,[reservationId,targetId,call.workItem.id,sagaId]);
  await pool.query(`UPDATE acd_sagas SET data=data||jsonb_build_object('targetReservationId',$2::text) WHERE id=$1`,[sagaId,reservationId]);
  await pool.query("UPDATE acd_legs SET agent_id=$2 WHERE provider_call_id=$1",[targetCcid,targetId]);
  await applySagaEvent(pool,{workItemId:call.workItem.id,name:"intent.cancel",provider});
  await applySagaEvent(pool,{workItemId:call.workItem.id,name:"leg.bridged",role:"customer",provider});
  const state=async()=>(await pool.query("SELECT state FROM acd_reservations WHERE id=$1",[reservationId])).rows[0].state;
  assert.equal(await state(),"active");
  const send=provider.send.bind(provider);let proof={ended:false,conclusive:false,callControlId:targetCcid};
  provider.send=async command=>command.operation==="verify_agent_leg_end"
    ? {outcome:"accepted",httpStatus:200,response:{data:proof}}:send(command);
  const expire=async()=>{await pool.query("UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1",[sagaId]);await sweepDueSagas(pool,{provider,node:"consult-cleanup-proof-test"});};
  await expire();assert.equal(await state(),"active");
  assert.equal((await pool.query("SELECT handoff_saga_id FROM acd_work_items WHERE id=$1",[call.workItem.id])).rows[0].handoff_saga_id,sagaId);
  await expire(); // Retry hangup after the inconclusive probe alarm.
  proof={ended:true,conclusive:true,callControlId:targetCcid};
  await expire();
  assert.equal((await pool.query("SELECT state FROM acd_sagas WHERE id=$1",[sagaId])).rows[0].state,"cancelled");
  assert.equal(await state(),"released");
});

test("Phase C failed restore cleans the consultant before requeue and keeps ownership through hangup failure",{skip},async()=>{
  const call=await activeCall(),provider=makeFakeProvider();
  const {sagaId}=await activeConsult(call,provider),send=provider.send.bind(provider);
  provider.calls.length=0;
  provider.send=async command=>{
    if(command.operation.startsWith("consult_restore_customer_before_cancel") || command.operation==="consult_cancel_target") {
      provider.calls.push(command);return {outcome:"failed",httpStatus:422,response:{}};
    }
    return send(command);
  };
  await applySagaEvent(pool,{workItemId:call.workItem.id,name:"intent.cancel",provider});
  assert.equal(provider.calls.filter(c=>c.operation.startsWith("consult_restore_customer_before_cancel")).length,2);
  assert.equal(provider.calls.filter(c=>c.operation==="consult_cancel_target").length,1);
  assert.equal(provider.calls.some(c=>c.operation==="consult_requeue_source"),false);
  assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE id=$1",[call.ids.reservation])).rows[0].state,"active");
  await applySagaEvent(pool,{workItemId:call.workItem.id,name:"leg.ended",role:"consult_target",provider});
  assert.equal(provider.calls.at(-1).operation,"consult_requeue_source");
  await applySagaEvent(pool,{workItemId:call.workItem.id,name:"leg.enqueued",role:"customer",provider});
  assert.equal((await pool.query("SELECT state FROM acd_work_items WHERE id=$1",[call.workItem.id])).rows[0].state,"queued");
});

test("agent active reads exclude the historical source when a transferred work item is offered to another agent",{skip},async()=>{
  const {listAgentInteractionViews}=await import("../lib/acd/work-item-repository.mjs");
  const call=await activeCall(),targetId=`target-${randomUUID()}`;await seedAgent(pool,targetId);
  await pool.query("UPDATE acd_segments SET ended_at=now() WHERE work_item_id=$1 AND kind='agent'",[call.workItem.id]);
  await pool.query("UPDATE acd_work_items SET state='offered' WHERE id=$1",[call.workItem.id]);
  await pool.query("UPDATE acd_offers SET state='cancelled' WHERE work_item_id=$1",[call.workItem.id]);
  await pool.query(`INSERT INTO acd_offers(id,work_item_id,agent_id,generation,state,deadline_at)
    VALUES($1,$2,$3,2,'ringing',now()+interval '30 seconds')`,[randomUUID(),call.workItem.id,targetId]);
  const source=await listAgentInteractionViews(pool,call.agentId),target=await listAgentInteractionViews(pool,targetId);
  assert.equal(source.some(w=>w.id===call.workItem.id),false);
  assert.equal(target.find(w=>w.id===call.workItem.id)?.agent_id,targetId);
  assert.equal((await listAgentInteractionViews(pool,call.agentId,{activeOnly:false})).some(w=>w.id===call.workItem.id),true);
});

for(const outcome of ["accepted","failed","ambiguous"]){
  test(`customer hangup during consultant cleanup retains ownership after ${outcome} and releases only on end proof`,{skip},async()=>{
    const call=await activeCall(),provider=makeFakeProvider();
    const {sagaId,targetCcid}=await activeConsult(call,provider);
    const targetId=`target-${randomUUID()}`,reservationId=randomUUID();await seedAgent(pool,targetId,{workflowState:"handling"});
    await pool.query(`INSERT INTO acd_reservations(id,agent_id,work_item_id,channel,state,owner_saga_id)
      VALUES($1,$2,$3,'voice','active',$4)`,[reservationId,targetId,call.workItem.id,sagaId]);
    await pool.query(`UPDATE acd_sagas SET data=data||jsonb_build_object('targetReservationId',$2::text) WHERE id=$1`,[sagaId,reservationId]);
    await pool.query("UPDATE acd_legs SET agent_id=$2 WHERE provider_call_id=$1",[targetCcid,targetId]);
    await applySagaEvent(pool,{workItemId:call.workItem.id,name:"intent.cancel",provider});
    await applySagaEvent(pool,{workItemId:call.workItem.id,name:"leg.bridged",role:"customer",provider});
    const send=provider.send.bind(provider);
    provider.send=async command=>{
      if(command.operation==="consult_customer_hangup_cleanup")return {outcome,httpStatus:outcome==="accepted"?200:503,response:{}};
      if(command.operation==="verify_agent_leg_end")return {outcome:"accepted",httpStatus:200,response:{data:{ended:true,conclusive:true,callControlId:targetCcid}}};
      return send(command);
    };
    await applySagaEvent(pool,{workItemId:call.workItem.id,name:"leg.ended",role:"customer",provider});
    let saga=(await pool.query("SELECT state,step FROM acd_sagas WHERE id=$1",[sagaId])).rows[0];
    assert.ok(["running","compensating"].includes(saga.state));
    assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE id=$1",[reservationId])).rows[0].state,"active");
    assert.equal((await pool.query("SELECT handoff_saga_id FROM acd_work_items WHERE id=$1",[call.workItem.id])).rows[0].handoff_saga_id,sagaId);
    // The source can end too; this must not enqueue an already-ended customer.
    await applySagaEvent(pool,{workItemId:call.workItem.id,name:"leg.ended",role:"agent_device",provider});
    if(outcome==="accepted") {
      await pool.query("UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1",[sagaId]);
      await sweepDueSagas(pool,{provider,node:"customer-end-cleanup-test"});
    } else await applySagaEvent(pool,{workItemId:call.workItem.id,name:"leg.ended",role:"consult_target",provider});
    saga=(await pool.query("SELECT state FROM acd_sagas WHERE id=$1",[sagaId])).rows[0];
    assert.equal(saga.state,"cancelled");
    assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE id=$1",[reservationId])).rows[0].state,"released");
    assert.equal((await pool.query("SELECT state FROM acd_work_items WHERE id=$1",[call.workItem.id])).rows[0].state,"completed");
    assert.equal(provider.calls.some(command=>command.operation==="consult_requeue_source"),false);
  });
}
