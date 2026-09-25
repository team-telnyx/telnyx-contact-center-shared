import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, makeTxRunner, seedAgent, makeFakeProvider } from './helpers/acd-test-db.mjs';
import { tryReserveCapacity } from '../lib/acd/capacity.mjs';
import { releaseReservation, promoteReservation } from '../lib/acd/reservations.mjs';
import { heartbeatAgentSession, expireAgentSessions } from '../lib/acd/sessions.mjs';
import { setManualAgentStatus, setWorkflowState, effectiveAgentStatus } from '../lib/acd/agent-state.mjs';
import {
  alarmUnconfirmedDirectIntents,
  applyDirectCapacityEvent,
  cancelUnstartedDirectIntent,
  rejectDirectIntent,
  reserveDirectVoice,
  reserveSupervisionVoice,
  settleEndedDirectIntents,
} from '../lib/acd/direct-capacity.mjs';
import { authorizePersistedInteractionControl } from '../lib/voice/interaction-control-policy.mjs';
import { createWorkItem, applyTransition, openSegment, closeOpenSegment } from '../lib/acd/lifecycle.mjs';
import { requestMediaIntent } from '../lib/acd/sagas/media.mjs';
import { executeAcdOperation, readAcdOperations } from '../lib/acd/operations.mjs';
import { readAgentSnapshot } from '../lib/acd/stream.mjs';
import { admitAcdVoiceEvent } from '../lib/acd/admission.mjs';
import { drainInboxOnce } from '../lib/acd/worker.mjs';
import { agentMediaEvidence } from '../lib/acd/agent-media-evidence.mjs';
import { clearSagaDeadlineWakeups, driveSaga } from '../lib/acd/saga-engine.mjs';

const pool = await prepareAcdTestPool('acd_core_test_voice_capacity');
const tx = makeTxRunner(pool);
after(() => {
  clearSagaDeadlineWakeups();
  return pool.end();
});
async function agent() {
  const sessionId = randomUUID();
  const id = randomUUID(); await seedAgent(pool, id, { sessionId });
  return { id, sessionId };
}
const state = async id => (await pool.query('SELECT * FROM acd_agent_state WHERE agent_id=$1', [id])).rows[0];
async function activeVoice(agentId) {
  return tx(async t => {
    const wi = await createWorkItem(t, { channel: 'voice', direction: 'inbound' });
    const res = await tryReserveCapacity(t, { agentId, workItemId: wi.id });
    assert.ok(res);
    for (const to of ['queued','offered','active']) await applyTransition(t, { workItemId: wi.id, to, eventType: 'fixture', actor: 'test' });
    await promoteReservation(t, { reservationId: res, to: 'active', handlingSessionId: randomUUID() });
    await openSegment(t, { workItemId: wi.id, kind: 'agent', agentId, answeredAt: new Date().toISOString() });
    await t.query(`INSERT INTO acd_legs (id,work_item_id,role,provider_call_id,state) VALUES ($1,$2,'customer',$3,'answered')`, [randomUUID(),wi.id,`v3:${randomUUID()}`]);
    return { wi, res };
  });
}

test('manual and queued Core reservations cannot double-assign one voice agent', async () => {
  const a = await agent();
  const results = await Promise.allSettled([
    reserveDirectVoice(pool, { agentId:a.id, target:'+15550001111' }),
    tx(t => tryReserveCapacity(t, { agentId:a.id })),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value).length, 1);
  const count = await pool.query(`SELECT COUNT(*)::int AS n FROM acd_reservations WHERE agent_id=$1 AND state <> 'released'`, [a.id]);
  assert.equal(count.rows[0].n,1);
});

test('Core promotion/release applies a pending manual break atomically', async () => {
  const a = await agent();
  const work = await tx(t => createWorkItem(t, { channel:'voice', direction:'inbound' }));
  const res = await tx(t => tryReserveCapacity(t, { agentId:a.id, workItemId:work.id }));
  await tx(t => promoteReservation(t, { reservationId:res, to:'active', handlingSessionId:randomUUID() }));
  assert.equal((await state(a.id)).workflow_state, 'handling');
  assert.equal(await setManualAgentStatus(pool,{agentId:a.id,status:'Break'}), 'Busy');
  await tx(t => releaseReservation(t,res,'fixture_end'));
  assert.equal(effectiveAgentStatus(await state(a.id)), 'Break');
  const core = await state(a.id);
  assert.equal(core.manual_status,'Break');
  assert.equal(core.routability,'not_routable');
});

test('device readiness expires without releasing an active voice reservation', async () => {
  const a = await agent(); const call = await activeVoice(a.id);
  await pool.query(`UPDATE acd_agent_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`,[a.sessionId]);
  await expireAgentSessions(pool);
  assert.equal((await state(a.id)).presence,'offline');
  assert.equal(effectiveAgentStatus(await state(a.id)),'Busy');
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[call.res])).rows[0].state,'active');
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:a.id})),null);
});

test('session identifiers cannot be stolen and stale manual versions cannot overwrite state',async()=>{
  const a=await agent(),b=await agent();
  await assert.rejects(heartbeatAgentSession(pool,{agentId:b.id,sessionId:a.sessionId,voiceReady:true}),{status:403});
  const staleVersion=(await state(a.id)).version;
  await setManualAgentStatus(pool,{agentId:a.id,status:'Break',expectedVersion:staleVersion});
  await assert.rejects(setManualAgentStatus(pool,{agentId:a.id,status:'Available',expectedVersion:staleVersion}),{status:409});
});

test('wrap-up belongs to the ended segment; next manual status applies only after completion',async()=>{
  const a=await agent();const call=await activeVoice(a.id);
  await tx(async t=>{
    await closeOpenSegment(t,call.wi.id,{outcome:'completed'});
    await releaseReservation(t,call.res,'fixture_end_evidence');
    await setWorkflowState(t,a.id,'wrapup',{workItemId:call.wi.id,deadlineAt:new Date(Date.now()+60000).toISOString()});
  });
  await setManualAgentStatus(pool,{agentId:a.id,status:'Break'});
  assert.equal(effectiveAgentStatus(await state(a.id)),'Wrapup');
  const segment=(await pool.query('SELECT wrapup_deadline_at,wrapup_ended_at FROM acd_segments WHERE work_item_id=$1',[call.wi.id])).rows[0];
  assert.ok(segment.wrapup_deadline_at);assert.equal(segment.wrapup_ended_at,null);
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:a.id})),null);
});

test('manual outbound intent is idempotent and owns a queue-less Core lifecycle',async()=>{
  const a=await agent();const requestId=randomUUID();const target='+15550002222';
  const intent=await reserveDirectVoice(pool,{agentId:a.id,requestId,target});
  assert.equal((await reserveDirectVoice(pool,{agentId:a.id,requestId,target})).id,intent.id);
  const work=(await pool.query('SELECT * FROM acd_work_items WHERE id=$1',[intent.work_item_id])).rows[0];
  assert.equal(work.queue_id,null);assert.equal(work.state,'offered');
  assert.equal(work.attributes.voice_occupancy_kind,'manual_outbound');
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:a.id})),null);
  const base={to:target,custom_headers:[{name:'X-CC-Direct-Intent-Id',value:intent.id}]};
  await applyDirectCapacityEvent(pool,{eventType:'call.initiated',payload:{...base,call_control_id:'v3:manual',direction:'outgoing'}});
  assert.equal((await state(a.id)).workflow_state,'handling');
  await applyDirectCapacityEvent(pool,{eventType:'call.answered',payload:{...base,call_control_id:'v3:manual',direction:'outgoing'}});
  await applyDirectCapacityEvent(pool,{eventType:'call.hangup',payload:{...base,call_control_id:'v3:manual',direction:'outgoing'}});
  assert.equal((await state(a.id)).workflow_state,'idle');
  assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[intent.work_item_id])).rows[0].state,'completed');
  assert.ok((await pool.query('SELECT answered_at FROM acd_segments WHERE work_item_id=$1',[intent.work_item_id])).rows[0].answered_at);
  const history=(await pool.query('SELECT from_number,to_number,metadata FROM acd_history_interactions WHERE work_item_id=$1',[intent.work_item_id])).rows[0];
  assert.equal(history.from_number,a.id);assert.equal(history.to_number,target);
  assert.equal(history.metadata.wrapup_started_at,undefined);
});

test('manual WebRTC origination durably dials and bridges one PSTN leg',async()=>{
  const previousCallControlId=process.env.TELNYX_CALL_CONTROL_ID;
  const previousMainFrom=process.env.TELNYX_MAIN_FROM_NUMBER;
  process.env.TELNYX_CALL_CONTROL_ID='call-control-app-test';
  process.env.TELNYX_MAIN_FROM_NUMBER='+15550009999';
  try {
    const a=await agent();
    await pool.query(`UPDATE users SET voice_number='+15550008888',first_name='Test',last_name='Agent'
      WHERE id=$1`,[a.id]);
    const target='+15550002222';
    const intent=await reserveDirectVoice(pool,{agentId:a.id,target});
    const agentCallControlId=`v3:manual-agent-${randomUUID()}`;
    const customerCallControlId=`v3:manual-customer-${randomUUID()}`;
    const callSessionId=randomUUID();
    const provider=makeFakeProvider([{
      outcome:'accepted',httpStatus:200,
      response:{data:{call_control_id:customerCallControlId,call_session_id:callSessionId}},
    }]);
    const headers=[{name:'X-CC-Direct-Intent-Id',value:intent.id}];
    const initial={
      eventId:randomUUID(),eventType:'call.initiated',sourceRoute:'voice',
      payload:{
        call_control_id:agentCallControlId,call_session_id:callSessionId,
        connection_id:'agent-credential-connection',direction:'outgoing',
        from:'+15550007777',to:target,custom_headers:headers,
      },
    };
    assert.equal((await admitAcdVoiceEvent(pool,initial)).durable,true);
    await drainInboxOnce(pool,provider,{node:'manual-outbound-test',limit:100});

    assert.equal(provider.calls.length,1);
    const dial=provider.calls[0];
    assert.equal(dial.operation,'manual_outbound_dial');
    assert.equal(dial.endpoint,'/calls');
    assert.equal(dial.request.to,target);
    assert.equal(dial.request.from,'+15550007777');
    assert.equal(dial.request.connection_id,'call-control-app-test');
    assert.equal(dial.request.link_to,agentCallControlId);
    assert.equal(dial.request.bridge_intent,true);
    assert.equal(dial.request.bridge_on_answer,true);
    assert.equal(dial.request.park_after_unbridge,'self');
    assert.equal(dial.request.from_display_name,'Test Agent');

    const saga=(await pool.query(`SELECT * FROM acd_sagas
      WHERE work_item_id=$1 AND type='manual_outbound'`,[intent.work_item_id])).rows[0];
    assert.ok(saga);assert.equal(saga.step,'await_customer');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_commands
      WHERE saga_id=$1 AND operation='manual_outbound_dial'`,[saga.id])).rows[0].n,1);
    assert.deepEqual((await pool.query(`SELECT role,agent_id,state,owner_saga_id FROM acd_legs
      WHERE provider_call_id=$1`,[agentCallControlId])).rows[0],{
      role:'agent_device',agent_id:a.id,state:'ringing',owner_saga_id:saga.id,
    });
    assert.deepEqual((await pool.query(`SELECT role,agent_id,state,owner_saga_id FROM acd_legs
      WHERE provider_call_id=$1`,[customerCallControlId])).rows[0],{
      role:'customer',agent_id:null,state:'dialing',owner_saga_id:saga.id,
    });

    // A duplicate provider delivery and a restarted executor both reuse the
    // journaled effect rather than originating a second PSTN leg.
    const duplicate={...initial,eventId:randomUUID()};
    assert.equal((await admitAcdVoiceEvent(pool,duplicate)).durable,true);
    await drainInboxOnce(pool,provider,{node:'manual-outbound-replay',limit:100});
    await driveSaga(pool,saga.id,{provider,node:'manual-outbound-restart'});
    assert.equal(provider.calls.filter(call=>call.operation==='manual_outbound_dial').length,1);

    const customerHeaders=dial.request.custom_headers;
    for(const [eventType,extra] of [
      ['call.initiated',{}],
      ['call.answered',{}],
    ]){
      const envelope={eventId:randomUUID(),eventType,sourceRoute:'voice',payload:{
        call_control_id:customerCallControlId,call_session_id:callSessionId,
        direction:'outgoing',from:'+15550007777',to:target,
        custom_headers:customerHeaders,...extra,
      }};
      assert.equal((await admitAcdVoiceEvent(pool,envelope)).durable,true);
      await drainInboxOnce(pool,provider,{node:'manual-outbound-customer',limit:100});
    }
    assert.equal(provider.calls.some(call=>call.operation==='manual_outbound_bridge'),false,
      'automatic Dial bridge must not be repeated by an explicit Bridge command');
    assert.equal((await pool.query(`SELECT step FROM acd_sagas WHERE id=$1`,[saga.id])).rows[0].step,
      'await_customer_bridge');
    const bridged={eventId:randomUUID(),eventType:'call.bridged',sourceRoute:'voice',payload:{
      call_control_id:customerCallControlId,call_session_id:callSessionId,
      direction:'outgoing',from:'+15550007777',to:target,
      custom_headers:customerHeaders,bridged_call_control_id:agentCallControlId,
    }};
    assert.equal((await admitAcdVoiceEvent(pool,bridged)).durable,true);
    await drainInboxOnce(pool,provider,{node:'manual-outbound-bridge',limit:100});
    assert.equal((await pool.query(`SELECT step FROM acd_sagas WHERE id=$1`,[saga.id])).rows[0].step,'handling');
    assert.ok((await pool.query(`SELECT answered_at FROM acd_segments
      WHERE work_item_id=$1 AND kind='agent'`,[intent.work_item_id])).rows[0].answered_at);

    const customerHangup={eventId:randomUUID(),eventType:'call.hangup',sourceRoute:'voice',payload:{
      call_control_id:customerCallControlId,call_session_id:callSessionId,
      direction:'outgoing',from:'+15550007777',to:target,
      custom_headers:customerHeaders,hangup_cause:'normal_clearing',
    }};
    assert.equal((await admitAcdVoiceEvent(pool,customerHangup)).durable,true);
    await drainInboxOnce(pool,provider,{node:'manual-outbound-customer-end',limit:100});
    assert.ok(provider.calls.some(call=>call.operation==='manual_outbound_hangup_agent'
      && call.endpoint===`/calls/${encodeURIComponent(agentCallControlId)}/actions/hangup`));
    assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`,[intent.reservation_id])).rows[0].state,'active');

    const agentHangup={eventId:randomUUID(),eventType:'call.hangup',sourceRoute:'voice',payload:{
      ...initial.payload,hangup_cause:'normal_clearing',
    }};
    assert.equal((await admitAcdVoiceEvent(pool,agentHangup)).durable,true);
    await drainInboxOnce(pool,provider,{node:'manual-outbound-agent-end',limit:100});
    assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id=$1`,[saga.id])).rows[0].state,'succeeded');
    assert.equal((await pool.query(`SELECT state FROM acd_work_items WHERE id=$1`,[intent.work_item_id])).rows[0].state,'completed');
    assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`,[intent.reservation_id])).rows[0].state,'released');
    assert.equal((await pool.query(`SELECT state FROM acd_direct_intents WHERE id=$1`,[intent.id])).rows[0].state,'ended');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_events
      WHERE work_item_id=$1 AND type='manual_intervention_required'`,[intent.work_item_id])).rows[0].n,0);
  }finally{
    if(previousCallControlId===undefined)delete process.env.TELNYX_CALL_CONTROL_ID;
    else process.env.TELNYX_CALL_CONTROL_ID=previousCallControlId;
    if(previousMainFrom===undefined)delete process.env.TELNYX_MAIN_FROM_NUMBER;
    else process.env.TELNYX_MAIN_FROM_NUMBER=previousMainFrom;
  }
});

test('definitive manual PSTN rejection hangs up the parked agent before releasing capacity',async()=>{
  const previousCallControlId=process.env.TELNYX_CALL_CONTROL_ID;
  process.env.TELNYX_CALL_CONTROL_ID='call-control-app-test';
  try{
    const a=await agent();
    await pool.query(`UPDATE users SET voice_number='+15550008888' WHERE id=$1`,[a.id]);
    const target='+15550003333';
    const intent=await reserveDirectVoice(pool,{agentId:a.id,target});
    const agentCallControlId=`v3:manual-agent-${randomUUID()}`;
    const rejectedCallControlId=`v3:rejected-customer-${randomUUID()}`;
    const provider=makeFakeProvider([{
      outcome:'failed',httpStatus:422,response:{
        data:{call_control_id:rejectedCallControlId},
        errors:[{code:'10010',detail:'unverified origination number'}],
      },
    }]);
    const payload={
      call_control_id:agentCallControlId,call_session_id:randomUUID(),
      direction:'outgoing',from:'+15550008888',to:target,
      custom_headers:[{name:'X-CC-Direct-Intent-Id',value:intent.id}],
    };
    const initiated={eventId:randomUUID(),eventType:'call.initiated',sourceRoute:'voice',payload};
    assert.equal((await admitAcdVoiceEvent(pool,initiated)).durable,true);
    await drainInboxOnce(pool,provider,{node:'manual-outbound-rejected',limit:100});
    assert.deepEqual(provider.calls.map(call=>call.operation),[
      'manual_outbound_dial',
      'manual_outbound_hangup_agent',
    ]);
    assert.equal(provider.calls[1].endpoint,
      `/calls/${encodeURIComponent(agentCallControlId)}/actions/hangup`);
    assert.equal((await pool.query(`SELECT state FROM acd_work_items WHERE id=$1`,[intent.work_item_id])).rows[0].state,'active');
    assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`,[intent.reservation_id])).rows[0].state,'active');

    const agentHangup={
      eventId:randomUUID(),eventType:'call.hangup',sourceRoute:'voice',
      payload:{...payload,hangup_cause:'origination_failed'},
    };
    assert.equal((await admitAcdVoiceEvent(pool,agentHangup)).durable,true);
    await drainInboxOnce(pool,provider,{node:'manual-outbound-rejected-agent-ended',limit:100});
    assert.equal((await pool.query(`SELECT state FROM acd_work_items WHERE id=$1`,[intent.work_item_id])).rows[0].state,'failed');
    assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`,[intent.reservation_id])).rows[0].state,'released');
    assert.equal((await pool.query(`SELECT state FROM acd_direct_intents WHERE id=$1`,[intent.id])).rows[0].state,'ended');
    assert.equal((await pool.query(`SELECT state FROM acd_sagas
      WHERE work_item_id=$1 AND type='manual_outbound'`,[intent.work_item_id])).rows[0].state,'succeeded');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_legs
      WHERE work_item_id=$1 AND role='customer'`,[intent.work_item_id])).rows[0].n,0);
    assert.equal((await pool.query(`SELECT ended_reason FROM acd_legs
      WHERE work_item_id=$1 AND role='agent_device'`,[intent.work_item_id])).rows[0].ended_reason,'origination_failed');
    assert.equal(effectiveAgentStatus(await state(a.id)),'Available');
  }finally{
    if(previousCallControlId===undefined)delete process.env.TELNYX_CALL_CONTROL_ID;
    else process.env.TELNYX_CALL_CONTROL_ID=previousCallControlId;
  }
});

test('manual customer initiation can beat the Dial response without losing cleanup ownership',async()=>{
  const previousCallControlId=process.env.TELNYX_CALL_CONTROL_ID;
  process.env.TELNYX_CALL_CONTROL_ID='call-control-app-test';
  try{
    const a=await agent();
    await pool.query(`UPDATE users SET voice_number='+15550008888' WHERE id=$1`,[a.id]);
    const target='+15550004444';
    const intent=await reserveDirectVoice(pool,{agentId:a.id,target});
    const agentCallControlId=`v3:manual-agent-${randomUUID()}`;
    const customerCallControlId=`v3:manual-customer-${randomUUID()}`;
    const provider=makeFakeProvider([{
      outcome:'accepted',httpStatus:200,response:{data:{}},
    }]);
    const agentPayload={
      call_control_id:agentCallControlId,call_session_id:randomUUID(),
      direction:'outgoing',from:'+15550008888',to:target,
      custom_headers:[{name:'X-CC-Direct-Intent-Id',value:intent.id}],
    };
    const initiated={eventId:randomUUID(),eventType:'call.initiated',sourceRoute:'voice',payload:agentPayload};
    await admitAcdVoiceEvent(pool,initiated);
    await drainInboxOnce(pool,provider,{node:'manual-outbound-race',limit:100});
    const dial=provider.calls.find(call=>call.operation==='manual_outbound_dial');
    const saga=(await pool.query(`SELECT * FROM acd_sagas
      WHERE work_item_id=$1 AND type='manual_outbound'`,[intent.work_item_id])).rows[0];

    const customerPayload={
      call_control_id:customerCallControlId,call_session_id:randomUUID(),
      direction:'outgoing',from:'+15550008888',to:target,
      custom_headers:dial.request.custom_headers,
    };
    await admitAcdVoiceEvent(pool,{eventId:randomUUID(),eventType:'call.initiated',sourceRoute:'voice',payload:customerPayload});
    await drainInboxOnce(pool,provider,{node:'manual-outbound-race-customer',limit:100});
    assert.equal((await pool.query(`SELECT data->>'customerProviderCallId' AS id
      FROM acd_sagas WHERE id=$1`,[saga.id])).rows[0].id,customerCallControlId);

    await admitAcdVoiceEvent(pool,{eventId:randomUUID(),eventType:'call.hangup',sourceRoute:'voice',payload:{
      ...agentPayload,hangup_cause:'originator_cancel',
    }});
    await drainInboxOnce(pool,provider,{node:'manual-outbound-race-agent-end',limit:100});
    assert.ok(provider.calls.some(call=>call.operation==='manual_outbound_hangup_customer'
      && call.endpoint===`/calls/${encodeURIComponent(customerCallControlId)}/actions/hangup`));

    await admitAcdVoiceEvent(pool,{eventId:randomUUID(),eventType:'call.hangup',sourceRoute:'voice',payload:{
      ...customerPayload,hangup_cause:'originator_cancel',
    }});
    await drainInboxOnce(pool,provider,{node:'manual-outbound-race-customer-end',limit:100});
    assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id=$1`,[saga.id])).rows[0].state,'succeeded');
    assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`,[intent.reservation_id])).rows[0].state,'released');
  }finally{
    if(previousCallControlId===undefined)delete process.env.TELNYX_CALL_CONTROL_ID;
    else process.env.TELNYX_CALL_CONTROL_ID=previousCallControlId;
  }
});

test('supervision reserves exclusive Core capacity and binds the incoming WebRTC device leg',async()=>{
  const a=await agent();
  const telephonyUserName=`supervisor-${randomUUID()}`;
  await pool.query('UPDATE users SET telephony_user_name=$2 WHERE id=$1',[a.id,telephonyUserName]);
  const requestId=randomUUID();
  const target=`sip:${telephonyUserName}@sip.telnyx.com`;
  const supervisedCallControlId=`v3:customer-${randomUUID()}`;
  const intent=await reserveSupervisionVoice(pool,{
    agentId:a.id,
    requestId,
    target,
    supervisedCallControlId,
    role:'monitor',
  });
  assert.equal((await reserveSupervisionVoice(pool,{
    agentId:a.id,requestId,target,supervisedCallControlId,role:'monitor',
  })).id,intent.id);
  await assert.rejects(reserveSupervisionVoice(pool,{
    agentId:a.id,requestId,target,supervisedCallControlId,role:'barge',
  }),{status:409});

  const work=(await pool.query('SELECT * FROM acd_work_items WHERE id=$1',[intent.work_item_id])).rows[0];
  assert.equal(work.queue_id,null);
  assert.equal(work.direction,'internal');
  assert.equal(work.state,'offered');
  assert.equal(work.attributes.voice_occupancy_kind,'supervision');
  assert.equal(work.attributes.supervised_call_control_id,supervisedCallControlId);
  assert.equal(work.attributes.supervisor_role,'monitor');
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:a.id})),null);

  const headers=[{name:'X-CC-Direct-Intent-Id',value:intent.id}];
  const transport=await applyDirectCapacityEvent(pool,{eventType:'call.initiated',payload:{
    call_control_id:`v3:supervision-transport-${randomUUID()}`,
    call_session_id:randomUUID(),direction:'outgoing',to:target,
    custom_headers:headers,
  }});
  assert.equal(transport.outcome,'noop','the outgoing transport must not own supervisor capacity');
  assert.equal((await pool.query('SELECT provider_call_id FROM acd_direct_intents WHERE id=$1',[intent.id])).rows[0].provider_call_id,null);

  const deviceCallControlId=`v3:supervisor-device-${randomUUID()}`;
  const callSessionId=randomUUID();
  const base={
    call_control_id:deviceCallControlId,
    call_session_id:callSessionId,
    direction:'incoming',
    to:telephonyUserName,
    custom_headers:headers,
  };
  await applyDirectCapacityEvent(pool,{eventType:'call.initiated',payload:base});
  assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[work.id])).rows[0].state,'active');
  assert.deepEqual((await pool.query(`SELECT role,agent_id,state FROM acd_legs
    WHERE provider_call_id=$1`,[deviceCallControlId])).rows[0],{
    role:'supervisor',agent_id:a.id,state:'ringing',
  });
  const mediaEvidence=await tx(async t=>{
    const reservation=(await t.query('SELECT * FROM acd_reservations WHERE id=$1',[intent.reservation_id])).rows[0];
    return agentMediaEvidence(t,reservation);
  });
  assert.equal(mediaEvidence.ended,false,'a live supervisor leg prevents premature capacity release');
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:a.id})),null);

  await applyDirectCapacityEvent(pool,{eventType:'call.answered',payload:base});
  await applyDirectCapacityEvent(pool,{eventType:'call.hangup',payload:{
    ...base,hangup_cause:'normal_clearing',
  }});
  assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[work.id])).rows[0].state,'completed');
  assert.ok((await pool.query('SELECT answered_at,ended_at FROM acd_segments WHERE work_item_id=$1',[work.id])).rows[0].answered_at);
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[intent.reservation_id])).rows[0].state,'released');
  assert.equal((await pool.query('SELECT state FROM acd_direct_intents WHERE id=$1',[intent.id])).rows[0].state,'ended');
  assert.equal((await state(a.id)).workflow_state,'idle');
});

test('definitive supervision origination rejection closes its work item and capacity',async()=>{
  const a=await agent();
  const intent=await reserveSupervisionVoice(pool,{
    agentId:a.id,
    target:`sip:${a.id}@sip.telnyx.com`,
    supervisedCallControlId:`v3:customer-${randomUUID()}`,
    role:'barge',
  });
  await rejectDirectIntent(pool,intent.id,422);
  assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[intent.work_item_id])).rows[0].state,'failed');
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[intent.reservation_id])).rows[0].state,'released');
  assert.equal((await state(a.id)).workflow_state,'idle');
});

test('an unanswered manual outbound leg is failed and never counted as answered',async()=>{
  const a=await agent();
  const intent=await reserveDirectVoice(pool,{agentId:a.id,target:'  +15550004444  '});
  assert.equal(intent.target,'+15550004444');
  const base={to:'+15550004444',call_control_id:`v3:manual-${randomUUID()}`,
    direction:'outgoing',custom_headers:[{name:'X-CC-Direct-Intent-Id',value:intent.id}]};
  await applyDirectCapacityEvent(pool,{eventType:'call.initiated',payload:base});
  await applyDirectCapacityEvent(pool,{eventType:'call.hangup',payload:{...base,hangup_cause:'user_busy'}});
  const work=(await pool.query('SELECT state,terminal_reason FROM acd_work_items WHERE id=$1',[intent.work_item_id])).rows[0];
  assert.deepEqual(work,{state:'failed',terminal_reason:'user_busy'});
  const segment=(await pool.query('SELECT answered_at,outcome FROM acd_segments WHERE work_item_id=$1',[intent.work_item_id])).rows[0];
  assert.equal(segment.answered_at,null);assert.equal(segment.outcome,'no_answer');
  assert.equal((await state(a.id)).workflow_state,'idle');
});

test('an answered webhook can establish a manual call when initiated arrives late',async()=>{
  const a=await agent();const target='+15550005555';
  const intent=await reserveDirectVoice(pool,{agentId:a.id,target});
  const base={to:target,call_control_id:`v3:manual-${randomUUID()}`,
    direction:'outgoing',custom_headers:[{name:'X-CC-Direct-Intent-Id',value:intent.id}]};
  await applyDirectCapacityEvent(pool,{eventType:'call.answered',payload:base});
  await applyDirectCapacityEvent(pool,{eventType:'call.initiated',payload:base});
  await applyDirectCapacityEvent(pool,{eventType:'call.hangup',payload:base});
  assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[intent.work_item_id])).rows[0].state,'completed');
  const legs=await pool.query('SELECT state,answered_at FROM acd_legs WHERE work_item_id=$1',[intent.work_item_id]);
  assert.equal(legs.rowCount,1);assert.ok(legs.rows[0].answered_at);assert.equal(legs.rows[0].state,'ended');
});

test('known failed browser origination releases only its owning agent intent',async()=>{
  const a=await agent(),other=await agent();
  const intent=await reserveDirectVoice(pool,{agentId:a.id,target:'+15550002222'});
  assert.equal(await cancelUnstartedDirectIntent(pool,{id:intent.id,agentId:other.id}),false);
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:a.id})),null);
  assert.equal(await cancelUnstartedDirectIntent(pool,{id:intent.id,agentId:a.id}),true);
  assert.equal((await pool.query('SELECT state FROM acd_direct_intents WHERE id=$1',[intent.id])).rows[0].state,'ended');
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[intent.reservation_id])).rows[0].state,'released');
  assert.equal((await state(a.id)).workflow_state,'idle');

  const direct=await reserveDirectVoice(pool,{agentId:a.id,target:'+15550003333'});
  assert.equal(await cancelUnstartedDirectIntent(pool,{id:direct.id,agentId:a.id}),true);
  assert.equal((await state(a.id)).workflow_state,'idle');
});

test('Core interaction control resolves ownership from durable segments',async()=>{
  const a=await agent(); const call=await activeVoice(a.id);
  const check=await authorizePersistedInteractionControl(
    pool,
    {id:call.wi.id,work_item_id:call.wi.id},
    {id:a.id,username:`${a.id}@test.local`,roles:['agent']},
  );
  assert.equal(check.ok,true);
  assert.equal(check.privileged,false);
});

test('media retries with one request id send one command; other agents are refused',async()=>{
  const a=await agent();const call=await activeVoice(a.id);const provider=makeFakeProvider();const requestId=randomUUID();
  const args={interactionId:call.wi.id,agentId:a.id,action:'speak',text:'Test message',provider,requestId};
  const first=await requestMediaIntent(pool,args);const second=await requestMediaIntent(pool,args);
  assert.equal(first.sagaId,second.sagaId);assert.equal(provider.calls.length,1);
  await assert.rejects(requestMediaIntent(pool,{...args,agentId:'another',requestId:randomUUID()}),{status:403});
});

test('operator retry refuses unknown provider outcome and the retired queue-owner action',async()=>{
  const a=await agent();const call=await activeVoice(a.id);const provider=makeFakeProvider([{outcome:'ambiguous',httpStatus:503}]);
  const media=await requestMediaIntent(pool,{interactionId:call.wi.id,agentId:a.id,action:'speak',text:'Test',provider});
  await assert.rejects(executeAcdOperation(pool,{actorId:'supervisor',requestId:randomUUID(),action:'retry_saga',targetId:media.sagaId,reason:'Investigate lost response'}),{status:409});
  await assert.rejects(executeAcdOperation(pool,{
    actorId:'admin',requestId:randomUUID(),action:'queue_owner',targetId:randomUUID(),reason:'Retired routing control',
  }),{status:400});
});

test('operator checks one exact provider call and releases only provider-ended voice capacity',async()=>{
  const a=await agent();const call=await activeVoice(a.id);const callControlId=`v3:${randomUUID()}`;
  await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,agent_id,state)
    VALUES($1,$2,'agent_device',$3,$4,'bridged')`,[randomUUID(),call.wi.id,callControlId,a.id]);

  const operations=await readAcdOperations(pool);
  const capacity=operations.voiceCapacity.find(item=>item.reservation_id===call.res);
  assert.ok(capacity);assert.equal(capacity.provider_call_id,callControlId);
  assert.equal(capacity.agent_id,a.id);assert.equal(capacity.reservation_state,'active');

  const activeProvider={calls:[],async send(command){
    this.calls.push(command);
    return {outcome:'accepted',httpStatus:200,response:{data:{
      ended:false,conclusive:true,callControlId,isAlive:true,checkedAt:new Date().toISOString(),
    }}};
  }};
  const retained=await executeAcdOperation(pool,{actorId:'fixture-supervisor',requestId:randomUUID(),
    action:'recover_voice_capacity',targetId:call.res,reason:'Agent reports unexpected Busy',provider:activeProvider});
  assert.equal(retained.recovered,false);assert.equal(retained.state,'retained');
  assert.equal(retained.evidence,'provider_call_active');assert.equal(activeProvider.calls.length,1);
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[call.res])).rows[0].state,'active');

  const endedProvider={calls:[],async send(command){
    this.calls.push(command);
    return {outcome:'accepted',httpStatus:200,response:{data:{
      ended:true,conclusive:true,callControlId,isAlive:false,checkedAt:new Date().toISOString(),
    }}};
  }};
  const requestId=randomUUID();
  const args={actorId:'fixture-supervisor',requestId,action:'recover_voice_capacity',targetId:call.res,
    reason:'Provider confirms stale device leg',provider:endedProvider};
  const recovered=await executeAcdOperation(pool,args);
  assert.equal(recovered.recovered,true);assert.equal(recovered.state,'released');
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[call.res])).rows[0].state,'released');
  assert.equal((await pool.query('SELECT state FROM acd_legs WHERE provider_call_id=$1',[callControlId])).rows[0].state,'ended');
  assert.equal((await state(a.id)).workflow_state,'idle');
  assert.deepEqual(await executeAcdOperation(pool,args),recovered,'the operator request is idempotent');
  assert.equal(endedProvider.calls.length,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM acd_operator_actions WHERE request_id=$1',[requestId])).rows[0].n,1);
});

test('operator recovery preserves a direct reservation before its exact provider call is known',async()=>{
  const a=await agent();const intent=await reserveDirectVoice(pool,{agentId:a.id,target:'+15550002222'});
  const provider={calls:[],async send(command){this.calls.push(command);throw new Error('must not probe without an exact call');}};
  const result=await executeAcdOperation(pool,{actorId:'fixture-supervisor',requestId:randomUUID(),
    action:'recover_voice_capacity',targetId:intent.reservation_id,
    reason:'Check a pending manual outbound request',provider});
  assert.equal(result.recovered,false);assert.equal(result.state,'retained');
  assert.equal(result.evidence,'provider_call_unknown');assert.equal(result.providerChecked,false);
  assert.equal(provider.calls.length,0);
  assert.notEqual((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[intent.reservation_id])).rows[0].state,'released');
});

test('authorized snapshot excludes another agent and marks a released assignment for removal',async()=>{
  const a=await agent(),b=await agent();const call=await activeVoice(a.id);
  assert.equal((await readAgentSnapshot(pool,b.id)).interactions.length,0);
  assert.equal((await readAgentSnapshot(pool,a.id)).interactions[0].owns_live_assignment,true);
  await tx(t=>releaseReservation(t,call.res,'fixture_end'));
  assert.equal((await readAgentSnapshot(pool,a.id)).interactions[0].owns_live_assignment,false);
});

test('unconfirmed direct origination produces one alarm and retains capacity',async()=>{
  const {alarmUnconfirmedDirectIntents}=await import('../lib/acd/direct-capacity.mjs');
  const a=await agent();const intent=await reserveDirectVoice(pool,{agentId:a.id,target:'+15550002222'});
  await pool.query(`UPDATE acd_direct_intents SET created_at=now()-interval '2 minutes' WHERE id=$1`,[intent.id]);
  await alarmUnconfirmedDirectIntents(pool);await alarmUnconfirmedDirectIntents(pool);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_events WHERE payload->>'intent_id'=$1 AND type='manual_intervention_required'`,[intent.id])).rows[0].n,1);
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:a.id})),null);
});

test('an unstarted direct intent is released only on provider-confirmed absence',async()=>{
  const {sweepAbandonedDirectIntents}=await import('../lib/acd/direct-capacity.mjs');
  const a=await agent();
  await pool.query(`UPDATE users SET telephony_credentials_id='cred-fixture' WHERE id=$1`,[a.id]);
  const intent=await reserveDirectVoice(pool,{agentId:a.id,target:'+15550002222'});
  await pool.query(`UPDATE acd_direct_intents SET created_at=now()-interval '2 minutes' WHERE id=$1`,[intent.id]);

  const probes=[];
  const probe=result=>({send:async command=>{probes.push(command.operation);return result;}});
  const idle={outcome:'accepted',httpStatus:200,response:{data:{ended:true,credentialId:'cred-fixture',connectionId:'123',activeCalls:0}}};
  const busy={outcome:'accepted',httpStatus:200,response:{data:{ended:false}}};

  // A live browser session is not even a candidate: no provider read happens.
  assert.equal(await sweepAbandonedDirectIntents(pool,{provider:probe(idle)}),0);
  assert.equal(probes.length,0);

  await pool.query(`UPDATE acd_agent_sessions SET expires_at=now()-interval '1 second' WHERE agent_id=$1`,[a.id]);
  await expireAgentSessions(pool);

  // The session is gone, but the provider still reports a call on the agent's
  // credential: capacity must be retained.
  assert.equal(await sweepAbandonedDirectIntents(pool,{provider:probe(busy)}),0,'an active inventory withholds the release');
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[intent.reservation_id])).rows[0].state,'active');

  // An unreadable inventory is not a confirmation either.
  const failing={send:async()=>{throw new Error('provider unavailable');}};
  assert.equal(await sweepAbandonedDirectIntents(pool,{provider:failing}),0);
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[intent.reservation_id])).rows[0].state,'active');

  // Only a complete, empty inventory releases it.
  assert.equal(await sweepAbandonedDirectIntents(pool,{provider:probe(idle)}),1);
  assert.equal((await pool.query('SELECT state FROM acd_direct_intents WHERE id=$1',[intent.id])).rows[0].state,'revoked');
  assert.equal((await pool.query('SELECT state,released_reason FROM acd_reservations WHERE id=$1',[intent.reservation_id])).rows[0].released_reason,'direct_origination_absence_verified');
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_events
    WHERE type='agent_media_absence_verified' AND payload->>'intent_id'=$1`,[intent.id])).rows[0].n,1);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_reservations
    WHERE agent_id=$1 AND state<>'released'`,[a.id])).rows[0].n,0);
});

test('a call started after a verified absence is rejected, never left unreserved',async()=>{
  const {sweepAbandonedDirectIntents,applyDirectCapacityEventWithRejection}=await import('../lib/acd/direct-capacity.mjs');
  const a=await agent();
  await pool.query(`UPDATE users SET telephony_credentials_id='cred-fixture' WHERE id=$1`,[a.id]);
  const intent=await reserveDirectVoice(pool,{agentId:a.id,target:'+15550002222'});
  await pool.query(`UPDATE acd_direct_intents SET created_at=now()-interval '2 minutes' WHERE id=$1`,[intent.id]);
  await pool.query(`UPDATE acd_agent_sessions SET expires_at=now()-interval '1 second' WHERE agent_id=$1`,[a.id]);
  await expireAgentSessions(pool);

  const idle={outcome:'accepted',httpStatus:200,response:{data:{ended:true,credentialId:'cred-fixture',connectionId:'123',activeCalls:0}}};
  assert.equal(await sweepAbandonedDirectIntents(pool,{provider:{send:async()=>idle}}),1);
  assert.equal((await pool.query('SELECT state FROM acd_direct_intents WHERE id=$1',[intent.id])).rows[0].state,'revoked',
    'the intent stays recognisable so a late call is not mistaken for an unknown one');

  // The frozen tab wakes up and places the call anyway.
  const provider=makeFakeProvider();
  const callId=`direct:${randomUUID()}`;
  const result=await applyDirectCapacityEventWithRejection(pool,{eventType:'call.initiated',payload:{
    call_control_id:callId,to:'+15550002222',from:'+15550009999',
    custom_headers:[{name:'X-CC-Direct-Intent-Id',value:intent.id}]}},{provider});

  assert.equal(result.rejectLeg,true,'a revoked intent cannot quietly host a live call');
  assert.ok(provider.calls.some(call=>/\/actions\/hangup$/.test(call.endpoint)),'the unauthorized leg is torn down');
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_events
    WHERE type='direct_call_revoked_origination' AND payload->>'intent_id'=$1`,[intent.id])).rows[0].n,1);

  // A hangup command is a request, not an ending: while the leg may still be
  // up the agent must not be offered anything, even once their browser is back.
  await heartbeatAgentSession(pool,{agentId:a.id,sessionId:randomUUID(),voiceReady:true});
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:a.id})),null,'capacity is retained until the leg is confirmed gone');

  const cleanup=(await pool.query(`SELECT s.id FROM acd_sagas s JOIN acd_work_items w ON w.id=s.work_item_id
    WHERE w.attributes->>'direct_rejected'='true' AND s.type='media_cleanup' ORDER BY s.created_at DESC LIMIT 1`)).rows[0];
  assert.ok(cleanup,'the rejection opened a media cleanup saga');

  await applyDirectCapacityEventWithRejection(pool,{eventType:'call.hangup',payload:{
    call_control_id:callId,to:'+15550002222',hangup_cause:'normal_clearing',
    custom_headers:[{name:'X-CC-Direct-Intent-Id',value:intent.id}]}},{provider});
  assert.equal((await pool.query('SELECT state FROM acd_direct_intents WHERE id=$1',[intent.id])).rows[0].state,'ended');
  // The synthetic leg recorded by the rejection must be closed too, or its
  // cleanup saga waits on a leg that is already gone and alarms.
  const leg=(await pool.query('SELECT state,ended_at FROM acd_legs WHERE provider_call_id=$1',[callId])).rows[0];
  assert.equal(leg.state,'ended');
  assert.ok(leg.ended_at);
  assert.notEqual((await pool.query('SELECT state FROM acd_sagas WHERE id=$1',[cleanup.id])).rows[0].state,'running',
    'the cleanup saga settles instead of timing out into manual intervention');
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_events
    WHERE type='manual_intervention_required' AND payload->>'reason'='terminal_media_end_unconfirmed'`)).rows[0].n,0);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_reservations
    WHERE agent_id=$1 AND state<>'released'`,[a.id])).rows[0].n,0);
  assert.ok(await tx(t=>tryReserveCapacity(t,{agentId:a.id})),'confirmed end frees the agent');
});

test('a bound direct call is never swept, even with no session',async()=>{
  const {sweepAbandonedDirectIntents}=await import('../lib/acd/direct-capacity.mjs');
  const a=await agent();
  await pool.query(`UPDATE users SET telephony_credentials_id='cred-fixture' WHERE id=$1`,[a.id]);
  const intent=await reserveDirectVoice(pool,{agentId:a.id,target:'+15550002222'});
  const callId=`direct:${randomUUID()}`;
  await applyDirectCapacityEvent(pool,{eventType:'call.initiated',payload:{call_control_id:callId,to:'+15550002222',
    custom_headers:[{name:'X-CC-Direct-Intent-Id',value:intent.id}]}});
  await pool.query(`UPDATE acd_direct_intents SET created_at=now()-interval '2 minutes' WHERE id=$1`,[intent.id]);
  await pool.query(`UPDATE acd_agent_sessions SET expires_at=now()-interval '1 second' WHERE agent_id=$1`,[a.id]);
  await expireAgentSessions(pool);
  const provider={send:async()=>({outcome:'accepted',httpStatus:200,response:{data:{ended:true}}})};
  assert.equal(await sweepAbandonedDirectIntents(pool,{provider}),0,'a bound call is not a candidate at all');
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:a.id})),null);
});

test('late direct initiation after actual hangup cannot recreate capacity',async()=>{
  const a=await agent();const intent=await reserveDirectVoice(pool,{agentId:a.id,target:'+15550002222'});
  const payload={call_control_id:`direct:${randomUUID()}`,to:'+15550002222',custom_headers:[{name:'X-CC-Direct-Intent-Id',value:intent.id}]};
  await applyDirectCapacityEvent(pool,{eventType:'call.hangup',payload});
  assert.equal((await applyDirectCapacityEvent(pool,{eventType:'call.initiated',payload})).skipAdapterEffects,true);
  assert.equal((await state(a.id)).workflow_state,'idle');
});

test('rejection of an unsolicited call is journaled and cannot affect the active assignment',async()=>{
  const {rejectUnreservedDirectCall}=await import('../lib/acd/direct-capacity.mjs');
  const a=await agent();const active=await activeVoice(a.id);const provider=makeFakeProvider();
  const payload={call_control_id:`unsolicited:${randomUUID()}`,to:`sip:${a.id}@sip.telnyx.com`,from:'+15550002222'};
  await rejectUnreservedDirectCall(pool,payload,provider);await rejectUnreservedDirectCall(pool,payload,provider);
  assert.equal(provider.calls.length,1);
  assert.ok(provider.calls[0].endpoint.includes(encodeURIComponent(payload.call_control_id)));
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`,[active.res])).rows[0].state,'active');
});

test('self-initiated dialing while Away preserves queue and occupancy guards', async () => {
  const a = await agent();
  await pool.query("UPDATE acd_agent_state SET manual_status='Away', routability='not_routable' WHERE agent_id=$1", [a.id]);
  assert.equal(await tx(t => tryReserveCapacity(t, { agentId:a.id })), null);
  const intent = await reserveDirectVoice(pool, { agentId:a.id, target:'+15550002222' });
  assert.ok(intent.id);
  await assert.rejects(reserveDirectVoice(pool, { agentId:a.id, target:'+15550003333' }), /voice or video call is already in progress or the phone is not ready/);
  assert.equal((await state(a.id)).manual_status, 'Away');
  assert.equal((await state(a.id)).routability, 'not_routable');
});

test('manual dialing still requires online voice capability', async () => {
  for (const restriction of ['offline', 'no_voice']) {
    const a = await agent();
    await pool.query("UPDATE acd_agent_state SET manual_status='Away', routability='not_routable' WHERE agent_id=$1", [a.id]);
    if (restriction === 'offline') await pool.query("UPDATE acd_agent_state SET presence='offline' WHERE agent_id=$1", [a.id]);
    if (restriction === 'no_voice') await pool.query("UPDATE acd_agent_sessions SET capabilities='{}' WHERE agent_id=$1", [a.id]);
    await assert.rejects(reserveDirectVoice(pool, { agentId:a.id, target:'+15550002222' }), /voice or video call is already in progress or the phone is not ready/);
  }
});

test('unsolicited SIP direct call is durably admitted, occupies the agent, and releases on hangup', async () => {
  const previousConnection = process.env.TELNYX_SIP_CONNECTION_ID;
  process.env.TELNYX_SIP_CONNECTION_ID = 'shared-agent-connection';
  try {
    const a = await agent();
    const callControlId = `v3:direct-${randomUUID()}`;
    const base = {
      call_control_id: callControlId,
      call_session_id: randomUUID(),
      connection_id: 'shared-agent-connection',
      direction: 'incoming',
      from: '+15550001111',
      to: `sip:${a.id}@sip.telnyx.com`,
    };
    const initiated = { eventId:randomUUID(), eventType:'call.initiated', sourceRoute:'voice', payload:base };
    const admission = await admitAcdVoiceEvent(pool, initiated);
    assert.equal(admission.durable, true);
    assert.equal(admission.classification.eventClass, 'direct_agent_leg');
    await drainInboxOnce(pool, makeFakeProvider(), { node:'direct-test', limit:100 });

    const work = (await pool.query(`SELECT * FROM acd_work_items
      WHERE attributes->>'voice_occupancy_kind'='direct_inbound'
        AND attributes->>'direct_agent_id'=$1
      ORDER BY created_at DESC LIMIT 1`,[a.id])).rows[0];
    assert.ok(work);assert.equal(work.queue_id,null);assert.equal(work.state,'offered');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_reservations
      WHERE work_item_id=$1 AND agent_id=$2 AND state<>'released'`,[work.id,a.id])).rows[0].n,1);
    assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:a.id})),null);
    assert.equal((await pool.query('SELECT agent_username,state FROM acd_history_interactions WHERE work_item_id=$1',[work.id])).rows[0].agent_username,`${a.id}@test.local`);

    for (const eventType of ['call.answered','call.hangup']) {
      const event = { eventId:randomUUID(), eventType, sourceRoute:'voice', payload:{
        ...base,
        ...(eventType === 'call.hangup' ? { hangup_cause:'normal_clearing' } : {}),
      } };
      assert.equal((await admitAcdVoiceEvent(pool,event)).durable,true);
      await drainInboxOnce(pool,makeFakeProvider(),{node:'direct-test',limit:100});
    }
    assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[work.id])).rows[0].state,'completed');
    assert.equal((await pool.query('SELECT state FROM acd_legs WHERE provider_call_id=$1',[callControlId])).rows[0].state,'ended');
    assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE work_item_id=$1',[work.id])).rows[0].state,'released');
    assert.equal((await state(a.id)).workflow_state,'idle');
    assert.equal((await pool.query('SELECT metadata FROM acd_history_interactions WHERE work_item_id=$1',[work.id])).rows[0].metadata.wrapup_started_at,undefined);
  } finally {
    if (previousConnection === undefined) delete process.env.TELNYX_SIP_CONNECTION_ID;
    else process.env.TELNYX_SIP_CONNECTION_ID = previousConnection;
  }
});

test('an E.164 direct destination is admitted from the configured user number', async () => {
  const previousConnection = process.env.TELNYX_SIP_CONNECTION_ID;
  process.env.TELNYX_SIP_CONNECTION_ID = 'shared-agent-connection';
  try {
    const a = await agent();
    const directNumber = `+1555${String(Date.now()).slice(-7)}`;
    await pool.query('UPDATE users SET voice_number=$2 WHERE id=$1',[a.id,directNumber]);
    const payload={call_control_id:`v3:e164-${randomUUID()}`,call_session_id:randomUUID(),
      connection_id:'shared-agent-connection',direction:'incoming',from:'+15550001111',to:directNumber};
    const provider=makeFakeProvider();
    const admission=await admitAcdVoiceEvent(pool,{eventId:randomUUID(),eventType:'call.initiated',sourceRoute:'voice',payload});
    assert.equal(admission.durable,true);assert.equal(admission.classification.eventClass,'direct_agent_leg');
    await drainInboxOnce(pool,provider,{node:'direct-e164-test',limit:100});
    const work=(await pool.query(`SELECT id,state,queue_id,attributes FROM acd_work_items
      WHERE attributes->>'voice_occupancy_kind'='direct_inbound'
        AND attributes->>'direct_agent_id'=$1 ORDER BY created_at DESC LIMIT 1`,[a.id])).rows[0];
    assert.ok(work);assert.equal(work.state,'offered');assert.equal(work.queue_id,null);
    assert.equal(work.attributes.transfer_capable,true);
    assert.equal(work.attributes.suppress_wrapup,true);
    assert.deepEqual((await pool.query(`SELECT role,state,provider_call_id FROM acd_legs
      WHERE work_item_id=$1 ORDER BY created_at`,[work.id])).rows,[{
      role:'customer',state:'parked',provider_call_id:payload.call_control_id,
    }]);
    const connect=(await pool.query(`SELECT state,step,data FROM acd_sagas
      WHERE work_item_id=$1 AND type='connect'`,[work.id])).rows[0];
    assert.equal(connect.state,'running');assert.equal(connect.step,'dial_agent');
    assert.equal(connect.data.customerProviderCallId,payload.call_control_id);
    assert.equal(connect.data.agentId,a.id);
    assert.ok(provider.calls.some(call=>call.operation==='transfer_to_agent'
      && call.endpoint.includes(encodeURIComponent(payload.call_control_id))));
  } finally {
    if (previousConnection === undefined) delete process.env.TELNYX_SIP_CONNECTION_ID;
    else process.env.TELNYX_SIP_CONNECTION_ID = previousConnection;
  }
});

test('unsolicited direct leg is explicitly rejected when the resolved agent is occupied', async () => {
  const previousConnection = process.env.TELNYX_SIP_CONNECTION_ID;
  process.env.TELNYX_SIP_CONNECTION_ID = 'shared-agent-connection';
  try {
    const a = await agent();
    const active = await activeVoice(a.id);
    const provider = makeFakeProvider();
    const callControlId = `v3:direct-busy-${randomUUID()}`;
    const payload = {
      call_control_id:callControlId,
      call_session_id:randomUUID(),
      connection_id:'shared-agent-connection',
      direction:'incoming',
      from:'+15550003333',
      to:`sip:${a.id}@sip.telnyx.com`,
    };
    assert.equal((await admitAcdVoiceEvent(pool,{eventId:randomUUID(),eventType:'call.initiated',sourceRoute:'voice',payload})).durable,true);
    await drainInboxOnce(pool,provider,{node:'direct-busy-test',limit:100});
    assert.ok(provider.calls.some(call=>/\/actions\/hangup$/.test(call.endpoint)));
    const rejected = (await pool.query(`SELECT * FROM acd_work_items
      WHERE attributes->>'direct_rejected'='true'
        AND attributes->>'direct_agent_id'=$1
      ORDER BY created_at DESC LIMIT 1`,[a.id])).rows[0];
    assert.ok(rejected);assert.equal(rejected.state,'failed');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_reservations
      WHERE agent_id=$1 AND state<>'released'`,[a.id])).rows[0].n,1);
    assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[active.res])).rows[0].state,'active');

    const hangup={eventId:randomUUID(),eventType:'call.hangup',sourceRoute:'voice',payload:{...payload,hangup_cause:'user_busy'}};
    assert.equal((await admitAcdVoiceEvent(pool,hangup)).durable,true);
    await drainInboxOnce(pool,provider,{node:'direct-busy-test',limit:100});
    assert.equal((await pool.query('SELECT state FROM acd_legs WHERE provider_call_id=$1',[callControlId])).rows[0].state,'ended');
  } finally {
    if (previousConnection === undefined) delete process.env.TELNYX_SIP_CONNECTION_ID;
    else process.env.TELNYX_SIP_CONNECTION_ID = previousConnection;
  }
});

test('a Core-routed device leg is never reclassified as an unsolicited direct call', async () => {
  const previousConnection = process.env.TELNYX_SIP_CONNECTION_ID;
  process.env.TELNYX_SIP_CONNECTION_ID = 'shared-agent-connection';
  try {
    const { applyDirectCapacityEventWithRejection } = await import('../lib/acd/direct-capacity.mjs');
    const a=await agent();const workItemId=randomUUID();
    const result=await applyDirectCapacityEventWithRejection(pool,{eventType:'call.initiated',payload:{
      call_control_id:`v3:routed-${randomUUID()}`,
      direction:'incoming',connection_id:'shared-agent-connection',
      from:'+15550004444',to:`sip:${a.id}@sip.telnyx.com`,
      custom_headers:[
        {name:'X-CC-Work-Item-Id',value:workItemId},
        {name:'X-CC-Leg-Role',value:'agent_device'},
      ],
    }},{provider:makeFakeProvider()});
    assert.equal(result,null);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_work_items
      WHERE attributes->>'direct_agent_id'=$1`,[a.id])).rows[0].n,0);
  } finally {
    if (previousConnection === undefined) delete process.env.TELNYX_SIP_CONNECTION_ID;
    else process.env.TELNYX_SIP_CONNECTION_ID = previousConnection;
  }
});

test('a manual outbound intent ends with its own leg while the saga still owns the reservation',async()=>{
  const previousCallControlId=process.env.TELNYX_CALL_CONTROL_ID;
  const previousMainFrom=process.env.TELNYX_MAIN_FROM_NUMBER;
  process.env.TELNYX_CALL_CONTROL_ID='call-control-app-test';
  process.env.TELNYX_MAIN_FROM_NUMBER='+15550009999';
  try{
    const a=await agent();
    await pool.query(`UPDATE users SET voice_number='+15550008888' WHERE id=$1`,[a.id]);
    const target='+15550005555';
    const intent=await reserveDirectVoice(pool,{agentId:a.id,target});
    const agentCallControlId=`v3:manual-agent-${randomUUID()}`;
    const customerCallControlId=`v3:manual-customer-${randomUUID()}`;
    const callSessionId=randomUUID();
    const provider=makeFakeProvider([{
      outcome:'accepted',httpStatus:200,
      response:{data:{call_control_id:customerCallControlId,call_session_id:callSessionId}},
    }]);
    const agentPayload={
      call_control_id:agentCallControlId,call_session_id:callSessionId,
      connection_id:'agent-credential-connection',direction:'outgoing',
      from:'+15550007777',to:target,custom_headers:[{name:'X-CC-Direct-Intent-Id',value:intent.id}],
    };
    assert.equal((await admitAcdVoiceEvent(pool,{eventId:randomUUID(),eventType:'call.initiated',sourceRoute:'voice',payload:agentPayload})).durable,true);
    await drainInboxOnce(pool,provider,{node:'intent-end-dial',limit:100});
    const saga=(await pool.query(`SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='manual_outbound'`,[intent.work_item_id])).rows[0];
    assert.ok(saga);
    const customerHeaders=provider.calls[0].request.custom_headers;
    const customerPayload={call_control_id:customerCallControlId,call_session_id:callSessionId,
      direction:'outgoing',from:'+15550007777',to:target,custom_headers:customerHeaders};
    for(const [eventType,extra] of [['call.initiated',{}],['call.answered',{}],['call.bridged',{bridged_call_control_id:agentCallControlId}]]){
      assert.equal((await admitAcdVoiceEvent(pool,{eventId:randomUUID(),eventType,sourceRoute:'voice',payload:{...customerPayload,...extra}})).durable,true);
      await drainInboxOnce(pool,provider,{node:'intent-end-customer',limit:100});
    }
    assert.equal((await pool.query(`SELECT step FROM acd_sagas WHERE id=$1`,[saga.id])).rows[0].step,'handling');
    const open=(await pool.query(`SELECT state,ended_at FROM acd_direct_intents WHERE id=$1`,[intent.id])).rows[0];
    assert.equal(open.state,'active');assert.equal(open.ended_at,null);

    // The agent hangs up first: the customer PSTN leg is still live, so the
    // saga keeps the reservation until it has cleaned that leg. The intent's
    // own leg is gone, and that fact must be recorded now, not at finalize.
    const agentHangupEvent={eventId:randomUUID(),eventType:'call.hangup',sourceRoute:'voice',
      payload:{...agentPayload,hangup_cause:'normal_clearing'}};
    // Simulate a worker crash after direct-capacity committed the leg end but
    // before its wrapper delivered leg.ended to the manual-outbound saga.
    const interrupted=await applyDirectCapacityEvent(pool,agentHangupEvent,{provider});
    assert.equal(interrupted.manualSagaId,saga.id);
    const ended=(await pool.query(`SELECT state,ended_at FROM acd_direct_intents WHERE id=$1`,[intent.id])).rows[0];
    assert.equal(ended.state,'ended');assert.ok(ended.ended_at);
    assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`,[intent.reservation_id])).rows[0].state,'active');

    const {applyDirectCapacityEventWithRejection}=await import('../lib/acd/direct-capacity.mjs');
    const retried=await applyDirectCapacityEventWithRejection(pool,agentHangupEvent,{provider});
    assert.equal(retried.manualSagaId,saga.id,'retry reconstructs the manual saga correlation');
    assert.ok(provider.calls.some(call=>call.operation==='manual_outbound_hangup_customer'
      && call.endpoint===`/calls/${encodeURIComponent(customerCallControlId)}/actions/hangup`));
    assert.notEqual((await pool.query(`SELECT state FROM acd_sagas WHERE id=$1`,[saga.id])).rows[0].state,'succeeded');

    assert.equal((await admitAcdVoiceEvent(pool,{eventId:randomUUID(),eventType:'call.hangup',sourceRoute:'voice',
      payload:{...customerPayload,hangup_cause:'normal_clearing'}})).durable,true);
    await drainInboxOnce(pool,provider,{node:'intent-end-settle',limit:100});
    assert.equal((await pool.query(`SELECT state FROM acd_sagas WHERE id=$1`,[saga.id])).rows[0].state,'succeeded');
    assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE id=$1`,[intent.reservation_id])).rows[0].state,'released');
    const settled=(await pool.query(`SELECT state,ended_at FROM acd_direct_intents WHERE id=$1`,[intent.id])).rows[0];
    assert.equal(settled.state,'ended');
    assert.equal(new Date(settled.ended_at).getTime(),new Date(ended.ended_at).getTime(),'finalize must not rewrite the leg-confirmed end');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_events
      WHERE work_item_id=$1 AND type='manual_intervention_required'`,[intent.work_item_id])).rows[0].n,0);
  }finally{
    if(previousCallControlId===undefined)delete process.env.TELNYX_CALL_CONTROL_ID;
    else process.env.TELNYX_CALL_CONTROL_ID=previousCallControlId;
    if(previousMainFrom===undefined)delete process.env.TELNYX_MAIN_FROM_NUMBER;
    else process.env.TELNYX_MAIN_FROM_NUMBER=previousMainFrom;
  }
});

test('the reconciler settles a direct intent from leg evidence when no handler closed it',async()=>{
  const a=await agent();
  const stale=await reserveDirectVoice(pool,{agentId:a.id,target:'+15550006666'});
  const staleCallId=`v3:settled-${randomUUID()}`;
  const legEndedAt=new Date(Date.now()-60_000);
  await pool.query(`UPDATE acd_direct_intents SET provider_call_id=$2,state='active' WHERE id=$1`,[stale.id,staleCallId]);
  await pool.query(`INSERT INTO acd_legs (id,work_item_id,role,agent_id,provider_call_id,state,answered_at,ended_at,ended_reason)
    VALUES ($1,$2,'agent_device',$3,$4,'ended',$5,$5,'normal_clearing')`,[randomUUID(),stale.work_item_id,a.id,staleCallId,legEndedAt]);

  const b=await agent();
  const live=await reserveDirectVoice(pool,{agentId:b.id,target:'+15550006667'});
  const liveCallId=`v3:live-${randomUUID()}`;
  await pool.query(`UPDATE acd_direct_intents SET provider_call_id=$2,state='active' WHERE id=$1`,[live.id,liveCallId]);
  await pool.query(`INSERT INTO acd_legs (id,work_item_id,role,agent_id,provider_call_id,state,answered_at)
    VALUES ($1,$2,'agent_device',$3,$4,'answered',now())`,[randomUUID(),live.work_item_id,b.id,liveCallId]);

  assert.equal(await settleEndedDirectIntents(pool),1);
  const settled=(await pool.query(`SELECT state,ended_at FROM acd_direct_intents WHERE id=$1`,[stale.id])).rows[0];
  assert.equal(settled.state,'ended');
  assert.equal(new Date(settled.ended_at).getTime(),legEndedAt.getTime(),'the leg end is the evidence, not the sweep time');
  const correction=(await pool.query(`SELECT payload FROM acd_events WHERE work_item_id=$1 AND type='reconciler_corrected'`,[stale.work_item_id])).rows;
  assert.equal(correction.length,1);
  assert.equal(correction[0].payload.kind,'direct_intent_leg_ended');
  assert.equal(correction[0].payload.intent_id,stale.id);
  const untouched=(await pool.query(`SELECT state,ended_at FROM acd_direct_intents WHERE id=$1`,[live.id])).rows[0];
  assert.equal(untouched.state,'active');assert.equal(untouched.ended_at,null);
  assert.equal(await settleEndedDirectIntents(pool),0,'settling is idempotent');
  // A settled intent no longer trips the evidence-missing alarm.
  await pool.query(`UPDATE acd_direct_intents SET created_at=now()-interval '9 hours' WHERE id=$1`,[stale.id]);
  const alarmedBefore=(await pool.query(`SELECT COUNT(*)::int AS n FROM acd_events WHERE agent_id=$1 AND type='manual_intervention_required'`,[a.id])).rows[0].n;
  await alarmUnconfirmedDirectIntents(pool);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_events WHERE agent_id=$1 AND type='manual_intervention_required'`,[a.id])).rows[0].n,alarmedBefore);
});

async function messagingOccupancy(agentId) {
  return tx(async t => {
    const work = await createWorkItem(t, { channel: 'whatsapp', direction: 'inbound' });
    const reservationId = randomUUID();
    await t.query(`INSERT INTO acd_reservations (id,agent_id,work_item_id,channel,weight,state,purpose)
      VALUES ($1,$2,$3,'whatsapp',1,'active','queue')`, [reservationId, agentId, work.id]);
    await setWorkflowState(t, agentId, 'handling', { workItemId: work.id });
    return { work, reservationId };
  });
}

test('manual outbound and every supervision role bypass messaging budget while retaining voice occupancy', async () => {
  for (const role of [null, 'monitor', 'whisper', 'barge']) {
    const a = await agent();
    const messaging = await messagingOccupancy(a.id);
    await pool.query('INSERT INTO cc_agent_utilization(agent_id,budget) VALUES($1,0.1)', [a.id]);
    await pool.query(`INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight)
      VALUES($1,'voice',false,1,1)`, [a.id]);
    assert.equal(await tx(t => tryReserveCapacity(t, { agentId: a.id })), null, 'queue admission stays blocked');
    const intent = role
      ? await reserveSupervisionVoice(pool, { agentId: a.id, target: 'sip:test@sip.telnyx.com', supervisedCallControlId: 'v3:test', role })
      : await reserveDirectVoice(pool, { agentId: a.id, target: '+15550002222' });
    assert.ok(intent.reservation_id);
    assert.equal((await state(a.id)).workflow_state, 'handling');
    await assert.rejects(reserveDirectVoice(pool, { agentId: a.id, target: '+15550003333' }), { status: 409 });
    await assert.rejects(reserveSupervisionVoice(pool, { agentId: a.id, target: 'sip:other@sip.telnyx.com', supervisedCallControlId: 'v3:other', role: 'monitor' }), { status: 409 });
    assert.equal(await tx(t => tryReserveCapacity(t, { agentId: a.id })), null);
    const payload = { to: intent.target, call_control_id: `v3:manual-${randomUUID()}`,
      direction: role ? 'incoming' : 'outgoing', custom_headers: [{ name: 'X-CC-Direct-Intent-Id', value: intent.id }] };
    await applyDirectCapacityEvent(pool, { eventType: 'call.initiated', payload });
    await applyDirectCapacityEvent(pool, { eventType: 'call.hangup', payload });
    assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1', [messaging.reservationId])).rows[0].state, 'active');
    assert.equal((await state(a.id)).workflow_state, 'handling', 'messaging still owns Busy after voice ends');
    assert.equal((await state(a.id)).workflow_work_item_id, messaging.work.id);
  }
});

test('manual and supervisory attempts serialize under messaging load', async () => {
  const a = await agent();
  await messagingOccupancy(a.id);
  const results = await Promise.allSettled([
    reserveDirectVoice(pool, { agentId: a.id, target: '+15550002222' }),
    reserveSupervisionVoice(pool, { agentId: a.id, target: 'sip:test@sip.telnyx.com', supervisedCallControlId: 'v3:test', role: 'monitor' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_reservations
    WHERE agent_id=$1 AND channel='voice' AND state<>'released'`, [a.id])).rows[0].n, 1);
});

test('manual voice excludes an outstanding queue offer and unreserved live media', async () => {
  const a = await agent();
  assert.ok(await tx(t => tryReserveCapacity(t, { agentId: a.id })));
  await assert.rejects(reserveDirectVoice(pool, { agentId: a.id, target: '+15550002222' }), { status: 409 });
  const b = await agent();
  const work = await tx(t => createWorkItem(t, { channel: 'voice', direction: 'inbound' }));
  await pool.query(`INSERT INTO acd_legs(id,work_item_id,agent_id,role,provider_call_id,state)
    VALUES($1,$2,$3,'agent_device',$4,'answered')`, [randomUUID(), work.id, b.id, `v3:orphan-${randomUUID()}`]);
  await assert.rejects(reserveDirectVoice(pool, { agentId: b.id, target: '+15550002222' }), { status: 409 });
});

test('completed voice wrapup does not block manual voice but still blocks queue admission', async () => {
  const a = await agent();
  await pool.query("UPDATE acd_agent_state SET workflow_state='wrapup',routability='not_routable' WHERE agent_id=$1", [a.id]);
  assert.equal(await tx(t => tryReserveCapacity(t, { agentId: a.id })), null);
  assert.ok((await reserveDirectVoice(pool, { agentId: a.id, target: '+15550002222' })).id);
});


test('manual voice and supervision cannot overlap an offered or active video session', async () => {
  for (const reservationState of ['reserved', 'active']) {
    const a = await agent();
    const work = await tx(t => createWorkItem(t, { channel: 'video', direction: 'inbound' }));
    await pool.query(`INSERT INTO acd_reservations (id,agent_id,work_item_id,channel,weight,state,purpose,lease_expires_at)
      VALUES ($1,$2,$3,'video',1,$4,'queue',now()+interval '1 minute')`, [randomUUID(), a.id, work.id, reservationState]);
    await assert.rejects(reserveDirectVoice(pool, { agentId: a.id, target: '+15550002222' }), { status: 409 });
    await assert.rejects(reserveSupervisionVoice(pool, { agentId: a.id, target: 'sip:test@sip.telnyx.com', supervisedCallControlId: 'v3:test', role: 'monitor' }), { status: 409 });
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM acd_reservations WHERE agent_id=$1 AND channel='voice'", [a.id])).rows[0].n, 0);
  }
});
