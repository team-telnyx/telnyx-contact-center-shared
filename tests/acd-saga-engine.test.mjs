// ACD saga engine + `connect` saga — behavioral tests on real PostgreSQL with
// a scriptable fake provider (the internal documentation §5.4, §8.1, §11).

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
import {
  startSaga,
  driveSaga,
  applySagaEvent as applySagaEventRaw,
  sweepDueSagas,
  SagaConflictError,
} from "../lib/acd/saga-engine.mjs";
import { startConnectSaga } from "../lib/acd/sagas/connect.mjs";
import {
  classifyProviderResult,
  hangupEndpointCallId,
  isAlreadyEndedResponse,
  isHangupEndpoint,
} from "../lib/acd/provider.mjs";
import { agentMediaEvidence } from "../lib/acd/agent-media-evidence.mjs";

const pool = await prepareAcdTestPool("acd_core_test_saga");
const skip = pool ? false : "PostgreSQL not reachable — skipping ACD saga tests";
const withTx = makeTxRunner(pool);
const seedAgent = (agentId, overrides) => seedAgentIn(pool, agentId, overrides);
const seedQueue = (queueId, agentIds, overrides) => seedQueueIn(pool, queueId, agentIds, overrides);

async function routedConnect({
  answerTimeoutMs = 20_000,
  queueAudioMediaName = null,
} = {}) {
  const queue = `queue-${randomUUID().slice(0, 8)}`;
  const agent = `agent-${randomUUID().slice(0, 8)}`;
  await seedAgent(agent);
  await seedQueue(queue, [agent]);

  const workItem = await withTx(async (tx) => {
    const wi = await createWorkItem(tx, {
      channel: "voice",
      direction: "inbound",
      queueId: queue,
      customerAddress: "+15550002222",
      actor: "test",
    });
    await applyTransition(tx, {
      workItemId: wi.id,
      to: "queued",
      eventType: "work_item_queued",
      actor: "test",
      patch: { queueId: queue, enqueuedAt: new Date().toISOString() },
    });
    await openSegment(tx, { workItemId: wi.id, kind: "queue_wait", queueId: queue });
    return wi;
  });

  const routeResult = await routeOne(pool, workItem.id);
  assert.equal(routeResult.routed, true);

  const customerProviderCallId = `v3:${randomUUID()}`;
  await pool.query(
    `INSERT INTO acd_legs (id, work_item_id, role, provider_call_id, state, answered_at)
     VALUES ($1, $2, 'customer', $3, 'answered', now())`,
    [randomUUID(), workItem.id, customerProviderCallId],
  );
  const { sagaId } = await withTx((tx) =>
    startConnectSaga(tx, {
      workItem: { ...workItem, queue_id: queue },
      routeResult,
      customerProviderCallId,
      agentSipUri: `sip:${agent}@sip.telnyx.com`,
      answerTimeoutMs,
      queueName: queue,
      queueAudioMediaName,
    }),
  );
  return { queue, agent, workItem, routeResult, sagaId, customerProviderCallId };
}

async function sagaRow(sagaId) {
  const result = await pool.query(`SELECT * FROM acd_sagas WHERE id = $1`, [sagaId]);
  return result.rows[0];
}

async function commandRows(sagaId) {
  const result = await pool.query(
    `SELECT * FROM acd_commands WHERE saga_id = $1 ORDER BY created_at`,
    [sagaId],
  );
  return result.rows;
}

// The saga consumes canonical events after intake has persisted leg evidence.
// Keep unit fixtures faithful to that boundary, including device end proof.
async function applySagaEvent(db, event) {
  const state = { 'leg.answered':'answered','leg.bridged':'bridged','leg.ended':'ended' }[event.name];
  if (state && event.role === 'agent_device') {
    const intent=(await db.query(`SELECT i.*,r.owner_saga_id FROM acd_leg_intents i JOIN acd_reservations r ON r.id=i.reservation_id
      WHERE i.work_item_id=$1 AND ($2::bigint IS NULL OR i.offer_generation=$2) ORDER BY i.offer_generation DESC LIMIT 1`,[event.workItemId,event.payload?.offer_generation || null])).rows[0];
    if(intent) await db.query(`INSERT INTO acd_legs (id,work_item_id,role,provider_call_id,agent_id,owner_saga_id,offer_generation,state)
      SELECT $1,$2,'agent_device',$3,$4,$5,$6,'ringing' WHERE NOT EXISTS (SELECT 1 FROM acd_legs WHERE work_item_id=$2 AND role='agent_device' AND offer_generation=$6)`,
      [randomUUID(),event.workItemId,`fixture-device:${intent.id}`,intent.agent_id,intent.owner_saga_id,intent.offer_generation]);
  }
  if (state) await db.query(`UPDATE acd_legs SET state=$3,ended_at=CASE WHEN $3='ended' THEN now() ELSE ended_at END,
    answered_at=CASE WHEN $3='answered' THEN now() ELSE answered_at END WHERE work_item_id=$1 AND role=$2 AND ended_at IS NULL
    AND ($4::bigint IS NULL OR offer_generation=$4)`,[event.workItemId,event.role,state,event.payload?.offer_generation || null]);
  return applySagaEventRaw(db,event);
}

test("connect: maximum duration hangs up the customer but preserves active capacity until end evidence", { skip }, async () => {
  const provider = makeFakeProvider();
  const { workItem, routeResult, sagaId } = await routedConnect();
  await driveSaga(pool, sagaId, { provider });
  await applySagaEvent(pool, { workItemId: workItem.id, name: "leg.answered", role: "agent_device", provider });
  await applySagaEvent(pool, { workItemId: workItem.id, name: "leg.bridged", role: "customer", provider });
  const before = provider.calls.length;
  await pool.query(`UPDATE acd_sagas SET deadline_at = now() - interval '1 second' WHERE id = $1`, [sagaId]);
  await sweepDueSagas(pool, { provider });
  assert.equal((await sagaRow(sagaId)).step, "await_call_end_evidence");
  assert.equal(provider.calls.length, before + 1);
  assert.equal(provider.calls.at(-1)?.operation, "hangup_customer_leg");
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id = $1`, [routeResult.reservationId])).rows[0].state, "active");
  await applySagaEvent(pool, { workItemId: workItem.id, name: "leg.ended", role: "agent_device", provider });
  assert.equal((await sagaRow(sagaId)).step, "await_call_end_evidence");
  assert.ok(provider.calls.some(call => call.operation === "hangup_customer_leg"));
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id = $1`, [routeResult.reservationId])).rows[0].state, "active");
  await applySagaEvent(pool, { workItemId: workItem.id, name: "leg.ended", role: "customer", provider });
  assert.equal((await sagaRow(sagaId)).state, "succeeded");
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id = $1`, [routeResult.reservationId])).rows[0].state, "released");
});

test("connect: delayed consultation source hangup cannot end the receiving assignment", { skip }, async () => {
  for (const sourceGeneration of [null, 1]) {
    const provider = makeFakeProvider();
    const { workItem, routeResult, sagaId } = await routedConnect();
    await driveSaga(pool, sagaId, { provider });
    await applySagaEvent(pool, { workItemId: workItem.id, name: "leg.answered", role: "agent_device", provider });
    await applySagaEvent(pool, { workItemId: workItem.id, name: "leg.bridged", role: "customer", provider });
    const sourceOwner = randomUUID(), sourceCall = `v3:${randomUUID()}`;
    // A consultation source device belongs to its old call-control saga. Its
    // hangup can arrive after adoption, without a generation (manual outbound)
    // or with a generation that happens to match the receiving assignment.
    await pool.query(`INSERT INTO acd_legs
      (id,work_item_id,role,provider_call_id,owner_saga_id,offer_generation,state,ended_at)
      VALUES($1,$2,'agent_device',$3,$4,$5,'ended',now())`,
    [randomUUID(), workItem.id, sourceCall, sourceOwner, sourceGeneration]);
    const before = provider.calls.length;
    for (let replay = 0; replay < 2; replay++) await applySagaEventRaw(pool, {
      workItemId: workItem.id, name: "leg.ended", role: "agent_device",
      payload: { owner_saga_id: sourceOwner, offer_generation: sourceGeneration, provider_call_id: sourceCall },
      provider,
    });
    assert.equal((await sagaRow(sagaId)).step, "in_call");
    assert.equal(provider.calls.length, before, "foreign hangup must not issue a customer command");
    assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE id=$1", [routeResult.reservationId])).rows[0].state, "active");
    // The receiving agent's own hangup must still release the customer.
    await applySagaEvent(pool, {
      workItemId: workItem.id, name: "leg.ended", role: "agent_device",
      payload: { owner_saga_id: sagaId, offer_generation: (await sagaRow(sagaId)).data.generation },
      provider,
    });
    assert.equal(provider.calls.at(-1).operation, "hangup_customer_leg");
    await applySagaEvent(pool, { workItemId: workItem.id, name: "leg.ended", role: "customer", provider });
    assert.equal((await sagaRow(sagaId)).state, "succeeded");
  }
});

test("connect: initial media-stop step keeps its five-second deadline", { skip }, async () => {
  const { sagaId } = await routedConnect({ answerTimeoutMs: 60_000 });
  const result = await pool.query(
    `SELECT step,
            round(extract(epoch FROM (deadline_at - created_at)) * 1000)::int AS deadline_ms
       FROM acd_sagas
      WHERE id = $1`,
    [sagaId],
  );

  assert.equal(result.rows[0].step, "stop_queue_playback");
  assert.equal(result.rows[0].deadline_ms, 5_000);
});

test("provider result classification", { skip: false }, () => {
  assert.equal(classifyProviderResult({ httpStatus: 200 }), "accepted");
  assert.equal(classifyProviderResult({ httpStatus: 422 }), "failed");
  assert.equal(classifyProviderResult({ httpStatus: 404 }), "failed");
  assert.equal(classifyProviderResult({ httpStatus: 500 }), "ambiguous");
  assert.equal(classifyProviderResult({ httpStatus: 429 }), "ambiguous");
  assert.equal(classifyProviderResult({ networkError: true }), "ambiguous");
});

test("connect: happy path dial → answer → in_call → hangup → finalized", { skip }, async () => {
  const provider = makeFakeProvider();
  const { queue, agent, workItem, routeResult, sagaId } = await routedConnect();

  // Drive: plans + sends the transfer command, then waits for webhook evidence.
  const driven = await driveSaga(pool, sagaId, { provider });
  assert.equal(driven.waiting, "confirmation");
  const transferCall = provider.calls.find((call) => call.operation === "transfer_to_agent");
  assert.ok(transferCall);
  assert.match(transferCall.endpoint, /actions\/transfer$/);
  assert.match(transferCall.commandId, new RegExp(`^${sagaId}:dial_agent:`));
  assert.equal(transferCall.request.custom_headers[0].value, String(workItem.id));

  // The durable leg intent exists BEFORE any webhook (design principle 2).
  const intents = await pool.query(
    `SELECT state, expected_role, command_id FROM acd_leg_intents WHERE work_item_id = $1`,
    [workItem.id],
  );
  assert.equal(intents.rows.length, 1);
  assert.deepEqual(
    [intents.rows[0].state, intents.rows[0].expected_role],
    ["pending", "agent_device"],
  );

  // Reservation was promoted to ringing while dialing.
  const ringing = await pool.query(
    `SELECT state FROM acd_reservations WHERE id = $1`, [routeResult.reservationId],
  );
  assert.equal(ringing.rows[0].state, "ringing");

  // Agent device leg answers (intake translation is Phase A task #8; we feed the core event).
  const answered = await applySagaEvent(pool, {
    workItemId: workItem.id,
    name: "leg.answered",
    role: "agent_device",
    payload: { event_id: `evt-${randomUUID().slice(0, 8)}` },
    provider,
  });
  assert.equal(answered.state, "running");
  assert.equal(answered.step, "await_bridge");

  const bridged = await applySagaEvent(pool, {
    workItemId: workItem.id,
    name: "leg.bridged",
    role: "customer",
    payload: { event_id: `evt-${randomUUID().slice(0, 8)}` },
    provider,
  });
  assert.equal(bridged.step, "in_call");

  const midCall = await pool.query(
    `SELECT r.state AS res_state, r.handling_session_id, w.state AS wi_state, a.workflow_state
       FROM acd_reservations r
       JOIN acd_work_items w ON w.id = r.work_item_id
       JOIN acd_agent_state a ON a.agent_id = r.agent_id
      WHERE r.id = $1`,
    [routeResult.reservationId],
  );
  assert.equal(midCall.rows[0].res_state, "active");
  assert.ok(midCall.rows[0].handling_session_id);
  assert.equal(midCall.rows[0].wi_state, "active");
  assert.equal(midCall.rows[0].workflow_state, "handling");

  // The dial command is confirmed by webhook evidence, not by HTTP acceptance.
  const commands = await commandRows(sagaId);
  const dialCommand = commands.find((command) => command.step === "dial_agent");
  assert.equal(dialCommand.status, "confirmed");
  assert.ok(dialCommand.confirmation_event_id);

  // Customer hangs up → finalize in ONE transaction → saga succeeded.
  const ended = await applySagaEvent(pool, {
    workItemId: workItem.id,
    name: "leg.ended",
    role: "customer",
    payload: {},
    provider,
  });
  assert.equal(ended.state, "succeeded");
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`,[routeResult.reservationId])).rows[0].state,'active');
  await applySagaEvent(pool,{workItemId:workItem.id,name:'leg.ended',role:'agent_device',provider});

  const final = await pool.query(
    `SELECT w.state, w.terminal_reason, r.state AS res_state, r.released_reason,
            a.workflow_state, a.workflow_deadline_at
       FROM acd_work_items w
       JOIN acd_reservations r ON r.work_item_id = w.id
       JOIN acd_agent_state a ON a.agent_id = $2
      WHERE w.id = $1`,
    [workItem.id, agent],
  );
  assert.equal(final.rows[0].state, "completed");
  assert.equal(final.rows[0].res_state, "released");
  assert.equal(final.rows[0].released_reason, "completed");
  assert.equal(final.rows[0].workflow_state, "wrapup");
  assert.ok(final.rows[0].workflow_deadline_at);

  const segments = await pool.query(
    `SELECT kind, outcome FROM acd_segments WHERE work_item_id = $1 ORDER BY seq`,
    [workItem.id],
  );
  assert.deepEqual(
    segments.rows.map((r) => [r.kind, r.outcome]),
    [["queue_wait", "answered"], ["agent", "completed"]],
  );

  assert.deepEqual(await checkInvariants(pool), {});
});

test("connect: no-answer deadline → compensation requeues with preserved position", { skip }, async () => {
  const provider = makeFakeProvider();
  const { queue, agent, workItem, routeResult, sagaId } = await routedConnect({
    queueAudioMediaName: "test-hold-music",
  });
  await driveSaga(pool, sagaId, { provider });

  // Force the step deadline into the past; the reconciler sweep picks it up.
  await pool.query(`UPDATE acd_sagas SET deadline_at = now() - interval '1 second' WHERE id = $1`, [sagaId]);
  const acted = await sweepDueSagas(pool, { provider });
  assert.equal(acted, 1);

  const saga = await sagaRow(sagaId);
  assert.equal(saga.state, "succeeded"); // compensation chain ran to completion
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`,[routeResult.reservationId])).rows[0].state,'ringing','unknown device outcome retains capacity');
  await applySagaEvent(pool,{workItemId:workItem.id,name:'leg.ended',role:'agent_device',provider});

  const after = await pool.query(
    `SELECT w.state AS wi_state, w.enqueued_at, r.state AS res_state, r.released_reason,
            o.state AS offer_state, a.workflow_state, li.state AS intent_state
       FROM acd_work_items w
       JOIN acd_reservations r ON r.work_item_id = w.id
       JOIN acd_offers o ON o.id = $3
       JOIN acd_agent_state a ON a.agent_id = $2
       JOIN acd_leg_intents li ON li.work_item_id = w.id
      WHERE w.id = $1`,
    [workItem.id, agent, routeResult.offerId],
  );
  const row = after.rows[0];
  assert.equal(row.wi_state, "queued"); // back in queue…
  assert.ok(row.enqueued_at); // …with original enqueue time preserved
  assert.equal(row.res_state, "released");
  assert.equal(row.released_reason, "no_answer");
  assert.equal(row.offer_state, "no_answer");
  assert.equal(row.workflow_state, "idle");
  assert.equal(row.intent_state, "cancelled");

  // No live agent leg existed, so no hangup command was needed (run-branch).
  const commands = await commandRows(sagaId);
  assert.deepEqual(commands.map((c) => c.step), [
    "stop_queue_playback",
    "dial_agent",
    "enqueue_customer",
  ]);
  assert.equal(
    commands.some((command) => command.step === "restart_queue_playback"),
    false,
    "requeue audio must not keep the assignment saga active after queued is published",
  );
  assert.equal(commands.find((c) => c.step === "enqueue_customer")?.request.queue_name, queue);

  // A second router pass can now produce generation 2 for another agent.
  const agent2 = `agent-${randomUUID().slice(0, 8)}`;
  await seedAgent(agent2);
  await seedQueue(`extra-${randomUUID().slice(0, 6)}`, [agent2]); // membership irrelevant here
  assert.deepEqual(await checkInvariants(pool), {});
});

test("connect: call.enqueued webhook confirms an ambiguous provider requeue", { skip }, async () => {
  const provider = makeFakeProvider([
    { outcome: "accepted", httpStatus: 200, response: { data: { result: "dialing" } } },
    { outcome: "ambiguous", httpStatus: null, response: { error: "enqueue timeout" } },
  ]);
  const { workItem, sagaId } = await routedConnect();
  await driveSaga(pool, sagaId, { provider });
  await pool.query(
    `UPDATE acd_sagas SET deadline_at = now() - interval '1 second' WHERE id = $1`,
    [sagaId],
  );
  await sweepDueSagas(pool, { provider });

  let saga = await sagaRow(sagaId);
  assert.equal(saga.step, "enqueue_customer");
  assert.equal(saga.state, "compensating");
  const confirmed = await applySagaEvent(pool, {
    workItemId: workItem.id,
    name: "leg.enqueued",
    role: "customer",
    payload: { event_id: "evt-requeued" },
    provider,
  });
  assert.equal(confirmed.state, "succeeded");
  saga = await sagaRow(sagaId);
  assert.equal(saga.state, "succeeded");
  const work = await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(work.rows[0].state, "queued");
  const enqueueCommand = (await commandRows(sagaId)).find((command) => command.step === "enqueue_customer");
  assert.equal(enqueueCommand.status, "confirmed");
  assert.equal(enqueueCommand.confirmation_event_id, "evt-requeued");
});

test("connect: customer abandons during ring → terminal abandoned, capacity freed", { skip }, async () => {
  const provider = makeFakeProvider();
  const { workItem, routeResult, sagaId } = await routedConnect();
  await driveSaga(pool, sagaId, { provider });

  const result = await applySagaEvent(pool, {
    workItemId: workItem.id,
    name: "leg.ended",
    role: "customer",
    payload: {},
    provider,
  });
  assert.equal(result.state, "succeeded");
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`,[routeResult.reservationId])).rows[0].state,'ringing');
  await applySagaEvent(pool,{workItemId:workItem.id,name:'leg.ended',role:'agent_device',provider});

  const after = await pool.query(
    `SELECT w.state, w.terminal_reason, r.state AS res_state, r.released_reason, o.state AS offer_state
       FROM acd_work_items w
       JOIN acd_reservations r ON r.id = $2
       JOIN acd_offers o ON o.id = $3
      WHERE w.id = $1`,
    [workItem.id, routeResult.reservationId, routeResult.offerId],
  );
  assert.equal(after.rows[0].state, "abandoned");
  assert.equal(after.rows[0].terminal_reason, "customer_abandoned_during_offer");
  assert.equal(after.rows[0].res_state, "released");
  assert.equal(after.rows[0].released_reason, "customer_abandoned");
  assert.equal(after.rows[0].offer_state, "cancelled");
  assert.deepEqual(await checkInvariants(pool), {});
});

for (const operation of ['stop_queue_playback', 'transfer_to_agent', 'enqueue_customer_leg']) {
  test(`connect: ${operation} 90018 waits for signed customer end without false failure`, { skip }, async () => {
    const calls=[];
    const provider={send:async command=>{
      calls.push(command.operation);
      if(command.operation===operation)return {outcome:'failed',httpStatus:422,response:{errors:[{code:'90018',title:'Call has already ended'}]}};
      if(operation==='enqueue_customer_leg'&&command.operation==='transfer_to_agent')return {outcome:'failed',httpStatus:422,response:{error:'invalid dest'}};
      return {outcome:'accepted',httpStatus:200,response:{data:{result:'ok'}}};
    }};
    const {workItem,routeResult,sagaId}=await routedConnect();
    await driveSaga(pool,sagaId,{provider});
    assert.equal((await sagaRow(sagaId)).step,'await_customer_end');
    const before=calls.length;
    await driveSaga(pool,sagaId,{provider}); // Replay must not issue more customer commands.
    assert.equal(calls.length,before);
    const waiting=(await pool.query('SELECT state,terminal_at FROM acd_work_items WHERE id=$1',[workItem.id])).rows[0];
    assert.equal(waiting.terminal_at,null);
    if(operation!=='enqueue_customer_leg')assert.notEqual((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[routeResult.reservationId])).rows[0].state,'released');
    await applySagaEvent(pool,{workItemId:workItem.id,name:'leg.ended',role:'customer',provider});
    const work=(await pool.query('SELECT state,terminal_reason FROM acd_work_items WHERE id=$1',[workItem.id])).rows[0];
    assert.equal(work.state,'abandoned');
    assert.equal(work.terminal_reason,'customer_abandoned_during_offer');
    assert.equal((await sagaRow(sagaId)).state,'succeeded');
    assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[routeResult.reservationId])).rows[0].state,'released');
    const events=(await pool.query('SELECT type FROM acd_events WHERE work_item_id=$1',[workItem.id])).rows.map(e=>e.type);
    assert.ok(!events.includes('manual_intervention_required'));
    if(operation!=='enqueue_customer_leg'){
      assert.ok(!events.includes('offer_no_answer'));
      assert.equal((await pool.query('SELECT state FROM acd_offers WHERE id=$1',[routeResult.offerId])).rows[0].state,'cancelled');
    }
    const after=calls.length;
    await applySagaEvent(pool,{workItemId:workItem.id,name:'leg.ended',role:'customer',provider});
    assert.equal(calls.length,after);
  });
}

test('connect: a rejected device requeues its live customer and remains distinct from timeout', {skip}, async()=>{
  for(const [cause,expected] of [['user_busy','rejected'],['call_rejected','rejected'],['timeout','no_answer']]){
    const {workItem,routeResult,sagaId,agent}=await routedConnect();
    const provider=makeFakeProvider();await driveSaga(pool,sagaId,{provider});
    const generation=(await sagaRow(sagaId)).data.generation;
    await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,agent_id,owner_saga_id,offer_generation,state,ended_at,ended_reason)
      VALUES($1,$2,'agent_device',$3,$4,$5,$6,'ended',now(),$7)`,[randomUUID(),workItem.id,`device:${randomUUID()}`,agent,sagaId,generation,cause]);
    await applySagaEventRaw(pool,{workItemId:workItem.id,name:'leg.ended',role:'agent_device',provider});
    assert.equal((await pool.query('SELECT state FROM acd_offers WHERE id=$1',[routeResult.offerId])).rows[0].state,expected);
    assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[workItem.id])).rows[0].state,'queued');
    assert.equal((await pool.query("SELECT ended_at FROM acd_legs WHERE work_item_id=$1 AND role='customer'",[workItem.id])).rows[0].ended_at,null);
    assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[routeResult.reservationId])).rows[0].state,'released');
    assert.ok(provider.calls.some(c=>c.operation==='enqueue_customer_leg'));
    assert.ok(!provider.calls.some(c=>c.operation==='hangup_customer_leg'));
  }
});

test('connect: only proven pre-answer originator cancellation resolves an uncreated device', {skip}, async()=>{
  const {workItem,routeResult,sagaId}=await routedConnect();
  const transport=`v3:${randomUUID()}`,legId=randomUUID(),eventId=randomUUID();
  const provider=makeFakeProvider([{outcome:'accepted',response:{data:{call_control_id:transport}}}]);
  await driveSaga(pool,sagaId,{provider});
  await pool.query("UPDATE acd_legs SET state='ended',ended_at=now(),ended_reason='originator_cancel' WHERE provider_call_id=$1",[transport]);
  await pool.query(`INSERT INTO acd_webhook_events(event_id,event_type,occurred_at,payload,payload_hash,status)
    VALUES($1,'call.hangup',now(),$2,'test-fixture','applied')`,[eventId,JSON.stringify({call_control_id:transport,hangup_cause:'originator_cancel'})]);
  await applySagaEvent(pool,{workItemId:workItem.id,name:'leg.ended',role:'customer',provider});
  const reservation=(await pool.query('SELECT * FROM acd_reservations WHERE id=$1',[routeResult.reservationId])).rows[0];
  const check=()=>agentMediaEvidence(pool,reservation);
  assert.equal((await check()).proof.kind,'cancelled_unanswered_transfer');
  await pool.query("UPDATE acd_legs SET ended_reason='normal_clearing' WHERE provider_call_id=$1",[transport]);
  assert.equal((await check()).ended,false,'generic sibling hangup cannot prove device end');
  await pool.query("UPDATE acd_legs SET ended_reason='originator_cancel',answered_at=now() WHERE provider_call_id=$1",[transport]);
  assert.equal((await check()).ended,false,'an answered transport cannot use cancellation proof');
  await pool.query('UPDATE acd_legs SET answered_at=NULL WHERE provider_call_id=$1',[transport]);
  await pool.query("UPDATE acd_webhook_events SET status='received' WHERE event_id=$1",[eventId]);
  assert.equal((await check()).ended,false,'unprocessed webhook cannot prove cancellation');
  await pool.query("UPDATE acd_webhook_events SET status='applied' WHERE event_id=$1",[eventId]);
  await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,state,owner_saga_id,offer_generation)
    VALUES($1,$2,'agent_device',$3,'ringing',$4,1)`,[legId,workItem.id,`device:${legId}`,sagaId]);
  assert.equal((await check()).ended,false,'a real device still requires its own end');
  await pool.query("UPDATE acd_legs SET state='ended',ended_at=now() WHERE id=$1",[legId]);
  assert.equal((await check()).ended,true);
});

// A no-answer offer requeues its LIVE customer. Evidence about the agent's
// media must not depend on the customer's fate, or an agent whose device never
// registered keeps a reservation nothing can ever release.
test('a cancelled unanswered transfer releases the agent while its customer is requeued', {skip}, async()=>{
  const {workItem,routeResult,sagaId,agent}=await routedConnect({answerTimeoutMs:20_000});
  const transport=`v3:${randomUUID()}`;
  const provider=makeFakeProvider([{outcome:'accepted',response:{data:{call_control_id:transport}}}]);
  await driveSaga(pool,sagaId,{provider});
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_legs WHERE work_item_id=$1 AND role='agent_device'",[workItem.id])).rows[0].n,0,'the device never registered');

  // The offer times out: cancel the agent leg, then requeue the live customer.
  await pool.query(`UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1`,[sagaId]);
  await sweepDueSagas(pool,{provider});
  assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[workItem.id])).rows[0].state,'queued');
  assert.equal((await pool.query("SELECT ended_at FROM acd_legs WHERE work_item_id=$1 AND role='customer'",[workItem.id])).rows[0].ended_at,null);
  const pending=(await pool.query('SELECT state,release_requested_reason FROM acd_reservations WHERE id=$1',[routeResult.reservationId])).rows[0];
  assert.notEqual(pending.state,'released','an accepted hangup is not media-end evidence');
  const cleanup=(await pool.query("SELECT id FROM acd_sagas WHERE work_item_id=$1 AND type='reservation_cleanup'",[workItem.id])).rows[0];
  assert.ok(cleanup,'the pending release opened a cleanup saga');

  // Telnyx cancels the unanswered INVITE and the signed hangup is persisted.
  await pool.query("UPDATE acd_legs SET state='ended',ended_at=now(),ended_reason='originator_cancel' WHERE provider_call_id=$1",[transport]);
  await pool.query(`INSERT INTO acd_webhook_events(event_id,event_type,occurred_at,payload,payload_hash,status)
    VALUES($1,'call.hangup',now(),$2,'test-fixture','applied')`,
    [randomUUID(),JSON.stringify({call_control_id:transport,hangup_cause:'originator_cancel'})]);
  await driveSaga(pool,cleanup.id,{provider});

  const reservation=(await pool.query('SELECT state,released_reason FROM acd_reservations WHERE id=$1',[routeResult.reservationId])).rows[0];
  assert.equal(reservation.state,'released');
  const state=(await pool.query('SELECT workflow_state,routability FROM acd_agent_state WHERE agent_id=$1',[agent])).rows[0];
  assert.equal(state.workflow_state,'idle','the agent must not stay offered forever');
  assert.deepEqual(await checkInvariants(pool),{});
});

test('accepted cleanup hangup with a missing webhook releases capacity from exact provider end evidence', {skip}, async()=>{
  const {workItem,routeResult,sagaId,agent}=await routedConnect({answerTimeoutMs:20_000});
  const transport=`v3:${randomUUID()}`;
  const device=`v3:${randomUUID()}`;
  const calls=[];
  const provider={send:async command=>{
    calls.push(command);
    if(command.operation==='transfer_to_agent') return {outcome:'accepted',httpStatus:200,response:{data:{call_control_id:transport}}};
    if(command.operation==='verify_agent_leg_end') return {outcome:'accepted',httpStatus:200,response:{data:{
      ended:true,conclusive:true,callControlId:command.request.callControlId,isAlive:false,checkedAt:new Date().toISOString(),
    }}};
    return {outcome:'accepted',httpStatus:200,response:{data:{result:'ok'}}};
  }};
  await driveSaga(pool,sagaId,{provider});
  await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,agent_id,owner_saga_id,offer_generation,state)
    VALUES($1,$2,'agent_device',$3,$4,$5,1,'ringing')`,[randomUUID(),workItem.id,device,agent,sagaId]);
  await pool.query(`UPDATE acd_leg_intents SET state='bound',bound_leg_id=(SELECT id FROM acd_legs
    WHERE work_item_id=$1 AND role='agent_device'),deadline_at=now()-interval '1 second'
    WHERE reservation_id=$2`,[workItem.id,routeResult.reservationId]);

  await pool.query(`UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1`,[sagaId]);
  await sweepDueSagas(pool,{provider});
  const cleanup=(await pool.query("SELECT id FROM acd_sagas WHERE work_item_id=$1 AND type='reservation_cleanup'",[workItem.id])).rows[0];
  assert.ok(cleanup);
  await driveSaga(pool,cleanup.id,{provider});

  assert.equal(calls.filter(call=>call.operation==='reservation_cleanup_hangup').length,1);
  assert.equal(calls.filter(call=>call.operation==='verify_agent_leg_end').length,1);
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[routeResult.reservationId])).rows[0].state,'released');
  const leg=(await pool.query('SELECT state,ended_at,ended_reason FROM acd_legs WHERE provider_call_id=$1',[device])).rows[0];
  assert.equal(leg.state,'ended');
  assert.ok(leg.ended_at);
  assert.equal(leg.ended_reason,'provider_verified_ended');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_events WHERE work_item_id=$1 AND type='agent_media_end_verified'",[workItem.id])).rows[0].n,1);
  assert.equal((await pool.query('SELECT workflow_state FROM acd_agent_state WHERE agent_id=$1',[agent])).rows[0].workflow_state,'idle');
  assert.deepEqual(await checkInvariants(pool),{});
});

test('inconclusive cleanup probe preserves capacity and accepts a late hangup webhook', {skip}, async()=>{
  const {workItem,routeResult,sagaId,agent}=await routedConnect({answerTimeoutMs:20_000});
  const transport=`v3:${randomUUID()}`;
  const device=`v3:${randomUUID()}`;
  const calls=[];
  const provider={send:async command=>{
    calls.push(command);
    if(command.operation==='transfer_to_agent') return {outcome:'accepted',httpStatus:200,response:{data:{call_control_id:transport}}};
    if(command.operation==='verify_agent_leg_end') return {outcome:'accepted',httpStatus:200,response:{data:{
      ended:false,conclusive:true,callControlId:command.request.callControlId,isAlive:true,checkedAt:new Date().toISOString(),
    }}};
    return {outcome:'accepted',httpStatus:200,response:{data:{result:'ok'}}};
  }};
  await driveSaga(pool,sagaId,{provider});
  await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,agent_id,owner_saga_id,offer_generation,state)
    VALUES($1,$2,'agent_device',$3,$4,$5,1,'ringing')`,[randomUUID(),workItem.id,device,agent,sagaId]);
  await pool.query(`UPDATE acd_leg_intents SET state='bound',bound_leg_id=(SELECT id FROM acd_legs
    WHERE work_item_id=$1 AND role='agent_device'),deadline_at=now()-interval '1 second'
    WHERE reservation_id=$2`,[workItem.id,routeResult.reservationId]);
  await pool.query(`UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1`,[sagaId]);
  await sweepDueSagas(pool,{provider});
  const cleanup=(await pool.query("SELECT id FROM acd_sagas WHERE work_item_id=$1 AND type='reservation_cleanup'",[workItem.id])).rows[0];
  await driveSaga(pool,cleanup.id,{provider});

  assert.equal((await sagaRow(cleanup.id)).step,'await_leg_end');
  assert.notEqual((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[routeResult.reservationId])).rows[0].state,'released');
  await applySagaEvent(pool,{workItemId:workItem.id,name:'leg.ended',role:'agent_device',payload:{offer_generation:1},provider});
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[routeResult.reservationId])).rows[0].state,'released');
  assert.equal(calls.filter(call=>call.operation==='verify_agent_leg_end').length,1);
  assert.deepEqual(await checkInvariants(pool),{});
});

test('cancelled transfer with no leg uses authenticated absence evidence only after its offer deadline', {skip}, async()=>{
  const {workItem,sagaId,routeResult,customerProviderCallId}=await routedConnect();
  await pool.query(`UPDATE acd_sagas SET data=data || '{"connectionId":"credential-fixture"}'::jsonb WHERE id=$1`,[sagaId]);
  const calls=[];
  const provider={send:async command=>{calls.push(command.operation);return {outcome:'accepted',httpStatus:200,response:command.operation==='verify_cancelled_agent_absence'?{data:{ended:true,...command.request,checkedAt:new Date().toISOString(),targetConnectionId:'456',connections:[{connectionId:'123',activeCalls:0},{connectionId:'456',activeCalls:0}]}}:{data:{result:'ok'}}};}};
  await driveSaga(pool,sagaId,{provider});
  await pool.query(`INSERT INTO acd_webhook_events(event_id,event_type,payload,payload_hash,status)
    VALUES($1,'call.hangup',$2,'fixture','applied')`,[randomUUID(),JSON.stringify({call_control_id:customerProviderCallId,connection_id:'123'})]);
  await applySagaEvent(pool,{workItemId:workItem.id,name:'leg.ended',role:'customer',provider});
  const cleanup=(await pool.query("SELECT id FROM acd_sagas WHERE work_item_id=$1 AND type='reservation_cleanup'",[workItem.id])).rows[0];
  await driveSaga(pool,cleanup.id,{provider});
  assert.ok(!calls.includes('verify_cancelled_agent_absence'));
  await pool.query("UPDATE acd_leg_intents SET deadline_at=now()-interval '1 second' WHERE reservation_id=$1",[routeResult.reservationId]);
  await driveSaga(pool,cleanup.id,{provider});
  assert.equal(calls.filter(x=>x==='verify_cancelled_agent_absence').length,1);
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[routeResult.reservationId])).rows[0].state,'released');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_events WHERE work_item_id=$1 AND type='agent_media_absence_verified'",[workItem.id])).rows[0].n,1);
  await driveSaga(pool,cleanup.id,{provider});
  assert.equal(calls.filter(x=>x==='verify_cancelled_agent_absence').length,1);
});

for (const absenceProven of [false, true]) {
  test(`ambiguous outbound agent Dial without a leg ${absenceProven ? 'recovers from provider absence' : 'preserves capacity when absence is unknown'}`, {skip}, async()=>{
    const {workItem,sagaId,routeResult,customerProviderCallId}=await routedConnect();
    await pool.query(`UPDATE acd_sagas SET data=data || '{"connectionId":"credential-fixture"}'::jsonb WHERE id=$1`,[sagaId]);
    const provider=makeFakeProvider();
    await driveSaga(pool,sagaId,{provider});
    // Reproduce the persisted F-27 boundary: an ambiguous standalone Dial,
    // cancelled intent, no provider leg identity, and an ended customer.
    await pool.query(`UPDATE acd_commands SET operation='outbound_agent_dial',status='ambiguous',
      http_status=NULL,accepted_at=NULL,response=NULL WHERE saga_id=$1 AND operation='transfer_to_agent'`,[sagaId]);
    await pool.query(`INSERT INTO acd_webhook_events(event_id,event_type,payload,payload_hash,status)
      VALUES($1,'call.hangup',$2,'fixture','applied')`,[randomUUID(),JSON.stringify({call_control_id:customerProviderCallId,connection_id:'123'})]);
    await applySagaEvent(pool,{workItemId:workItem.id,name:'leg.ended',role:'customer',provider});
    const cleanup=(await pool.query("SELECT id FROM acd_sagas WHERE work_item_id=$1 AND type='reservation_cleanup'",[workItem.id])).rows[0];
    assert.ok(cleanup);
    const reads=[];
    const recoveryProvider={send:async command=>{
      reads.push(command);
      assert.equal(command.operation,'verify_cancelled_agent_absence','Recovery may only read provider evidence');
      return {outcome:'accepted',httpStatus:200,response:{data:{ended:absenceProven,...command.request,
        checkedAt:new Date().toISOString(),targetConnectionId:'456',connections:absenceProven?[{connectionId:'123',activeCalls:0},{connectionId:'456',activeCalls:0}]:[]}}};
    }};
    await driveSaga(pool,cleanup.id,{provider:recoveryProvider});
    assert.equal(reads.length,0,'Do not reconcile before the original intent deadline');
    await pool.query("UPDATE acd_leg_intents SET deadline_at=now()-interval '1 second' WHERE reservation_id=$1",[routeResult.reservationId]);
    await driveSaga(pool,cleanup.id,{provider:recoveryProvider});
    assert.equal(reads.length,1);
    assert.equal(reads[0].request.customerCallId,customerProviderCallId);
    assert.equal(reads[0].request.credentialId,'credential-fixture');
    const reservation=(await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[routeResult.reservationId])).rows[0];
    assert.equal(reservation.state==='released',absenceProven);
    const events=await pool.query("SELECT id FROM acd_events WHERE work_item_id=$1 AND type='agent_media_absence_verified'",[workItem.id]);
    assert.equal(events.rowCount,absenceProven?1:0);
    await driveSaga(pool,cleanup.id,{provider:recoveryProvider});
    assert.equal(reads.length,1,'No unbounded probe or repeated Dial');
  });
}

test("connect: persisted customer end prevents the initial provider command", { skip }, async () => {
  const {workItem,sagaId}=await routedConnect();
  await pool.query("UPDATE acd_legs SET ended_at=now(),state='ended' WHERE work_item_id=$1 AND role='customer'",[workItem.id]);
  const provider=makeFakeProvider();
  await driveSaga(pool,sagaId,{provider});
  assert.equal(provider.calls.length,0);
  assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[workItem.id])).rows[0].state,'abandoned');
});

test("connect: definitive provider rejection routes to requeue compensation", { skip }, async () => {
  const provider = makeFakeProvider([{ outcome: "failed", httpStatus: 422, response: { error: "invalid dest" } }]);
  const { workItem, sagaId } = await routedConnect();
  const driven = await driveSaga(pool, sagaId, { provider });
  assert.equal(driven.state, "succeeded"); // failure → requeue compensation → done

  const commands = await commandRows(sagaId);
  assert.equal(commands.find((command) => command.step === "dial_agent")?.status, "failed");
  const wi = await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(wi.rows[0].state, "queued");
  assert.deepEqual(await checkInvariants(pool), {});
});

test("ambiguous send is resolved by later webhook evidence, not by resend", { skip }, async () => {
  const provider = makeFakeProvider([{ outcome: "ambiguous", httpStatus: null, response: { error: "timeout" } }]);
  const { workItem, sagaId } = await routedConnect();

  const driven = await driveSaga(pool, sagaId, { provider });
  assert.equal(driven.waiting, "evidence");
  let commands = await commandRows(sagaId);
  assert.equal(commands.find((command) => command.step === "dial_agent")?.status, "ambiguous");

  // The transfer actually went through — the answered webhook arrives.
  const answered = await applySagaEvent(pool, {
    workItemId: workItem.id,
    name: "leg.answered",
    role: "agent_device",
    payload: { event_id: "evt-late" },
    provider,
  });
  assert.equal(answered.step, "await_bridge");
  const bridged = await applySagaEvent(pool, {
    workItemId: workItem.id,
    name: "leg.bridged",
    role: "customer",
    payload: { event_id: "evt-bridge-late" },
    provider,
  });
  assert.equal(bridged.step, "in_call");
  commands = await commandRows(sagaId);
  const dialCommand = commands.find((command) => command.step === "dial_agent");
  assert.equal(dialCommand.status, "confirmed");
  assert.equal(dialCommand.confirmation_event_id, "evt-late");
});

test("resend inside dedupe window reuses the SAME command_id; outside it waits", { skip }, async () => {
  const provider = makeFakeProvider();
  const { sagaId } = await routedConnect();
  await driveSaga(pool, sagaId, { provider });
  const transferCalls = () => provider.calls.filter((call) => call.operation === "transfer_to_agent");
  assert.equal(transferCalls().length, 1);

  // Simulate a crash after send with no recorded outcome.
  await pool.query(
    `UPDATE acd_commands SET status = 'sent' WHERE saga_id = $1 AND step = 'dial_agent'`,
    [sagaId],
  );
  await driveSaga(pool, sagaId, { provider });
  assert.equal(transferCalls().length, 2);
  assert.equal(transferCalls()[0].commandId, transferCalls()[1].commandId); // same effect, same id

  // Age the command beyond the provider dedupe window → engine must NOT resend.
  await pool.query(
    `UPDATE acd_commands SET status = 'sent', created_at = now() - interval '2 minutes'
      WHERE saga_id = $1 AND step = 'dial_agent'`,
    [sagaId],
  );
  const waited = await driveSaga(pool, sagaId, { provider });
  assert.equal(waited.waiting, "evidence");
  assert.equal(transferCalls().length, 2); // no third transfer send
});

test("conflict key enforces one active saga per effect", { skip }, async () => {
  const { workItem } = await routedConnect();
  await assert.rejects(
    withTx((tx) =>
      startSaga(tx, {
        type: "connect",
        workItemId: workItem.id,
        conflictKey: "assignment",
        data: {},
      }),
    ),
    SagaConflictError,
  );
});

test("lease: a foreign live lease blocks driving; an expired one is taken over", { skip }, async () => {
  const provider = makeFakeProvider();
  const { sagaId } = await routedConnect();

  await pool.query(
    `UPDATE acd_sagas SET lease_owner = 'node-crashed',
            lease_expires_at = now() + interval '10 seconds' WHERE id = $1`,
    [sagaId],
  );
  const blocked = await driveSaga(pool, sagaId, { provider, node: "node-b" });
  assert.equal(blocked.state, "not_claimable");
  assert.equal(provider.calls.length, 0);

  await pool.query(
    `UPDATE acd_sagas SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [sagaId],
  );
  const taken = await driveSaga(pool, sagaId, { provider, node: "node-b" });
  assert.equal(taken.waiting, "confirmation");
  assert.equal(provider.calls.filter((call) => call.operation === "transfer_to_agent").length, 1);
  // Once the engine is waiting on external evidence, the execution lease is
  // RELEASED so the reconciler can act on deadlines immediately.
  const saga = await sagaRow(sagaId);
  assert.equal(saga.lease_owner, null);
  assert.equal(saga.lease_expires_at, null);
});

test("provider: a hangup rejected because the call already ended is recognised as such", () => {
  assert.equal(isHangupEndpoint("/calls/v3%3Aabc/actions/hangup"), true);
  assert.equal(isHangupEndpoint("/calls/v3%3Aabc/actions/bridge"), false);
  assert.equal(isHangupEndpoint("/calls"), false);
  assert.equal(hangupEndpointCallId("/calls/v3%3Aabc%2Fdef/actions/hangup"), "v3:abc/def");
  assert.equal(hangupEndpointCallId("/calls/v3%3Aabc/actions/bridge"), null);
  assert.equal(isAlreadyEndedResponse({ errors: [{ code: "90018", title: "Call has already ended" }] }), true);
  assert.equal(isAlreadyEndedResponse({ errors: [{ code: 90018 }] }), true);
  assert.equal(isAlreadyEndedResponse({ errors: [{ code: "10000", title: "Invalid request" }] }), false);
  assert.equal(isAlreadyEndedResponse({ data: { result: "ok" } }), false);
  assert.equal(isAlreadyEndedResponse(null), false);
});

test("connect: a hangup answered with 90018 is the customer leg's confirmed end, not a failed command", { skip }, async () => {
  const provider = {
    calls: [],
    async send(command) {
      provider.calls.push(command);
      if (command.operation === "hangup_customer_leg") {
        return { outcome: "failed", httpStatus: 422, response: { errors: [{ code: "90018", title: "Call has already ended" }] } };
      }
      return { outcome: "accepted", httpStatus: 200, response: { data: { result: "ok" } } };
    },
  };
  const { workItem, routeResult, sagaId } = await routedConnect();
  await driveSaga(pool, sagaId, { provider });
  await applySagaEvent(pool, { workItemId: workItem.id, name: "leg.answered", role: "agent_device", provider });
  await applySagaEvent(pool, { workItemId: workItem.id, name: "leg.bridged", role: "customer", provider });
  assert.equal((await sagaRow(sagaId)).step, "in_call");

  // The guard elapses and Core hangs up the customer, who has just hung up
  // themselves: the provider reports the call as already ended.
  await pool.query(`UPDATE acd_sagas SET deadline_at = now() - interval '1 second' WHERE id = $1`, [sagaId]);
  await sweepDueSagas(pool, { provider });

  const saga = await sagaRow(sagaId);
  assert.equal(saga.state, "succeeded");
  const hangup = (await commandRows(sagaId)).find((command) => command.operation === "hangup_customer_leg");
  assert.ok(hangup);
  assert.equal(hangup.status, "accepted");
  assert.equal(hangup.http_status, 422);
  assert.equal(hangup.last_error, null);
  const leg = (await pool.query(
    `SELECT state, ended_at, ended_reason FROM acd_legs WHERE work_item_id = $1 AND role = 'customer'`,
    [workItem.id],
  )).rows[0];
  assert.equal(leg.state, "ended");
  assert.ok(leg.ended_at);
  assert.equal(leg.ended_reason, "provider_already_ended");
  const work = (await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [workItem.id])).rows[0];
  assert.equal(work.state, "completed");
  // The agent device leg is still up, so capacity stays reserved until its own
  // end evidence arrives; the provider's verdict on the customer leg proves
  // nothing about the agent's device.
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id = $1`, [routeResult.reservationId])).rows[0].state, "active");
  await applySagaEvent(pool, { workItemId: workItem.id, name: "leg.ended", role: "agent_device", provider });
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id = $1`, [routeResult.reservationId])).rows[0].state, "released");
  const events = (await pool.query(`SELECT type, payload FROM acd_events WHERE work_item_id = $1 ORDER BY id`, [workItem.id])).rows;
  const settled = events.find((event) => event.type === "hangup_target_already_ended");
  assert.ok(settled);
  assert.equal(settled.payload.operation, "hangup_customer_leg");
  assert.equal(settled.payload.role, "customer");
  assert.equal(settled.payload.command_id, hangup.command_id);
  assert.ok(!events.some((event) => event.type === "manual_intervention_required"));
  assert.ok(!events.some((event) => event.type === "saga_step" && String(event.payload.reason || "").startsWith("provider_rejected")));
  assert.deepEqual(await checkInvariants(pool), {});

  // The provider's own hangup webhook arrives afterwards: nothing left to do.
  const before = provider.calls.length;
  await applySagaEvent(pool, { workItemId: workItem.id, name: "leg.ended", role: "customer", provider });
  assert.equal(provider.calls.length, before);
  assert.equal((await sagaRow(sagaId)).state, "succeeded");
});

test("engine: 90018 on a non-hangup command is still a rejection", { skip }, async () => {
  const provider = {
    calls: [],
    async send(command) {
      provider.calls.push(command);
      if (command.operation === "transfer_to_agent") {
        return { outcome: "failed", httpStatus: 422, response: { errors: [{ code: "90018", title: "Call has already ended" }] } };
      }
      return { outcome: "accepted", httpStatus: 200, response: { data: { result: "ok" } } };
    },
  };
  const { sagaId } = await routedConnect();
  await driveSaga(pool, sagaId, { provider });
  const transfer = (await commandRows(sagaId)).find((command) => command.operation === "transfer_to_agent");
  assert.equal(transfer.status, "failed");
  assert.equal((await sagaRow(sagaId)).step, "await_customer_end");
});

test.after(async () => {
  await pool?.end().catch(() => {});
});
