import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, makeTxRunner, seedAgent, seedQueue, makeFakeProvider } from './helpers/acd-test-db.mjs';
import { ensureOutboundTestSchema } from './helpers/acd-outbound-db.mjs';
import { startOutboundConnect } from '../lib/acd/sagas/outbound-connect.mjs';
import { driveSaga, sweepDueSagas, clearSagaDeadlineWakeups } from '../lib/acd/saga-engine.mjs';
import { applyOutboundVoiceEvent } from '../lib/acd/outbound-intake.mjs';
import { claimAutonomousOutbound, claimNextAutonomousOutbound, requestOutboundDial } from '../lib/acd/outbound-runtime.mjs';
import { tryReserveCapacity } from '../lib/acd/capacity.mjs';
import { claimNextAgentCampaignRecord } from '../lib/outbound-dialer/agent-campaigns.js';
import { createWorkItem, applyTransition } from '../lib/acd/lifecycle.mjs';

const pool = await prepareAcdTestPool('acd_core_test_outbound_runtime');
const tx = makeTxRunner(pool);
after(() => { clearSagaDeadlineWakeups(); return pool.end(); });
// Deadline wake-ups are process-global and sweeps are database-wide: without
// this an earlier test's saga is driven concurrently with, or through the
// provider of, a later one. Both produce failures unrelated to the behaviour
// under test.
beforeEach(async () => {
  clearSagaDeadlineWakeups();
  await pool.query(`UPDATE acd_sagas SET state = 'cancelled', terminal_at = now(),
    lease_owner = NULL, lease_expires_at = NULL WHERE state IN ('running', 'compensating')`);
  await pool.query(`UPDATE acd_outbound_lines line SET released_at=now(),release_reason='test isolation'
    WHERE released_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM acd_sagas saga WHERE saga.id=line.owner_saga_id AND saga.state IN ('running','compensating'))`);
  await pool.query(`UPDATE outbound_settings SET settings=settings||'{"max_lines":20}'::jsonb WHERE id='default'`);
});
await ensureOutboundTestSchema(pool);
process.env.TELNYX_CALL_CONTROL_ID = 'test-connection';
process.env.TELNYX_WEBHOOK_BASE_URL = 'https://example.invalid';
const readSaga = async id => (await pool.query('SELECT * FROM acd_sagas WHERE id = $1', [id])).rows[0];
async function fixture(mode, opts = {}) {
  const agentId = randomUUID();
  const queueId = randomUUID();
  await seedAgent(pool, agentId);
  await seedQueue(pool, queueId, [agentId], { engineOwner: 'acd_core' });
  const list = (await pool.query(`INSERT INTO outbound_contact_lists (name) VALUES ('Fixture') RETURNING id`)).rows[0].id;
  const campaign = (await pool.query(`INSERT INTO outbound_campaigns (name, status, mode, channel, handler_type, handler_ref, contact_list_id, amd_config, metadata)
    VALUES ('Fixture', 'running', $1, 'voice', $2, $3, $4, $5, '{"from_numbers":["+15550001111"]}') RETURNING *`,
    [mode, mode === 'agentless_ai' ? 'ai_assistant' : mode === 'agentless_flow' ? 'call_flow' : 'queue',
      mode.startsWith('agentless') ? randomUUID() : queueId, list, { enabled: opts.amd || false, mode: 'premium', ...opts.amdConfig }])).rows[0];
  const record = (await pool.query(`INSERT INTO outbound_contact_records (contact_list_id, row_data, validation_status) VALUES ($1, '{"phone":"+15550002222"}', 'valid') RETURNING id`, [list])).rows[0].id;
  const ledger = (await pool.query(`INSERT INTO outbound_attempt_ledger (campaign_id, contact_record_id, status, channel, handler_type, handler_ref, metadata)
    VALUES ($1, $2, 'claimed', 'voice', $3, $4, $5) RETURNING *`, [campaign.id, record, campaign.handler_type, campaign.handler_ref, { auto_dial_at: opts.due ? new Date(Date.now()-1000).toISOString() : null }])).rows[0];
  if (opts.formId) campaign.attached_form_id = opts.formId;
  const started = await tx(t => startOutboundConnect(t, { campaign, ledger, agentId: ['preview','progressive'].includes(mode) ? agentId : null, agentUsername: `${agentId}@test.local` }));
  const callId = `v3:${randomUUID()}`;
  const provider = makeFakeProvider([{ outcome: 'accepted', httpStatus: 200, response: { data: { call_control_id: callId, call_session_id: randomUUID(), is_alive: false } } }]);
  const send=provider.send;
  provider.send=async args=>{if(args.operation==='outbound_agent_dial'){provider.calls.push(args);return {outcome:'accepted',httpStatus:200,response:{data:{call_control_id:`transport:${ledger.id}`}}};}return send(args);};
  return { ...started, campaign, ledger, agentId, queueId, callId, provider };
}
async function event(f, eventType, extra = {}) {
  return applyOutboundVoiceEvent(pool, f.provider, { eventId: randomUUID(), eventType, payload: { call_control_id: f.callId, ...extra } });
}
async function liveLines(id) { return Number((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_outbound_lines WHERE attempt_id = $1 AND released_at IS NULL`, [id])).rows[0].n); }

async function answerPreDialAgent(f) {
  const {applyClaimedAcdVoiceEvent}=await import('../lib/acd/live-intake.mjs');
  const connect=(await pool.query("SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='connect'",[f.workItemId])).rows[0];
  assert.ok(connect);
  await driveSaga(pool,connect.id,{provider:f.provider});
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_dial').length,0,'customer not dialed while agent rings');
  const agentCallId=`device:${randomUUID()}`;
  const agentEvent=eventType=>applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType,payload:{call_control_id:agentCallId,direction:'incoming',custom_headers:[{name:'X-CC-Work-Item-Id',value:f.workItemId},{name:'X-CC-Offer-Generation',value:'1'}]}});
  await agentEvent('call.initiated');await agentEvent('call.answered');
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  return {connect,agentEvent};
}

for (const mode of ['preview', 'progressive', 'power', 'predictive', 'agentless_ai', 'agentless_flow']) test(`${mode}: durable origination, answered handler and actual hangup releases line`, async () => {
  const f = await fixture(mode, { due: true });
  if (mode === 'preview') {
    await driveSaga(pool, f.sagaId, { provider: f.provider });
    assert.equal(f.provider.calls.length, 0);
    const own = await requestOutboundDial(pool, { attemptId: f.ledger.id, agentId: f.agentId });
    assert.equal(own.server_dial, true);
  }
  await driveSaga(pool, f.sagaId, { provider: f.provider });
  if(['preview','progressive'].includes(mode)&&!f.provider.calls.some(c=>c.operation==='outbound_dial')) await answerPreDialAgent(f);
  assert.equal(f.provider.calls.filter(c => c.operation === 'outbound_dial').length, 1);
  assert.equal(await liveLines(f.ledger.id), 1, 'is_alive=false in dial ACK is not an ended call');
  await driveSaga(pool, f.sagaId, { provider: f.provider, node: 'second-node' });
  assert.equal(f.provider.calls.filter(c => c.operation === 'outbound_dial').length, 1);
  await event(f, 'call.answered');
  assert.ok(['handling', 'wait_connection'].includes((await readSaga(f.sagaId)).step));
  if (mode === 'agentless_ai') assert.equal(f.provider.calls.filter(c => c.operation === 'outbound_start_ai').length, 1);
  if (['preview','progressive'].includes(mode)) assert.equal(await tx(t => tryReserveCapacity(t, { agentId: f.agentId })), null);
  await event(f, 'call.hangup');
  assert.equal(await liveLines(f.ledger.id), 0);
  await event(f, 'call.answered');
  const ending=await readSaga(f.sagaId);
  if(ending.state==='running'&&ending.step==='await_assignment_cleanup'){
    await pool.query(`UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1`,[f.sagaId]);
    await sweepDueSagas(pool,{provider:f.provider});
  }
  assert.equal((await readSaga(f.sagaId)).state, 'succeeded');
});

test('AMD before answer, duplicate premium human, and ended-before-answer are monotonic', async () => {
  const f = await fixture('agentless_ai', { amd: true });
  await driveSaga(pool, f.sagaId, { provider: f.provider });
  await event(f, 'call.machine.premium.detection.ended', { result: 'human_business' });
  await event(f, 'call.answered');
  await event(f, 'call.machine.premium.detection.ended', { result: 'machine' });
  assert.equal(f.provider.calls.filter(c => c.operation === 'outbound_start_ai').length, 1);
  await event(f, 'call.hangup');
  await event(f, 'call.answered');
  await event(f, 'call.machine.premium.detection.ended', { result: 'machine' });
  assert.equal((await pool.query(`SELECT state FROM acd_legs WHERE provider_call_id = $1`, [f.callId])).rows[0].state, 'ended');
  const work=(await pool.query('SELECT state,attributes FROM acd_work_items WHERE id=$1',[f.workItemId])).rows[0];
  const ledger=(await pool.query('SELECT metadata FROM outbound_attempt_ledger WHERE id=$1',[f.ledger.id])).rows[0];
  assert.equal(work.attributes.outbound_amd_result,'human_business','a contradictory or late AMD event cannot replace the first classification');
  assert.equal(ledger.metadata.amd_result,'human_business');
  assert.equal(f.provider.calls.filter(c => c.operation === 'outbound_start_ai').length, 1,'late events cannot start the handler again');
  assert.ok(['completed','abandoned'].includes(work.state));
});

test('a delayed greeting after hangup cannot revive voicemail playback',async()=>{
  const f=await fixture('agentless_flow',{amd:true,amdConfig:{
    mode:'premium',
    voicemailAction:'drop_message',
    voicemailMessage:'Late greeting must not play',
    voicemail_tts:{voice:'Telnyx.Ultra.test-voice',language:'en-US'},
  }});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.answered');
  await event(f,'call.machine.premium.detection.ended',{result:'machine'});
  assert.equal((await readSaga(f.sagaId)).step,'await_greeting');
  await event(f,'call.hangup');
  await event(f,'call.machine.premium.greeting.ended',{result:'beep_detected'});
  await event(f,'call.machine.premium.greeting.ended',{result:'beep_detected'});
  assert.equal((await readSaga(f.sagaId)).state,'succeeded');
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_voicemail').length,0);
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_hangup').length,0,'an ended customer leg is never hung up again');
  assert.equal(await liveLines(f.ledger.id),0);
});

test('Core AMD persists the provider detection timestamp on the work item and attempt', async () => {
  const f = await fixture('agentless_ai', { amd: true, amdConfig: { mode: 'standard' } });
  await driveSaga(pool, f.sagaId, { provider: f.provider });
  await event(f, 'call.answered');
  const occurredAt = '2026-09-07T18:31:52.480Z';
  await applyOutboundVoiceEvent(pool, f.provider, {
    eventId: randomUUID(),
    eventType: 'call.machine.detection.ended',
    occurredAt,
    payload: { call_control_id: f.callId, result: 'human' },
  });
  const work = (await pool.query('SELECT attributes FROM acd_work_items WHERE id=$1', [f.workItemId])).rows[0];
  const ledger = (await pool.query('SELECT metadata FROM outbound_attempt_ledger WHERE id=$1', [f.ledger.id])).rows[0];
  assert.equal(work.attributes.outbound_amd_result, 'human');
  assert.equal(new Date(work.attributes.outbound_amd_detected_at).toISOString(), occurredAt);
  assert.equal(ledger.metadata.amd_result, 'human');
  assert.equal(new Date(ledger.metadata.amd_detected_at).toISOString(), occurredAt);
});

test('unknown origination after dedupe window retains line across deadline/restart and never redials', async () => {
  const f = await fixture('agentless_ai');
  f.provider = makeFakeProvider([{ outcome: 'ambiguous', httpStatus: 503 }]);
  await driveSaga(pool, f.sagaId, { provider: f.provider });
  await pool.query(`UPDATE acd_commands SET created_at = now() - interval '2 minutes' WHERE saga_id = $1`, [f.sagaId]);
  await pool.query(`UPDATE acd_sagas SET deadline_at = now() - interval '1 second' WHERE id = $1`, [f.sagaId]);
  await sweepDueSagas(pool, { provider: f.provider });
  await driveSaga(pool, f.sagaId, { provider: f.provider, node: 'restart' });
  assert.equal(f.provider.calls.length, 1);
  assert.equal(await liveLines(f.ledger.id), 1);
  assert.equal((await readSaga(f.sagaId)).step, 'await_evidence');
});

test('HTTP hangup acceptance does not release machine call line', async () => {
  const f = await fixture('agentless_flow', { amd: true });
  await driveSaga(pool, f.sagaId, { provider: f.provider });
  await event(f, 'call.answered');
  await event(f, 'call.machine.premium.detection.ended', { result: 'machine' });
  assert.equal((await readSaga(f.sagaId)).step, 'await_end');
  assert.equal(await liveLines(f.ledger.id), 1);
  await event(f, 'call.hangup');
  assert.equal(await liveLines(f.ledger.id), 0);
  const ledger=(await pool.query('SELECT * FROM outbound_attempt_ledger WHERE id=$1',[f.ledger.id])).rows[0];
  assert.equal(ledger.status,'completed');
  assert.equal(ledger.metadata.amd_result,'machine');
  assert.equal(ledger.metadata.reason_code,'answering_machine','normal_clearing must not overwrite the AMD business outcome');
  const {DASHBOARD_SUMMARY_SQL}=await import('../lib/outbound-dialer/dashboard-summary.mjs');
  const stats=(await pool.query(DASHBOARD_SUMMARY_SQL,[[f.campaign.id]])).rows[0];
  assert.equal(stats.machine_total,1);
});

for(const carrier of [
  {name:'busy',hangupCause:'user_busy',status:'failed',dialState:'busy',reason:'user_busy',retry:true},
  {name:'explicit rejection',hangupCause:'call_rejected',status:'cancelled',dialState:'failed',reason:'call_rejected',retry:false},
  {name:'unreachable',hangupCause:'not_found',status:'failed',dialState:'failed',reason:'not_found',retry:true},
])test(`carrier ${carrier.name} outcome is terminal, classified and replay safe`,async()=>{
  const f=await fixture('predictive',{due:true});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.hangup',{hangup_cause:carrier.hangupCause});
  const first=(await pool.query('SELECT status,dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1',[f.ledger.id])).rows[0];
  assert.equal(first.status,carrier.status);
  assert.equal(first.dial_state,carrier.dialState);
  assert.equal(first.metadata.reason_code,carrier.reason);
  assert.equal(first.metadata.failure_reason,carrier.status==='failed'?carrier.reason:null);
  assert.equal(first.metadata.retry_eligible,carrier.retry);
  assert.equal(Boolean(first.metadata.next_retry_at),carrier.retry);
  assert.equal(await liveLines(f.ledger.id),0);
  const snapshot=await pool.query(`SELECT state,terminal_at FROM acd_work_items WHERE id=$1`,[f.workItemId]);
  assert.ok(snapshot.rows[0].terminal_at);
  assert.ok(['abandoned','failed'].includes(snapshot.rows[0].state));
  assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS n FROM acd_reservations WHERE work_item_id=$1 AND state<>\'released\'',[f.workItemId])).rows[0].n),0);
  await event(f,'call.hangup',{hangup_cause:'normal_clearing'});
  const replay=(await pool.query('SELECT status,dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1',[f.ledger.id])).rows[0];
  assert.equal(replay.status,first.status);
  assert.equal(replay.dial_state,first.dial_state);
  assert.equal(replay.metadata.reason_code,first.metadata.reason_code);
});

test('agent-first busy outcome becomes terminal after the assignment saga releases the agent',async()=>{
  const f=await fixture('progressive',{due:true});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  const {agentEvent}=await answerPreDialAgent(f);
  assert.equal(f.provider.calls.filter(call=>call.operation==='outbound_dial').length,1);

  await event(f,'call.hangup',{hangup_cause:'user_busy'});
  await agentEvent('call.hangup');
  let outbound=await readSaga(f.sagaId);
  if(outbound.state==='running'){
    assert.equal(outbound.step,'await_assignment_cleanup');
    await pool.query(`UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1`,[f.sagaId]);
    await sweepDueSagas(pool,{provider:f.provider});
    outbound=await readSaga(f.sagaId);
  }

  assert.equal(outbound.state,'succeeded');
  const work=(await pool.query('SELECT state,terminal_at FROM acd_work_items WHERE id=$1',[f.workItemId])).rows[0];
  assert.equal(work.state,'abandoned');
  assert.ok(work.terminal_at);
  assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_reservations WHERE work_item_id=$1 AND state<>'released'`,[f.workItemId])).rows[0].n),0);
  assert.equal(await liveLines(f.ledger.id),0);
});

test('progressive cancellation when SDK readiness is lost before server deadline', async () => {
  const f = await fixture('progressive', { due: true });
  await pool.query(`UPDATE acd_agent_sessions SET expires_at = now() - interval '1 second' WHERE agent_id = $1`, [f.agentId]);
  await driveSaga(pool, f.sagaId, { provider: f.provider });
  assert.equal(f.provider.calls.length, 0);
  assert.equal((await readSaga(f.sagaId)).state, 'cancelled');
});

test('pause prevents a new command, including work already prepared', async () => {
  const f = await fixture('agentless_ai');
  await pool.query(`UPDATE outbound_campaigns SET status = 'paused' WHERE id = $1`, [f.campaign.id]);
  await driveSaga(pool, f.sagaId, { provider: f.provider });
  assert.equal(f.provider.calls.length, 0);
  assert.equal((await readSaga(f.sagaId)).state, 'cancelled');
});

test('pause lets an in-flight call finish, resume does not duplicate it, and stop blocks admission',async()=>{
  const f=await fixture('agentless_ai',{due:true});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_dial').length,1);
  await pool.query("UPDATE outbound_campaigns SET status='paused' WHERE id=$1",[f.campaign.id]);
  await event(f,'call.answered');
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_start_ai').length,1,'the drain policy lets the in-flight call continue');
  await pool.query("UPDATE outbound_campaigns SET status='running' WHERE id=$1",[f.campaign.id]);
  const resumed=await Promise.all([claimAutonomousOutbound(pool,f.campaign.id),claimAutonomousOutbound(pool,f.campaign.id)]);
  assert.equal(resumed.filter(Boolean).length,0,'resume cannot duplicate the active contact');
  assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS n FROM outbound_attempt_ledger WHERE campaign_id=$1',[f.campaign.id])).rows[0].n),1);
  await event(f,'call.hangup');
  assert.equal(await liveLines(f.ledger.id),0);
  await pool.query("UPDATE outbound_campaigns SET status='stopped' WHERE id=$1",[f.campaign.id]);
  assert.equal(await claimAutonomousOutbound(pool,f.campaign.id),null,'stop blocks every new admission');
});

for (const change of ['paused', 'completed', 'device_offline']) test(`restart before first send respects ${change} and releases unused capacity`, async () => {
  const f = await fixture('progressive', { due: true });
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  const child=(await pool.query("SELECT id FROM acd_sagas WHERE work_item_id=$1 AND type='connect'",[f.workItemId])).rows[0];
  const interruptedPool = {
    connect: () => pool.connect(),
    query: (sql, values) => {
      if (sql.includes('UPDATE acd_commands') && sql.includes('attempt_count = attempt_count + 1')) {
        throw new Error('process interrupted before marking command sent');
      }
      return pool.query(sql, values);
    },
  };
  await assert.rejects(driveSaga(interruptedPool, child.id, { provider: f.provider, node: 'before-restart' }), /process interrupted/);
  assert.equal((await pool.query(`SELECT status FROM acd_commands WHERE saga_id=$1`, [child.id])).rows[0].status, 'planned');
  assert.equal(f.provider.calls.length, 0);
  if (change === 'device_offline') {
    await pool.query(`UPDATE acd_agent_sessions SET expires_at=now()-interval '1 second' WHERE agent_id=$1`, [f.agentId]);
  } else {
    await pool.query(`UPDATE outbound_campaigns SET status=$2 WHERE id=$1`, [f.campaign.id, change]);
  }
  await pool.query(`UPDATE acd_sagas SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [child.id]);
  await driveSaga(pool,child.id,{provider:f.provider,node:'after-restart'});
  await driveSaga(pool, f.sagaId, { provider: f.provider, node: 'after-restart' });
  assert.equal(f.provider.calls.length, 0, 'a committed plan is still cancellable until first send');
  assert.equal((await readSaga(f.sagaId)).state, 'cancelled');
  assert.equal(await liveLines(f.ledger.id), 0);
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE work_item_id=$1`, [f.workItemId])).rows[0].state, 'released');
  assert.equal((await pool.query(`SELECT status FROM acd_commands WHERE saga_id=$1`, [child.id])).rows[0].status, 'failed');
});

test('two-node campaign claims obey one shared global budget', async () => {
  await pool.query(`UPDATE acd_outbound_lines SET released_at = now(), release_reason = 'fixture isolation'`);
  await pool.query(`UPDATE outbound_attempt_ledger SET status = 'completed' WHERE status IN ('claimed','dialing','answered')`);
  await pool.query(`UPDATE outbound_settings SET settings = settings || '{"max_lines":1}'::jsonb WHERE id = 'default'`);
  const a = await fixture('agentless_ai');
  const b = await fixture('agentless_flow');
  // Fixture-owned pending attempts are excluded from new contact candidates.
  for (const f of [a,b]) await pool.query(`INSERT INTO outbound_contact_records (contact_list_id, row_data, validation_status) VALUES ($1, '{"phone":"+15550003333"}', 'valid')`, [f.campaign.contact_list_id]);
  const claims = await Promise.all([claimAutonomousOutbound(pool, a.campaign.id), claimAutonomousOutbound(pool, b.campaign.id)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_outbound_lines WHERE released_at IS NULL`)).rows[0].n), 1);
  await pool.query(`UPDATE outbound_settings SET settings = settings || '{"max_lines":20}'::jsonb WHERE id = 'default'`);
});

test('a campaign line limit blocks its second contact until the first line ends',async()=>{
  await pool.query(`UPDATE acd_outbound_lines SET released_at=now(),release_reason='fixture isolation' WHERE released_at IS NULL`);
  await pool.query(`UPDATE outbound_attempt_ledger SET status='completed' WHERE status IN ('claimed','dialing','answered')`);
  await pool.query(`UPDATE outbound_settings SET settings=settings||'{"max_lines":2}'::jsonb WHERE id='default'`);
  const f=await fixture('agentless_ai',{due:true});
  await pool.query(`UPDATE outbound_campaigns SET concurrency_config='{"maxConcurrent":1}'::jsonb WHERE id=$1`,[f.campaign.id]);
  await pool.query(`INSERT INTO outbound_contact_records(contact_list_id,row_data,validation_status) VALUES($1,'{"phone":"+15550003333"}','valid')`,[f.campaign.contact_list_id]);
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  assert.equal(await claimAutonomousOutbound(pool,f.campaign.id),null,'campaign cannot exceed its own provider-line limit');
  await event(f,'call.hangup');
  const next=await claimAutonomousOutbound(pool,f.campaign.id);
  assert.ok(next,'the next contact becomes admissible after campaign capacity is released');
  const nextCallId=`v3:${randomUUID()}`;
  const nextProvider=makeFakeProvider([{outcome:'accepted',httpStatus:200,response:{data:{call_control_id:nextCallId,call_session_id:randomUUID()}}}]);
  await driveSaga(pool,next.sagaId,{provider:nextProvider});
  await applyOutboundVoiceEvent(pool,nextProvider,{eventId:randomUUID(),eventType:'call.hangup',payload:{call_control_id:nextCallId,hangup_cause:'originator_cancel'}});
  assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS n FROM acd_outbound_lines WHERE campaign_id=$1 AND released_at IS NULL',[f.campaign.id])).rows[0].n),0);
  await pool.query(`UPDATE outbound_settings SET settings=settings||'{"max_lines":20}'::jsonb WHERE id='default'`);
});

test('preview claim races with inbound and a second browser through the same agent lock', async () => {
  const f = await fixture('preview');
  await pool.query(`INSERT INTO outbound_campaign_agent_assignments (campaign_id, agent_username) VALUES ($1, $2)`, [f.campaign.id, `${f.agentId}@test.local`]);
  const claims = await Promise.all([claimNextAgentCampaignRecord(pool, `${f.agentId}@test.local`), claimNextAgentCampaignRecord(pool, `${f.agentId}@test.local`)]);
  assert.equal(claims[0].id, f.ledger.id);
  assert.equal(claims[1].id, f.ledger.id);
  assert.equal(await tx(t => tryReserveCapacity(t, { agentId: f.agentId, purpose: 'queue' })), null);
});

// Exercise the same intake and connect used by the worker, through agent
// bridge, device cleanup and campaign wrap-up. No Telnyx calls are made.
async function connectHuman(f) {
  const { routeAndConnect, applyClaimedAcdVoiceEvent } = await import('../lib/acd/live-intake.mjs');
  if (f.campaign.mode === 'preview') await requestOutboundDial(pool,{attemptId:f.ledger.id,agentId:f.agentId});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  const pre=['preview','progressive'].includes(f.campaign.mode)?await answerPreDialAgent(f):null;
  await event(f,'call.answered');
  if (pre) {
    await driveSaga(pool,pre.connect.id,{provider:f.provider});
    await event(f,'call.bridged');
    await driveSaga(pool,f.sagaId,{provider:f.provider});
    assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[f.workItemId])).rows[0].state,'active');
    return pre;
  }
  if (['power','predictive'].includes(f.campaign.mode)) await routeAndConnect(pool,f.provider,f.workItemId);
  const connect = (await pool.query(`SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='connect'`,[f.workItemId])).rows[0];
  assert.ok(connect);
  await driveSaga(pool,connect.id,{provider:f.provider});
  const agentCallId=`device:${randomUUID()}`;
  const agentEvent=eventType=>applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType,payload:{
    call_control_id:agentCallId,call_session_id:randomUUID(),direction:'incoming',
    custom_headers:[{name:'X-CC-Work-Item-Id',value:f.workItemId},{name:'X-CC-Offer-Generation',value:String(connect.data.generation)}]
  }});
  await agentEvent('call.initiated');
  await agentEvent('call.answered');
  await event(f,'call.bridged');
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  assert.equal((await pool.query(`SELECT state FROM acd_work_items WHERE id=$1`,[f.workItemId])).rows[0].state,'active');
  return {connect,agentEvent};
}

for (const mode of ['preview','progressive','power','predictive']) test(`${mode}: bridge, customer end, agent end, disposition and capacity recovery`,async()=>{
  const {submitOutboundDisposition}=await import('../lib/acd/outbound-disposition.mjs');
  const {findPendingAcdWrapupForAgent}=await import('../lib/acd/wrapup-context.mjs');
  const {completeCampaignIfExhausted}=await import('../lib/outbound-dialer/completion.js');
  const f=await fixture(mode,{due:true});
  const {agentEvent}=await connectHuman(f);
  await pool.query(`INSERT INTO cc_wrapup_codes (id,name) VALUES ('voice-done','Voice done') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO outbound_disposition_code_mappings (wrapup_code_id,campaign_id,classification) VALUES ('voice-done',$1,'right_party_contact')`,[f.campaign.id]);
  await assert.rejects(submitOutboundDisposition(pool,{attemptId:f.ledger.id,agentId:f.agentId,dispositionCodeId:'voice-done'}));
  await event(f,'call.hangup');
  assert.equal(await liveLines(f.ledger.id),0);
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:f.agentId})),null,'live agent device still owns capacity');
  const cleanup=(await pool.query(`SELECT id FROM acd_sagas WHERE work_item_id=$1 AND type='reservation_cleanup'`,[f.workItemId])).rows[0];
  assert.ok(cleanup);
  await driveSaga(pool,cleanup.id,{provider:f.provider});
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:f.agentId})),null,'accepted hangup is not end evidence');
  await agentEvent('call.hangup');
  await driveSaga(pool,cleanup.id,{provider:f.provider,node:'restart'});
  const pending=await findPendingAcdWrapupForAgent(pool,{agentId:f.agentId});
  assert.equal(pending.outbound_attempt_id,f.ledger.id);
  assert.equal(pending.outbound_campaign_id,f.campaign.id);
  assert.equal((await completeCampaignIfExhausted(pool,f.campaign)).completed,false,'campaign waits for the agent outcome');
  const submission={attemptId:f.ledger.id,agentId:f.agentId,dispositionCodeId:'voice-done'};
  assert.equal((await submitOutboundDisposition(pool,submission)).agent_status,'Available');
  assert.equal((await submitOutboundDisposition(pool,submission)).alreadySubmitted,true);
  const {claimOneAgentlessRecord}=await import('../lib/outbound-dialer/execution.js');
  assert.equal(await tx(t=>claimOneAgentlessRecord(t,f.campaign,null)),null,'a completed contact cannot re-enter the campaign');
  assert.ok(await tx(t=>tryReserveCapacity(t,{agentId:f.agentId})));
});

// An accepted bridge is not a bridged call. The origination owner must not
// announce an unserved call into a conversation the provider is still
// connecting, and a late bridge must not promote work the owner abandoned.
test('an accepted bridge awaiting its webhook is not abandoned as unserved',async()=>{
  const {routeAndConnect,applyClaimedAcdVoiceEvent}=await import('../lib/acd/live-intake.mjs');
  const f=await fixture('predictive',{due:true});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.answered');
  await routeAndConnect(pool,f.provider,f.workItemId);
  const connect=(await pool.query(`SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='connect'`,[f.workItemId])).rows[0];
  await driveSaga(pool,connect.id,{provider:f.provider});
  const agentCallId=`device:${randomUUID()}`;
  const agentEvent=eventType=>applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType,payload:{
    call_control_id:agentCallId,call_session_id:randomUUID(),direction:'incoming',
    custom_headers:[{name:'X-CC-Work-Item-Id',value:f.workItemId},{name:'X-CC-Offer-Generation',value:String(connect.data.generation)}]}});
  await agentEvent('call.initiated');
  await agentEvent('call.answered');
  assert.ok((await readSaga(connect.id)).data.bridgeRequested,'the bridge command was issued');

  // The connection deadline fires in the window between bridge acceptance and
  // the call.bridged webhook.
  await pool.query(`UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1`,[f.sagaId]);
  await sweepDueSagas(pool,{provider:f.provider});
  assert.equal((await readSaga(f.sagaId)).step,'await_bridge_evidence');
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_abandon_announcement').length,0);
  assert.notEqual((await pool.query(`SELECT dial_state FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0].dial_state,'abandoned');

  await event(f,'call.bridged');
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  assert.equal((await pool.query(`SELECT state FROM acd_work_items WHERE id=$1`,[f.workItemId])).rows[0].state,'active');
  assert.equal((await readSaga(f.sagaId)).step,'handling');
  const ledger=(await pool.query(`SELECT dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.equal(ledger.dial_state,'connected');
  assert.equal(ledger.metadata.abandoned_at,undefined);
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_abandon_announcement').length,0);
});

test('a bridge that never arrives abandons once and blocks a late promotion',async()=>{
  const {routeAndConnect,applyClaimedAcdVoiceEvent}=await import('../lib/acd/live-intake.mjs');
  const f=await fixture('predictive',{due:true});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.answered');
  await routeAndConnect(pool,f.provider,f.workItemId);
  const connect=(await pool.query(`SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='connect'`,[f.workItemId])).rows[0];
  await driveSaga(pool,connect.id,{provider:f.provider});
  const agentCallId=`device:${randomUUID()}`;
  const agentEvent=eventType=>applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType,payload:{
    call_control_id:agentCallId,call_session_id:randomUUID(),direction:'incoming',
    custom_headers:[{name:'X-CC-Work-Item-Id',value:f.workItemId},{name:'X-CC-Offer-Generation',value:String(connect.data.generation)}]}});
  await agentEvent('call.initiated');
  await agentEvent('call.answered');

  await pool.query(`UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1`,[f.sagaId]);
  await sweepDueSagas(pool,{provider:f.provider});
  assert.equal((await readSaga(f.sagaId)).step,'await_bridge_evidence');
  // The grace expires without any bridge evidence: exactly one abandonment.
  await pool.query(`UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1`,[f.sagaId]);
  await sweepDueSagas(pool,{provider:f.provider});
  assert.ok((await readSaga(f.sagaId)).data.bridgeGraceExpired);
  assert.equal((await pool.query(`SELECT dial_state FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0].dial_state,'abandoned');
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_abandon_announcement').length,1);

  // A bridge webhook arriving after the abandonment cannot promote the work,
  // and must not leave the side effects of a promotion behind either.
  const offer=(await pool.query(`SELECT id,state FROM acd_offers WHERE work_item_id=$1`,[f.workItemId])).rows[0];
  await event(f,'call.bridged');
  await driveSaga(pool,connect.id,{provider:f.provider});
  assert.notEqual((await pool.query(`SELECT state FROM acd_work_items WHERE id=$1`,[f.workItemId])).rows[0].state,'active');
  assert.notEqual((await pool.query(`SELECT state FROM acd_reservations WHERE work_item_id=$1
    ORDER BY created_at DESC LIMIT 1`,[f.workItemId])).rows[0].state,'active','no reservation is promoted');
  assert.notEqual((await pool.query(`SELECT state FROM acd_offers WHERE id=$1`,[offer.id])).rows[0].state,'accepted');
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_segments
    WHERE work_item_id=$1 AND kind='agent'`,[f.workItemId])).rows[0].n,0,'no agent segment is opened');
  assert.notEqual((await pool.query(`SELECT workflow_state FROM acd_agent_state WHERE agent_id=$1`,[f.agentId])).rows[0].workflow_state,'handling');
  const settled=(await pool.query(`SELECT dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.equal(settled.dial_state,'abandoned','the recorded outcome stays abandoned');
  assert.ok(settled.metadata.abandoned_at);
});

test('a missing AMD result follows the human path instead of dead air',async()=>{
  const f=await fixture('predictive',{due:true,amd:true});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.answered');
  assert.equal((await readSaga(f.sagaId)).step,'await_amd');
  // The budget actually sent to Telnyx is the one the saga waits on. This
  // fixture runs premium detection, which is documented with a far longer
  // window than word detection.
  const sentBudget=(await readSaga(f.sagaId)).data.dialPayload.answering_machine_detection_config;
  assert.equal(sentBudget.total_analysis_time_millis,30000,'premium gets its own explicit budget');
  const waited=new Date((await readSaga(f.sagaId)).deadline_at).getTime()-Date.now();
  assert.ok(waited>=sentBudget.total_analysis_time_millis,'the saga never gives up before the provider does');
  assert.ok(waited<=sentBudget.total_analysis_time_millis+7000,`only the webhook margin on top, got ${waited}ms`);

  await pool.query(`UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1`,[f.sagaId]);
  await sweepDueSagas(pool,{provider:f.provider});

  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_hangup').length,0,'a human is never hung up on silently');
  const work=(await pool.query(`SELECT attributes FROM acd_work_items WHERE id=$1`,[f.workItemId])).rows[0];
  assert.equal(work.attributes.outbound_amd_result,'not_sure');
  assert.equal(work.attributes.outbound_amd_timed_out,true);
  const ledger=(await pool.query(`SELECT dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.equal(ledger.dial_state,'human');
  assert.equal(ledger.metadata.amd_timed_out,true);
  assert.ok(ledger.metadata.human_answered_at);
});

test('a provider not_sure result follows the human route and preserves the raw classification',async()=>{
  const f=await fixture('predictive',{due:true,amd:true,amdConfig:{mode:'standard'}});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.answered');
  await event(f,'call.machine.detection.ended',{result:'not_sure'});
  const work=(await pool.query('SELECT attributes FROM acd_work_items WHERE id=$1',[f.workItemId])).rows[0];
  const ledger=(await pool.query('SELECT dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1',[f.ledger.id])).rows[0];
  assert.equal(work.attributes.outbound_amd_result,'not_sure');
  assert.equal(ledger.dial_state,'human');
  assert.equal(ledger.metadata.amd_result,'not_sure');
  assert.ok(ledger.metadata.human_answered_at);
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_hangup').length,0);
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  const routed=(await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[f.workItemId])).rows[0];
  assert.equal(routed.state,'queued','human classification returns the work to the queue router');
  assert.equal(Number((await pool.query("SELECT COUNT(*)::int AS n FROM acd_segments WHERE work_item_id=$1 AND kind='queue_wait' AND ended_at IS NULL",[f.workItemId])).rows[0].n),1);
});

test('a Premium silence result follows the configured machine hangup policy',async()=>{
  const f=await fixture('predictive',{due:true,amd:true,amdConfig:{mode:'premium',machine_action:'hangup'}});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.answered');
  await event(f,'call.machine.premium.detection.ended',{result:'silence'});
  const work=(await pool.query('SELECT attributes FROM acd_work_items WHERE id=$1',[f.workItemId])).rows[0];
  const ledger=(await pool.query('SELECT dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1',[f.ledger.id])).rows[0];
  assert.equal(work.attributes.outbound_amd_result,'silence');
  assert.equal(ledger.dial_state,'voicemail_action');
  assert.equal(ledger.metadata.amd_result,'silence');
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_hangup').length,1);
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_agent_dial').length,0);
  await event(f,'call.hangup');
  const completed=(await pool.query('SELECT status,dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1',[f.ledger.id])).rows[0];
  assert.equal(completed.status,'completed');
  assert.equal(completed.dial_state,'disposed');
  assert.equal(completed.metadata.reason_code,'answering_machine','normal_clearing must not overwrite the Premium silence business outcome');
});

test('standard and premium detection each send their own default budget',async()=>{
  const {normalizeAmdAnalysisMs,DEFAULT_AMD_ANALYSIS_MS,DEFAULT_PREMIUM_AMD_ANALYSIS_MS}=await import('../lib/outbound-dialer/execution.js');
  assert.equal(normalizeAmdAnalysisMs(undefined,'detect_words'),DEFAULT_AMD_ANALYSIS_MS);
  assert.equal(normalizeAmdAnalysisMs(undefined,'premium'),DEFAULT_PREMIUM_AMD_ANALYSIS_MS);
  // Legacy configurations must not survive as NaN, zero or out-of-range values.
  assert.equal(normalizeAmdAnalysisMs('not-a-number','premium'),DEFAULT_PREMIUM_AMD_ANALYSIS_MS);
  assert.equal(normalizeAmdAnalysisMs(0,'detect_words'),DEFAULT_AMD_ANALYSIS_MS);
  assert.equal(normalizeAmdAnalysisMs(-5,'premium'),DEFAULT_PREMIUM_AMD_ANALYSIS_MS);
  assert.equal(normalizeAmdAnalysisMs(10,'premium'),500);
  assert.equal(normalizeAmdAnalysisMs(999999,'premium'),60000);
  assert.equal(normalizeAmdAnalysisMs(12000,'premium'),12000);

  const standard=await fixture('predictive',{due:true,amd:true,amdConfig:{mode:'detect_words'}});
  await driveSaga(pool,standard.sagaId,{provider:standard.provider});
  assert.equal((await readSaga(standard.sagaId)).data.dialPayload.answering_machine_detection_config.total_analysis_time_millis,
    DEFAULT_AMD_ANALYSIS_MS,'word detection keeps the short budget');
});

test('a premium saga resumed without a materialised budget still waits the premium window',async()=>{
  const {DEFAULT_PREMIUM_AMD_ANALYSIS_MS}=await import('../lib/outbound-dialer/execution.js');
  const f=await fixture('predictive',{due:true,amd:true});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  // Simulate a saga created before the budget was materialised into the dial
  // payload: only the campaign mode survives.
  await pool.query(`UPDATE acd_sagas SET data = jsonb_set(
      data #- '{dialPayload,answering_machine_detection_config}',
      '{amd}', '{"enabled":true,"mode":"premium"}'::jsonb)
    WHERE id=$1`,[f.sagaId]);
  await event(f,'call.answered');
  const saga=await readSaga(f.sagaId);
  assert.equal(saga.step,'await_amd');
  const waited=new Date(saga.deadline_at).getTime()-Date.now();
  assert.ok(waited>=DEFAULT_PREMIUM_AMD_ANALYSIS_MS,
    `a resumed premium saga must not fall back to the standard window, got ${waited}ms`);
});

test('a long AMD analysis budget extends the wait instead of being truncated',async()=>{
  const f=await fixture('predictive',{due:true,amd:true,amdConfig:{detectionConfig:{total_analysis_time_millis:60000}}});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.answered');
  const saga=await readSaga(f.sagaId);
  assert.equal(saga.step,'await_amd');
  assert.equal(saga.data.dialPayload.answering_machine_detection_config.total_analysis_time_millis,60000);
  const waited=new Date(saga.deadline_at).getTime()-Date.now();
  assert.ok(waited>60000,`the deadline must clear the configured budget, got ${waited}ms`);
  assert.ok(waited<=65000+2000,`with only the webhook margin on top, got ${waited}ms`);
});

// The direct-agentId branch of start_handler is only reachable for a saga
// created before agent-first ordering existed. A resumed one must still be
// cancellable, or a late bridge would promote work its owner has abandoned.
test('a resumed pre-agent-first saga still links its child for cancellation',async()=>{
  const f=await fixture('preview',{due:true});
  await pool.query(`UPDATE acd_sagas SET step='start_handler',
    data=(data - 'agentFirst' - 'connectSagaId') || jsonb_build_object(
      'customerProviderCallId',$2::text,
      'dialPayload',COALESCE(data->'dialPayload','{}'::jsonb) || '{"client_state":"fixture"}'::jsonb)
    WHERE id=$1`,[f.sagaId,f.callId]);
  await pool.query(`INSERT INTO acd_legs (id,work_item_id,role,provider_call_id,state,answered_at)
    VALUES ($1,$2,'customer',$3,'answered',now()) ON CONFLICT (provider_call_id) DO NOTHING`,
    [randomUUID(),f.workItemId,f.callId]);
  await pool.query(`UPDATE acd_work_items SET state='open',terminal_at=NULL WHERE id=$1`,[f.workItemId]);

  await driveSaga(pool,f.sagaId,{provider:f.provider});

  const parent=await readSaga(f.sagaId);
  const child=(await pool.query("SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='connect'",[f.workItemId])).rows[0];
  assert.ok(child,'the assignment saga was created');
  assert.equal(parent.data.connectSagaId,child.id,'the owner can address its child');
  assert.equal(child.data.outboundSagaId,f.sagaId,'the child knows who may cancel it');

  // The cancellation path now reaches the child on this ordering too.
  await pool.query(`UPDATE acd_sagas SET data=data || '{"cancelRequested":true}'::jsonb WHERE id=$1`,[child.id]);
  await pool.query(`UPDATE acd_work_items SET state='active' WHERE id=$1`,[f.workItemId]);
  await pool.query(`UPDATE acd_sagas SET step='establish' WHERE id=$1`,[child.id]);
  await driveSaga(pool,child.id,{provider:f.provider});
  assert.notEqual((await readSaga(child.id)).step,'in_call','a cancelled assignment is not established');
});

test('campaign disposition after automatic wrap-up timeout cannot change the ledger outcome',async()=>{
  const {submitOutboundDisposition}=await import('../lib/acd/outbound-disposition.mjs');
  const {sweepWrapupDeadlines}=await import('../lib/acd/reconciler.mjs');
  const {completeCampaignIfExhausted}=await import('../lib/outbound-dialer/completion.js');
  const f=await fixture('progressive',{due:true});
  const {agentEvent}=await connectHuman(f);
  await event(f,'call.hangup');
  await agentEvent('call.hangup');
  await pool.query(`INSERT INTO cc_wrapup_codes (id,name) VALUES ('late-disposition','Late disposition') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO outbound_disposition_code_mappings (wrapup_code_id,campaign_id,classification) VALUES ('late-disposition',$1,'right_party_contact')`,[f.campaign.id]);
  await pool.query(`UPDATE acd_segments SET wrapup_deadline_at=now()-interval '1 second'
    WHERE work_item_id=$1 AND kind='agent'`,[f.workItemId]);
  await pool.query(`UPDATE acd_agent_state SET workflow_state='wrapup',workflow_deadline_at=now()-interval '1 second'
    WHERE agent_id=$1`,[f.agentId]);
  // Do not stage the ledger: the customer hangup already settled it as
  // 'completed' while the agent still owes a wrap-up. Finalization has to work
  // from the state the normal path actually produces.
  const settled=(await pool.query(`SELECT status,metadata FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.equal(settled.status,'completed');
  assert.equal(settled.metadata.disposition_code_id,undefined);
  assert.equal(await sweepWrapupDeadlines(pool),1);
  const before=(await pool.query(`SELECT status,dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.equal(before.status,'completed');
  assert.equal(before.dial_state,'disposed');
  assert.equal(before.metadata.disposition_code_id,'auto_timeout');
  assert.equal(before.metadata.reason_code,'wrapup_timeout');
  const campaign=(await pool.query(`SELECT * FROM outbound_campaigns WHERE id=$1`,[f.campaign.id])).rows[0];
  assert.equal((await completeCampaignIfExhausted(pool,campaign)).completed,true);

  await assert.rejects(
    submitOutboundDisposition(pool,{attemptId:f.ledger.id,agentId:f.agentId,dispositionCodeId:'late-disposition'}),
    {status:409,message:'Campaign wrap-up is no longer pending'},
  );

  const after=(await pool.query(`SELECT status,dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.deepEqual(after,before);
  const segment=(await pool.query(`SELECT wrapup_code_id FROM acd_segments WHERE work_item_id=$1 AND kind='agent'`,[f.workItemId])).rows[0];
  assert.equal(segment.wrapup_code_id,'auto_timeout');
});

test('automatic wrap-up of a transferred source agent does not finalize the outbound attempt',async()=>{
  const {sweepWrapupDeadlines}=await import('../lib/acd/reconciler.mjs');
  const f=await fixture('progressive',{due:true});
  await connectHuman(f);
  await pool.query(`UPDATE acd_segments SET ended_at=now(),outcome='transferred',wrapup_deadline_at=now()-interval '1 second'
    WHERE work_item_id=$1 AND kind='agent'`,[f.workItemId]);
  await pool.query(`UPDATE acd_work_items SET state='queued',terminal_at=NULL WHERE id=$1`,[f.workItemId]);
  await pool.query(`UPDATE acd_agent_state SET workflow_state='wrapup',workflow_deadline_at=now()-interval '1 second'
    WHERE agent_id=$1`,[f.agentId]);
  // The customer leg is still live after the transfer, so the ledger is
  // genuinely 'answered' here rather than being staged into that state.
  assert.equal((await pool.query(`SELECT status FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0].status,'answered');

  assert.equal(await sweepWrapupDeadlines(pool),1);

  const segment=(await pool.query(`SELECT wrapup_code_id,wrapup_ended_at FROM acd_segments
    WHERE work_item_id=$1 AND kind='agent'`,[f.workItemId])).rows[0];
  assert.equal(segment.wrapup_code_id,'auto_timeout');
  assert.ok(segment.wrapup_ended_at);
  const ledger=(await pool.query(`SELECT status,metadata FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.equal(ledger.status,'answered');
  assert.equal(ledger.metadata.disposition_code_id,undefined);
});

test('external transfer timeout finalizes only after the outbound line is released',async()=>{
  const {sweepWrapupDeadlines}=await import('../lib/acd/reconciler.mjs');
  const {releaseOutboundLine}=await import('../lib/acd/outbound-capacity.mjs');
  const f=await fixture('progressive',{due:true});
  await connectHuman(f);
  await pool.query(`UPDATE acd_segments SET ended_at=now(),outcome='transferred',wrapup_deadline_at=now()-interval '1 second'
    WHERE work_item_id=$1 AND kind='agent'`,[f.workItemId]);
  await pool.query(`UPDATE acd_work_items SET state='completed',terminal_at=now() WHERE id=$1`,[f.workItemId]);
  await pool.query(`UPDATE acd_agent_state SET workflow_state='wrapup',workflow_deadline_at=now()-interval '1 second'
    WHERE agent_id=$1`,[f.agentId]);
  // The external leg still holds the line, so the ledger is genuinely
  // 'answered' at this point rather than being staged into that state.
  assert.equal((await pool.query(`SELECT status FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0].status,'answered');

  assert.equal(await sweepWrapupDeadlines(pool),1);
  assert.equal((await pool.query(`SELECT status FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0].status,'answered');

  await releaseOutboundLine(pool,f.ledger.id,'external_transfer_ended');
  const ledger=(await pool.query(`SELECT status,dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.equal(ledger.status,'completed');
  assert.equal(ledger.dial_state,'disposed');
  assert.equal(ledger.metadata.disposition_code_id,'auto_timeout');
});

test('reconciler retries finalization after concurrent timeout and line-release commits',async()=>{
  const {sweepWrapupDeadlines}=await import('../lib/acd/reconciler.mjs');
  const f=await fixture('progressive',{due:true});
  await connectHuman(f);
  await pool.query(`UPDATE acd_segments SET ended_at=now(),outcome='transferred',wrapup_deadline_at=now()-interval '1 second',
    wrapup_ended_at=now(),wrapup_code_id='auto_timeout' WHERE work_item_id=$1 AND kind='agent'`,[f.workItemId]);
  await pool.query(`UPDATE acd_work_items SET state='completed',terminal_at=now() WHERE id=$1`,[f.workItemId]);
  await pool.query(`UPDATE acd_agent_state SET workflow_state='idle',workflow_deadline_at=NULL WHERE agent_id=$1`,[f.agentId]);
  await pool.query(`UPDATE acd_outbound_lines SET released_at=now(),release_reason='concurrent_external_transfer_end'
    WHERE attempt_id=$1`,[f.ledger.id]);
  assert.equal((await pool.query(`SELECT status FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0].status,'answered');

  assert.equal(await sweepWrapupDeadlines(pool),0,'no newly due segment is needed for retry');
  const ledger=(await pool.query(`SELECT status,dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.equal(ledger.status,'completed');
  assert.equal(ledger.dial_state,'disposed');
  assert.equal(ledger.metadata.disposition_code_id,'auto_timeout');
});

test('automatic timeout preserves a preselected wrap-up code and still finalizes the attempt',async()=>{
  const {sweepWrapupDeadlines}=await import('../lib/acd/reconciler.mjs');
  const f=await fixture('progressive',{due:true});
  const {agentEvent}=await connectHuman(f);
  await event(f,'call.hangup');
  await agentEvent('call.hangup');
  await pool.query(`UPDATE acd_segments SET wrapup_code_id='customer-selected',wrapup_deadline_at=now()-interval '1 second'
    WHERE work_item_id=$1 AND kind='agent'`,[f.workItemId]);
  await pool.query(`UPDATE acd_agent_state SET workflow_state='wrapup',workflow_deadline_at=now()-interval '1 second'
    WHERE agent_id=$1`,[f.agentId]);
  // The ledger is left exactly as the customer hangup settled it.
  assert.equal((await pool.query(`SELECT status FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0].status,'completed');

  assert.equal(await sweepWrapupDeadlines(pool),1);
  const segment=(await pool.query(`SELECT wrapup_code_id,wrapup_ended_at FROM acd_segments
    WHERE work_item_id=$1 AND kind='agent'`,[f.workItemId])).rows[0];
  assert.equal(segment.wrapup_code_id,'customer-selected');
  assert.ok(segment.wrapup_ended_at);
  const ledger=(await pool.query(`SELECT status,dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.equal(ledger.status,'completed');
  assert.equal(ledger.dial_state,'disposed');
  assert.equal(ledger.metadata.disposition_code_id,'auto_timeout');
});

test('callback disposition is durable, cannot retry early and cannot be changed by duplicate submission',async()=>{
  const {submitOutboundDisposition}=await import('../lib/acd/outbound-disposition.mjs');
  const {claimOneAgentlessRecord}=await import('../lib/outbound-dialer/execution.js');
  const f=await fixture('progressive',{due:true});
  const {agentEvent}=await connectHuman(f);
  await event(f,'call.hangup');await agentEvent('call.hangup');
  await pool.query(`INSERT INTO cc_wrapup_codes (id,name) VALUES ('voice-callback','Voice callback') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO outbound_disposition_code_mappings (wrapup_code_id,campaign_id,classification,retry_eligible,requires_callback) VALUES ('voice-callback',$1,'retry',true,true)`,[f.campaign.id]);
  const submission={attemptId:f.ledger.id,agentId:f.agentId,dispositionCodeId:'voice-callback',callbackAt:new Date(Date.now()+86400000).toISOString()};
  await assert.rejects(submitOutboundDisposition(pool,{...submission,callbackAt:'yesterday'}),{status:400});
  await submitOutboundDisposition(pool,submission);
  const ledger=(await pool.query(`SELECT * FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.equal(ledger.metadata.next_retry_at,submission.callbackAt);
  assert.equal(ledger.dial_state,'disposed');
  assert.equal(await tx(t=>claimOneAgentlessRecord(t,f.campaign,null)),null);
  await assert.rejects(submitOutboundDisposition(pool,{...submission,notes:'changed'}),{status:409});
  await pool.query(`UPDATE outbound_attempt_ledger SET metadata=jsonb_set(metadata,'{next_retry_at}',to_jsonb((now()-interval '1 second')::text)) WHERE id=$1`,[f.ledger.id]);
  const due=await tx(t=>claimOneAgentlessRecord(t,f.campaign,null));
  assert.ok(due,'the callback becomes callable after its scheduled time');
  assert.equal(due.contact_record_id,f.ledger.contact_record_id,'the callback retains the intended contact');
  assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS n FROM outbound_attempt_ledger WHERE campaign_id=$1',[f.campaign.id])).rows[0].n),2,'the callback creates one new attempt');
});

test('premium greeting before AMD drops a configured TTS message once and waits for actual hangup',async()=>{
  const f=await fixture('agentless_flow',{amd:true,amdConfig:{
    voicemailAction:'drop_message',
    voicemailMessage:'Test only',
    voicemail_tts:{voice:'Telnyx.Ultra.test-voice',language:'en-US'},
  }});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.answered');
  await event(f,'call.machine.premium.greeting.ended',{result:'beep_detected'});
  await event(f,'call.machine.premium.greeting.ended',{result:'beep_detected'});
  const voicemail=f.provider.calls.filter(c=>c.operation==='outbound_voicemail');
  assert.equal(voicemail.length,1);
  assert.deepEqual(voicemail[0].request,{
    payload:'Test only',
    voice:'Telnyx.Ultra.test-voice',
    language:'en-US',
  });
  await event(f,'call.speak.ended');
  assert.equal(await liveLines(f.ledger.id),1);
  await event(f,'call.hangup');
  assert.equal(await liveLines(f.ledger.id),0);
});

test('standard machine greeting not_sure still starts the configured voicemail action once',async()=>{
  const f=await fixture('predictive',{amd:true,amdConfig:{
    mode:'standard',
    machine_action:'leave_message',
    voicemail_message:'Standard mailbox test',
    voicemail_tts:{voice:'Telnyx.Ultra.standard-test',language:'en-US'},
  }});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.answered');
  await event(f,'call.machine.detection.ended',{result:'machine'});
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_voicemail').length,0);
  await event(f,'call.machine.greeting.ended',{result:'not_sure'});
  await event(f,'call.machine.greeting.ended',{result:'not_sure'});
  const voicemail=f.provider.calls.filter(c=>c.operation==='outbound_voicemail');
  assert.equal(voicemail.length,1);
  assert.deepEqual(voicemail[0].request,{
    payload:'Standard mailbox test',
    voice:'Telnyx.Ultra.standard-test',
    language:'en-US',
  });
});

test('agentless flow uses one Core work item for duplicate enqueue events',async()=>{
  const {applyClaimedAcdVoiceEvent}=await import('../lib/acd/live-intake.mjs');
  const f=await fixture('agentless_flow');
  await driveSaga(pool,f.sagaId,{provider:f.provider});await event(f,'call.answered');
  const session=(await pool.query(`SELECT provider_session_id FROM acd_work_items WHERE id=$1`,[f.workItemId])).rows[0].provider_session_id;
  const queued=()=>applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.enqueued',payload:{call_control_id:f.callId,call_session_id:session,queue:f.queueId}});
  await queued();await queued();
  const work=(await pool.query(`SELECT state FROM acd_work_items WHERE id=$1`,[f.workItemId])).rows[0];
  assert.equal(work.state,'offered');
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_work_items WHERE provider_session_id=$1`,[session])).rows[0].n,1);
});

for (const mode of ['preview','progressive','power','predictive']) test(`${mode}: queued inbound prevents a new customer dial`,async()=>{
  const f=await fixture(mode,{due:true});
  await tx(async t=>{
    const wi=await createWorkItem(t,{channel:'voice',direction:'inbound',queueId:f.queueId,engineOwner:'acd_core'});
    await applyTransition(t,{workItemId:wi.id,to:'queued',eventType:'fixture',actor:'test'});
  });
  if(mode==='preview') await requestOutboundDial(pool,{attemptId:f.ledger.id,agentId:f.agentId});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  assert.equal(f.provider.calls.length,0);
  assert.equal((await readSaga(f.sagaId)).state,'cancelled');
  assert.equal(await liveLines(f.ledger.id),0);
  if(['power','predictive'].includes(mode)) assert.equal(await claimAutonomousOutbound(pool,f.campaign.id),null);
});

test('an explicit 100 percent inbound reserve prevents outbound admission',async()=>{
  const {outboundBlendingBudget}=await import('../lib/acd/outbound-blending.mjs');
  const f=await fixture('power');
  await pool.query(`UPDATE outbound_campaigns SET metadata=metadata || '{"blending_config":{"inboundReservePercent":100}}' WHERE id=$1`,[f.campaign.id]);
  f.campaign=(await pool.query(`SELECT * FROM outbound_campaigns WHERE id=$1`,[f.campaign.id])).rows[0];
  assert.equal((await tx(t=>outboundBlendingBudget(t,f.campaign))).free,0);
  assert.equal(await claimAutonomousOutbound(pool,f.campaign.id),null);
});

for(const mode of ['power','predictive']) test(`${mode}: competing worker claims share the remaining agent budget`,async()=>{
  const f=await fixture(mode);
  await pool.query(`UPDATE outbound_campaigns SET pacing_config='{"ratio":1}' WHERE id=$1`,[f.campaign.id]);
  await pool.query(`INSERT INTO outbound_contact_records (contact_list_id,row_data,validation_status)
    SELECT $1,'{"phone":"+15550004444"}','valid' FROM generate_series(1,3)`,[f.campaign.contact_list_id]);
  const claims=await Promise.all([claimAutonomousOutbound(pool,f.campaign.id),claimAutonomousOutbound(pool,f.campaign.id)]);
  assert.equal(claims.filter(Boolean).length,1);
});

test('campaign scheduling advances beyond the batch limit across worker restarts',async()=>{
  const {tickOutboundVoice}=await import('../lib/acd/outbound-runtime.mjs');
  await pool.query(`UPDATE outbound_campaigns SET status='stopped'`);
  const a=await fixture('agentless_ai'),b=await fixture('agentless_flow');
  await tickOutboundVoice(pool,makeFakeProvider(),{limit:1,node:'first'});
  await tickOutboundVoice(pool,makeFakeProvider(),{limit:1,node:'restart'});
  const rows=await pool.query(`SELECT campaign_id FROM acd_outbound_schedule WHERE campaign_id=ANY($1::text[])`,[[a.campaign.id,b.campaign.id]]);
  assert.equal(rows.rowCount,2);
});

test('autonomous campaign scheduler mixes power predictive and agentless records by run-scoped priority',async()=>{
  await pool.query(`UPDATE outbound_campaigns SET status='stopped'`);
  await pool.query(`UPDATE outbound_settings SET settings=settings||'{"max_lines":20}'::jsonb WHERE id='default'`);
  const queueId=randomUUID();
  const agentIds=[];
  for(let index=0;index<18;index++){
    const agentId=randomUUID();agentIds.push(agentId);
    await seedAgent(pool,agentId);
  }
  await seedQueue(pool,queueId,agentIds,{engineOwner:'acd_core'});
  const definitions=[
    {name:'Priority 5 Power',mode:'power',priority:5,handlerType:'queue',handlerRef:queueId},
    {name:'Priority 3 Predictive',mode:'predictive',priority:3,handlerType:'queue',handlerRef:queueId},
    {name:'Priority 1 Flow',mode:'agentless_flow',priority:1,handlerType:'call_flow',handlerRef:randomUUID()},
  ];
  const campaigns=[];
  for(const definition of definitions){
    const list=(await pool.query(`INSERT INTO outbound_contact_lists(name) VALUES($1) RETURNING id`,[definition.name])).rows[0];
    const campaign=(await pool.query(`INSERT INTO outbound_campaigns(name,status,mode,channel,handler_type,handler_ref,contact_list_id,pacing_config,metadata)
      VALUES($1,'running',$2,'voice',$3,$4,$5,'{"ratio":1}'::jsonb,$6::jsonb) RETURNING *`,
    [definition.name,definition.mode,definition.handlerType,definition.handlerRef,list.id,{agent_priority:definition.priority,from_numbers:['+15550001111']}])).rows[0];
    await pool.query(`INSERT INTO outbound_contact_records(contact_list_id,row_data,validation_status)
      SELECT $1,jsonb_build_object('phone','+1555'||lpad(series::text,7,'0')),'valid' FROM generate_series(1,18) series`,[list.id]);
    campaigns.push(campaign);
  }
  const delivered={};
  for(let index=0;index<18;index++){
    const claim=await claimNextAutonomousOutbound(pool);
    assert.ok(claim,`weighted scheduler stopped after ${index} records`);
    delivered[claim.campaignId]=(delivered[claim.campaignId]||0)+1;
  }
  assert.deepEqual(campaigns.map(campaign=>delivered[campaign.id]||0),[10,6,2]);
  const runs=await pool.query(`SELECT r.campaign_id,COUNT(l.id)::int AS served
    FROM outbound_campaign_runs r JOIN outbound_attempt_ledger l ON l.run_id=r.id
    WHERE r.campaign_id=ANY($1::uuid[]) AND r.status='running' GROUP BY r.campaign_id`,[campaigns.map(campaign=>campaign.id)]);
  assert.deepEqual(Object.fromEntries(runs.rows.map(row=>[row.campaign_id,row.served])),Object.fromEntries(campaigns.map((campaign,index)=>[campaign.id,[10,6,2][index]])));
});

test('agent campaign scheduler mixes preview and progressive records globally across agents',async()=>{
  await pool.query(`UPDATE outbound_campaigns SET status='stopped'`);
  const queueId=randomUUID(),agents=[];
  for(let index=0;index<9;index++){
    const id=randomUUID(),username=`${id}@test.local`;agents.push({id,username});
    await seedAgent(pool,id,{username});
  }
  await seedQueue(pool,queueId,agents.map(agent=>agent.id),{engineOwner:'acd_core'});
  const definitions=[
    {name:'Priority 5 Preview',mode:'preview',priority:5},
    {name:'Priority 3 Progressive',mode:'progressive',priority:3},
    {name:'Priority 1 Preview',mode:'preview',priority:1},
  ],campaigns=[];
  for(const definition of definitions){
    const list=(await pool.query(`INSERT INTO outbound_contact_lists(name) VALUES($1) RETURNING id`,[definition.name])).rows[0];
    const campaign=(await pool.query(`INSERT INTO outbound_campaigns(name,status,mode,channel,handler_type,handler_ref,contact_list_id,metadata)
      VALUES($1,'running',$2,'voice','queue',$3,$4,$5::jsonb) RETURNING *`,
    [definition.name,definition.mode,queueId,list.id,{agent_priority:definition.priority,from_numbers:['+15550001111']}])).rows[0];
    await pool.query(`INSERT INTO outbound_contact_records(contact_list_id,row_data,validation_status)
      SELECT $1,jsonb_build_object('phone','+1666'||lpad(series::text,7,'0')),'valid' FROM generate_series(1,9) series`,[list.id]);
    for(const agent of agents)await pool.query(`INSERT INTO outbound_campaign_agent_assignments(campaign_id,agent_username) VALUES($1,$2)`,[campaign.id,agent.username]);
    campaigns.push(campaign);
  }
  const delivered={};
  for(const agent of agents){
    const claim=await claimNextAgentCampaignRecord(pool,agent.username);
    assert.ok(claim);
    delivered[claim.campaign_id]=(delivered[claim.campaign_id]||0)+1;
  }
  assert.deepEqual(campaigns.map(campaign=>delivered[campaign.id]||0),[5,3,1]);
  const runCounts=await pool.query(`SELECT r.campaign_id,COUNT(l.id)::int AS served
    FROM outbound_campaign_runs r JOIN outbound_attempt_ledger l ON l.run_id=r.id
    WHERE r.campaign_id=ANY($1::uuid[]) AND r.status='running' GROUP BY r.campaign_id`,[campaigns.map(campaign=>campaign.id)]);
  assert.deepEqual(Object.fromEntries(runCounts.rows.map(row=>[row.campaign_id,row.served])),Object.fromEntries(campaigns.map((campaign,index)=>[campaign.id,[5,3,1][index]])));
});

test('preview agent rejection cancels before any customer origination',async()=>{
  const {applyClaimedAcdVoiceEvent}=await import('../lib/acd/live-intake.mjs');
  const f=await fixture('preview');
  await requestOutboundDial(pool,{attemptId:f.ledger.id,agentId:f.agentId});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  const connect=(await pool.query(`SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='connect'`,[f.workItemId])).rows[0];
  await driveSaga(pool,connect.id,{provider:f.provider});
  const device=`device:${randomUUID()}`;
  const payload={call_control_id:device,direction:'incoming',custom_headers:[{name:'X-CC-Work-Item-Id',value:f.workItemId},{name:'X-CC-Offer-Generation',value:'1'}]};
  await applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.initiated',payload});
  await applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.hangup',payload});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  assert.equal(f.provider.calls.filter(c=>c.operation==='enqueue_customer_leg').length,0);
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_hangup').length,0);
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_dial').length,0);
  assert.equal(await liveLines(f.ledger.id),0);
  assert.equal((await pool.query(`SELECT workflow_state FROM acd_agent_state WHERE agent_id=$1`,[f.agentId])).rows[0].workflow_state,'idle');
});

test('provider rejection releases the line and schedules retry instead of repeatedly dialing',async()=>{
  const {claimOneAgentlessRecord}=await import('../lib/outbound-dialer/execution.js');
  const f=await fixture('agentless_ai');f.provider=makeFakeProvider([{outcome:'failed',httpStatus:422}]);
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  const ledger=(await pool.query(`SELECT * FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.equal(ledger.status,'failed');assert.equal(ledger.dial_state,'failed');
  assert.ok(Date.parse(ledger.metadata.next_retry_at)>Date.now());
  assert.equal(await liveLines(f.ledger.id),0);
  assert.equal(await tx(t=>claimOneAgentlessRecord(t,f.campaign)),null);
});

test('retry waits for its interval, admits once under concurrency and stops at the maximum attempt count',async()=>{
  const f=await fixture('agentless_ai');
  await pool.query(`UPDATE outbound_campaigns SET retry_policy='{"maxAttempts":2,"minDelayHours":0.00028}'::jsonb WHERE id=$1`,[f.campaign.id]);
  f.provider=makeFakeProvider([{outcome:'failed',httpStatus:422}]);
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  const first=(await pool.query('SELECT * FROM outbound_attempt_ledger WHERE id=$1',[f.ledger.id])).rows[0];
  assert.equal(first.status,'failed');
  assert.ok(Date.parse(first.metadata.next_retry_at)>Date.now());
  const early=await Promise.all([claimAutonomousOutbound(pool,f.campaign.id),claimAutonomousOutbound(pool,f.campaign.id)]);
  assert.equal(early.filter(Boolean).length,0,'the configured retry interval blocks every worker');

  await pool.query(`UPDATE outbound_attempt_ledger SET metadata=jsonb_set(metadata,'{next_retry_at}',to_jsonb((now()-interval '1 second')::text)) WHERE id=$1`,[f.ledger.id]);
  const due=await Promise.all([claimAutonomousOutbound(pool,f.campaign.id),claimAutonomousOutbound(pool,f.campaign.id)]);
  assert.equal(due.filter(Boolean).length,1,'concurrent workers admit exactly one retry for the contact');
  const retry=due.find(Boolean);
  assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS n FROM outbound_attempt_ledger WHERE campaign_id=$1',[f.campaign.id])).rows[0].n),2);
  await driveSaga(pool,retry.sagaId,{provider:makeFakeProvider([{outcome:'failed',httpStatus:422}])});
  const second=(await pool.query('SELECT * FROM outbound_attempt_ledger WHERE id=$1',[retry.attemptId])).rows[0];
  assert.equal(second.status,'failed');
  assert.equal(await liveLines(retry.attemptId),0);
  await pool.query(`UPDATE outbound_attempt_ledger SET metadata=jsonb_set(metadata,'{next_retry_at}',to_jsonb((now()-interval '1 second')::text)) WHERE campaign_id=$1`,[f.campaign.id]);
  const exhausted=await Promise.all([claimAutonomousOutbound(pool,f.campaign.id),claimAutonomousOutbound(pool,f.campaign.id)]);
  assert.equal(exhausted.filter(Boolean).length,0,'maximum attempts prevent a third Dial under concurrency');
  assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS n FROM outbound_attempt_ledger WHERE campaign_id=$1',[f.campaign.id])).rows[0].n),2);
});

for(const resource of ['dnc_list_id','time_set_id','filter_id']) test(`configured missing ${resource} cannot be bypassed`,async()=>{
  const f=await fixture('agentless_ai');
  await pool.query(`UPDATE outbound_campaigns SET metadata=metadata || $2::jsonb WHERE id=$1`,[f.campaign.id,JSON.stringify({[resource]:randomUUID()})]);
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  assert.equal(f.provider.calls.length,0);assert.equal(await liveLines(f.ledger.id),0);
  const row=(await pool.query(`SELECT metadata FROM outbound_attempt_ledger WHERE id=$1`,[f.ledger.id])).rows[0];
  assert.equal(row.metadata.failure_reason,'campaign_resource_unavailable');
});

test('configured outbound duration is carried into the durable provider Dial command', async () => {
  const f=await fixture('agentless_ai');
  await pool.query(`UPDATE outbound_campaigns SET pacing_config=pacing_config||'{"maxCallDurationSecs":180}'::jsonb WHERE id=$1`,[f.campaign.id]);
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  assert.equal(f.provider.calls.find(c=>c.operation==='outbound_dial').request.time_limit_secs,180);
  await event(f,'call.hangup');
});

 test('attached campaign form follows the Core work through connection projection', async () => {
  const formId = randomUUID();
  const f = await fixture('preview', { formId });
  const work = (await pool.query('SELECT attributes FROM acd_work_items WHERE id=$1', [f.workItemId])).rows[0];
  assert.deepEqual(work.attributes.agent_assist_config.form_ids, [formId]);
  assert.equal(work.attributes.agent_assist_config.auto_open_forms, true);
  assert.equal(work.attributes.agent_assist_config.source, 'outbound_campaign');
});

for(const mode of ['preview','progressive']) test(`${mode}: answered agent precedes customer Dial and bridge, including replay`,async()=>{
  const f=await fixture(mode,{due:true});
  if(mode==='preview')await requestOutboundDial(pool,{attemptId:f.ledger.id,agentId:f.agentId});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  assert.equal(f.provider.calls.length,0);
  const pre=await answerPreDialAgent(f);
  assert.deepEqual(f.provider.calls.map(c=>c.operation),['outbound_agent_dial','outbound_dial']);
  assert.match(f.provider.calls[0].request.to,/^sip:/);
  assert.equal(f.provider.calls[0].request.connection_id,'test-connection');
  assert.equal(f.provider.calls[0].request.from,'+15550001111');
  await driveSaga(pool,pre.connect.id,{provider:f.provider,node:'restart'});
  await driveSaga(pool,f.sagaId,{provider:f.provider,node:'restart'});
  assert.equal(f.provider.calls.length,2);
  await event(f,'call.answered');
  await driveSaga(pool,pre.connect.id,{provider:f.provider});
  assert.equal(f.provider.calls.at(-1).operation,'outbound_agent_bridge');
  assert.equal(f.provider.calls.at(-1).request.call_control_id,`transport:${f.ledger.id}`);
  assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[f.workItemId])).rows[0].state,'offered','bridge ACK alone must not establish conversation');
  await event(f,'call.bridged');
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[f.workItemId])).rows[0].state,'active');
  await event(f,'call.hangup');await pre.agentEvent('call.hangup');
});

for(const mode of ['power','predictive']) test(`${mode}: answered customer uses a separate answered agent leg and one explicit bridge`,async()=>{
  const f=await fixture(mode,{due:true});
  const {connect,agentEvent}=await connectHuman(f);
  const operations=f.provider.calls.map(call=>call.operation);
  assert.ok(operations.indexOf('outbound_dial') < operations.indexOf('outbound_agent_dial'));
  assert.ok(operations.indexOf('outbound_agent_dial') < operations.indexOf('outbound_agent_bridge'));
  assert.equal(operations.includes('transfer_to_agent'),false);
  assert.equal(operations.filter(operation=>operation==='outbound_agent_bridge').length,1);
  await driveSaga(pool,connect.id,{provider:f.provider,node:'restart'});
  assert.equal(f.provider.calls.filter(call=>call.operation==='outbound_agent_bridge').length,1,'bridge replay must not send a duplicate command');
  await event(f,'call.hangup');
  await agentEvent('call.hangup');
});

for(const mode of ['power','predictive']) test(`${mode}: pause drains an answered customer through the reserved agent`,async()=>{
  const {routeAndConnect,applyClaimedAcdVoiceEvent}=await import('../lib/acd/live-intake.mjs');
  const f=await fixture(mode,{due:true});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.answered');
  await pool.query("UPDATE outbound_campaigns SET status='paused' WHERE id=$1",[f.campaign.id]);
  await routeAndConnect(pool,f.provider,f.workItemId);
  const connect=(await pool.query("SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='connect'",[f.workItemId])).rows[0];
  assert.ok(connect);
  await driveSaga(pool,connect.id,{provider:f.provider});
  assert.equal(f.provider.calls.filter(call=>call.operation==='outbound_agent_dial').length,1,'pause must not cancel a customer who already answered');
  const payload={call_control_id:`device:${randomUUID()}`,direction:'incoming',custom_headers:[
    {name:'X-CC-Work-Item-Id',value:f.workItemId},{name:'X-CC-Offer-Generation',value:String(connect.data.generation)},
  ]};
  await applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.initiated',payload});
  await applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.answered',payload});
  await event(f,'call.bridged');
  assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[f.workItemId])).rows[0].state,'active');
  await event(f,'call.hangup');
  await applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.hangup',payload});
});

test('power: connection deadline cancels the child before a late agent answer can bridge',async()=>{
  const {routeAndConnect,applyClaimedAcdVoiceEvent}=await import('../lib/acd/live-intake.mjs');
  const f=await fixture('power',{due:true});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.answered');
  await routeAndConnect(pool,f.provider,f.workItemId);
  const child=(await pool.query("SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='connect'",[f.workItemId])).rows[0];
  assert.ok(child);
  await driveSaga(pool,child.id,{provider:f.provider});
  await pool.query("UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1",[f.sagaId]);
  await sweepDueSagas(pool,{provider:f.provider,limit:100});
  assert.equal(f.provider.calls.filter(call=>call.operation==='outbound_abandon_announcement').length,1);
  assert.equal(f.provider.calls.filter(call=>call.operation==='outbound_hangup').length,0);
  assert.equal((await readSaga(child.id)).data.cancelRequested,true);
  const payload={call_control_id:`device:${randomUUID()}`,direction:'incoming',custom_headers:[
    {name:'X-CC-Work-Item-Id',value:f.workItemId},{name:'X-CC-Offer-Generation',value:String(child.data.generation)},
  ]};
  await applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.initiated',payload});
  await applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.answered',payload});
  assert.equal(f.provider.calls.filter(call=>call.operation==='outbound_agent_bridge').length,0);
  await event(f,'call.speak.started');
  await event(f,'call.speak.ended');
  assert.equal(f.provider.calls.filter(call=>call.operation==='outbound_hangup').length,1);
  await event(f,'call.hangup');
  await applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.hangup',payload});
});

test('power: answered customer without an agent hears the global announcement and receives retry suppression',async()=>{
  await pool.query(`UPDATE outbound_settings SET settings=settings || $1::jsonb WHERE id='default'`,[JSON.stringify({answered_without_agent_policy:{
    mode:'announce_and_hangup',max_agent_connect_seconds:0.2,announcement_start_deadline_ms:500,
    max_announcement_seconds:8,max_abandon_rate_percent:3,abandon_rate_window_hours:24,
    retry_suppression_hours:72,announcement_message:'No advisor is available. Goodbye.',
    announcement_voice:'Telnyx.Ultra.test',announcement_language:'en-US',
  }})]);
  const f=await fixture('power',{due:true});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  await event(f,'call.answered');
  assert.equal((await readSaga(f.sagaId)).step,'wait_connection');
  await pool.query("UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1",[f.sagaId]);
  await sweepDueSagas(pool,{provider:f.provider,limit:100});
  assert.equal(f.provider.calls.filter(call=>call.operation==='outbound_abandon_announcement').length,1);
  assert.equal(f.provider.calls.filter(call=>call.operation==='outbound_hangup').length,0);
  await event(f,'call.speak.started');
  await event(f,'call.speak.ended');
  assert.equal(f.provider.calls.filter(call=>call.operation==='outbound_hangup').length,1);
  await event(f,'call.hangup');
  const ledger=(await pool.query('SELECT * FROM outbound_attempt_ledger WHERE id=$1',[f.ledger.id])).rows[0];
  assert.equal(ledger.dial_state,'abandoned');
  assert.equal(ledger.metadata.reason_code,'no_agent_available');
  assert.ok(Date.parse(ledger.metadata.next_retry_at)>Date.now()+71*3600000);
  assert.ok(ledger.metadata.announcement_started_at);
  assert.ok(ledger.metadata.announcement_ended_at);
  assert.equal(await liveLines(f.ledger.id),0);
  await pool.query(`UPDATE outbound_settings SET settings=settings || $1::jsonb WHERE id='default'`,[JSON.stringify({answered_without_agent_policy:{
    mode:'announce_and_hangup',max_agent_connect_seconds:2,announcement_start_deadline_ms:500,
    max_announcement_seconds:8,max_abandon_rate_percent:3,abandon_rate_window_hours:24,
    retry_suppression_hours:72,
  }})]);
});

test('power: global abandonment-rate guard blocks new customer-first claims',async()=>{
  const f=await fixture('power',{due:true});
  await pool.query(`UPDATE outbound_attempt_ledger SET status='completed',metadata=metadata || '{"human_answered_at":"2026-09-07T00:00:00Z","abandoned_at":"2026-09-07T00:00:01Z"}'::jsonb WHERE id=$1`,[f.ledger.id]);
  await pool.query(`UPDATE outbound_attempt_ledger SET created_at=now() WHERE id=$1`,[f.ledger.id]);
  const result=await claimAutonomousOutbound(pool,f.campaign.id);
  assert.equal(result,null);
  const campaign=(await pool.query('SELECT metadata FROM outbound_campaigns WHERE id=$1',[f.campaign.id])).rows[0];
  assert.equal(campaign.metadata.answered_without_agent_guard.blocked,true);
  assert.equal(Number(campaign.metadata.answered_without_agent_guard.rate_percent),100);
});

for(const reason of ['paused','offline','cancelled']) test(`agent-first ${reason} after agent answer blocks customer command`,async()=>{
  const {applyClaimedAcdVoiceEvent}=await import('../lib/acd/live-intake.mjs');
  const f=await fixture('progressive',{due:true});await driveSaga(pool,f.sagaId,{provider:f.provider});
  const child=(await pool.query("SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='connect'",[f.workItemId])).rows[0];
  await driveSaga(pool,child.id,{provider:f.provider});
  const payload={call_control_id:`device:${randomUUID()}`,direction:'incoming',custom_headers:[{name:'X-CC-Work-Item-Id',value:f.workItemId},{name:'X-CC-Offer-Generation',value:'1'}]};
  for(const eventType of ['call.initiated','call.answered'])await applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType,payload});
  if(reason==='paused')await pool.query("UPDATE outbound_campaigns SET status='paused' WHERE id=$1",[f.campaign.id]);
  if(reason==='offline')await pool.query("UPDATE acd_agent_sessions SET expires_at=now()-interval '1 second' WHERE agent_id=$1",[f.agentId]);
  if(reason==='cancelled')await pool.query("UPDATE acd_sagas SET data=data || '{\"cancelRequested\":true}'::jsonb WHERE id=$1",[f.sagaId]);
  await driveSaga(pool,f.sagaId,{provider:f.provider});await driveSaga(pool,child.id,{provider:f.provider});
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_dial').length,0);
  assert.equal((await readSaga(f.sagaId)).state,'cancelled');
  assert.equal(await liveLines(f.ledger.id),0);
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:f.agentId})),null,'answered agent media must be cleaned before capacity release');
  await applyClaimedAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.hangup',payload});
});

test('agent disconnect while customer is ringing cancels the customer and never bridges',async()=>{
  const f=await fixture('progressive',{due:true});await driveSaga(pool,f.sagaId,{provider:f.provider});
  const pre=await answerPreDialAgent(f);await pre.agentEvent('call.hangup');
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_hangup').length,1);
  assert.equal(f.provider.calls.filter(c=>c.operation==='outbound_agent_bridge').length,0);
  assert.equal(await liveLines(f.ledger.id),1,'hangup ACK does not release live customer');
  await event(f,'call.hangup');assert.equal(await liveLines(f.ledger.id),0);
});

test('agent answer timeout cancels its leg without dialing a customer or freeing unconfirmed media',async()=>{
  const f=await fixture('progressive',{due:true});await driveSaga(pool,f.sagaId,{provider:f.provider});
  const child=(await pool.query("SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='connect'",[f.workItemId])).rows[0];
  await driveSaga(pool,child.id,{provider:f.provider});
  await pool.query("UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1",[child.id]);
  await sweepDueSagas(pool,{provider:f.provider,limit:100});
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  const ownCommands=(await pool.query(`SELECT operation FROM acd_commands
    WHERE saga_id=ANY($1::uuid[])`,[[f.sagaId,child.id]])).rows.map(row=>row.operation);
  assert.equal(ownCommands.filter(operation=>operation==='outbound_dial').length,0);
  assert.equal(ownCommands.filter(operation=>operation==='hangup_agent_leg').length,1);
  assert.equal((await readSaga(f.sagaId)).state,'cancelled');
  assert.equal(await liveLines(f.ledger.id),0);
  assert.equal(await tx(t=>tryReserveCapacity(t,{agentId:f.agentId})),null,'transport hangup acceptance is not device end evidence');
  const {admitAcdVoiceEvent}=await import('../lib/acd/admission.mjs');
  const ended={eventId:randomUUID(),eventType:'call.hangup',payload:{call_control_id:`transport:${f.ledger.id}`,hangup_cause:'originator_cancel'}};
  await admitAcdVoiceEvent(pool,ended);
  const {drainInboxOnce}=await import('../lib/acd/worker.mjs');
  await drainInboxOnce(pool,f.provider,{limit:100});
  const cleanup=(await pool.query("SELECT id FROM acd_sagas WHERE work_item_id=$1 AND type='reservation_cleanup'",[f.workItemId])).rows[0];
  await driveSaga(pool,cleanup.id,{provider:f.provider});
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE work_item_id=$1',[f.workItemId])).rows[0].state,'released','signed unanswered Dial end completes cleanup');
});

for(const outcome of ['failed','ambiguous']) test(`agent origination ${outcome} never dials a customer`,async()=>{
  const f=await fixture('progressive',{due:true});f.provider=makeFakeProvider([{outcome,httpStatus:outcome==='failed'?422:503}]);
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  const child=(await pool.query("SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='connect'",[f.workItemId])).rows[0];
  await driveSaga(pool,child.id,{provider:f.provider});
  if(outcome==='ambiguous'){
    await pool.query("UPDATE acd_commands SET created_at=now()-interval '2 minutes' WHERE saga_id=$1",[child.id]);
    await driveSaga(pool,child.id,{provider:f.provider,node:'restart'});
    assert.equal(f.provider.calls.length,1,'ambiguous origination cannot be reissued outside dedupe window');
    await pool.query("UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1",[child.id]);
    await sweepDueSagas(pool,{provider:f.provider,limit:100});
  }
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  // The deadline sweeper can legitimately drive older fixtures too.
  assert.equal((await pool.query("SELECT 1 FROM acd_commands WHERE saga_id=$1 AND operation='outbound_dial'",[f.sagaId])).rowCount,0);
  assert.equal((await readSaga(f.sagaId)).state,'cancelled');
  const state=(await pool.query('SELECT state FROM acd_reservations WHERE work_item_id=$1',[f.workItemId])).rows[0].state;
  assert.equal(state==='released',outcome==='failed','unknown media retains reservation');
});

test('dashboard retains answered and connected outcomes after completed disposition',async()=>{
  const {DASHBOARD_SUMMARY_SQL}=await import('../lib/outbound-dialer/dashboard-summary.mjs');
  const f=await fixture('progressive',{due:true});const pre=await connectHuman(f);
  await event(f,'call.hangup');await pre.agentEvent('call.hangup');
  await pool.query("UPDATE outbound_attempt_ledger SET status='completed',dial_state='disposed' WHERE id=$1",[f.ledger.id]);
  const row=(await pool.query(DASHBOARD_SUMMARY_SQL,[[f.campaign.id]])).rows[0];
  assert.equal(row.attempts_total,1);assert.equal(row.answered_total,1);assert.equal(row.connected_total,1);assert.equal(row.connected_records,1);assert.equal(row.active_now,0);
  await pool.query("UPDATE outbound_attempt_ledger SET metadata=metadata-'answered_at'-'connected_at' WHERE id=$1",[f.ledger.id]);
  const fromLegs=(await pool.query(DASHBOARD_SUMMARY_SQL,[[f.campaign.id]])).rows[0];
  assert.equal(fromLegs.answered_total,1);assert.equal(fromLegs.connected_records,1);
});

test('dashboard distinguishes answered without bridge and unanswered completed attempts',async()=>{
  const {DASHBOARD_SUMMARY_SQL}=await import('../lib/outbound-dialer/dashboard-summary.mjs');
  const f=await fixture('agentless_flow');await driveSaga(pool,f.sagaId,{provider:f.provider});await event(f,'call.answered');await event(f,'call.hangup');
  const row=(await pool.query(DASHBOARD_SUMMARY_SQL,[[f.campaign.id]])).rows[0];
  assert.equal(row.answered_total,1);assert.equal(row.connected_total,0);assert.equal(row.connected_records,0);
  const n=await fixture('agentless_flow');await driveSaga(pool,n.sagaId,{provider:n.provider});await event(n,'call.hangup');
  const missed=(await pool.query(DASHBOARD_SUMMARY_SQL,[[n.campaign.id]])).rows[0];assert.equal(missed.answered_total,0);assert.equal(missed.connected_records,0);
});

test('dashboard excludes cancelled-before-dial assignments until telephone origination starts',async()=>{
  const {DASHBOARD_SUMMARY_SQL}=await import('../lib/outbound-dialer/dashboard-summary.mjs');
  const f=await fixture('preview');
  await pool.query(`UPDATE outbound_attempt_ledger
    SET status='cancelled', dial_state='cancelled', metadata=metadata || '{"cancel_reason":"cancelled_before_dial"}'::jsonb
    WHERE id=$1`,[f.ledger.id]);
  const beforeDial=(await pool.query(DASHBOARD_SUMMARY_SQL,[[f.campaign.id]])).rows[0];
  assert.equal(beforeDial.attempts_total,0);
  assert.equal(beforeDial.attempts_last_15m,0);
  assert.equal(beforeDial.hangups_total,0);
  assert.equal(beforeDial.processed_records,0);
  assert.equal(beforeDial.last_attempt_at,null);

  await pool.query(`UPDATE outbound_attempt_ledger
    SET metadata=metadata || jsonb_build_object('dial_started_at',now()::text)
    WHERE id=$1`,[f.ledger.id]);
  const afterDial=(await pool.query(DASHBOARD_SUMMARY_SQL,[[f.campaign.id]])).rows[0];
  assert.equal(afterDial.attempts_total,1);
  assert.equal(afterDial.attempts_last_15m,1);
  assert.equal(afterDial.hangups_total,1);
  assert.equal(afterDial.processed_records,1);
  assert.ok(afterDial.last_attempt_at);
});

async function blendingFixture() {
  const f=await fixture('power');
  const second=randomUUID(); await seedAgent(pool,second);
  await pool.query('INSERT INTO cc_queue_user_assignments(queue_id,user_id,priority) VALUES($1,$2,0)',[f.queueId,second]);
  return {...f,second};
}
async function inboundFor(f,requiredSkills={}) {
  return tx(async t=>{const w=await createWorkItem(t,{channel:'voice',direction:'inbound',queueId:f.queueId,engineOwner:'acd_core',requiredSkills});await applyTransition(t,{workItemId:w.id,to:'queued',eventType:'fixture',actor:'test'});return w;});
}
async function budgetFor(f,options) {const {outboundBlendingBudget}=await import('../lib/acd/outbound-blending.mjs');return tx(t=>outboundBlendingBudget(t,f.campaign,options));}

test('dynamic blending: two agents reserve one for one inbound and both for two',async()=>{
  const f=await blendingFixture();await inboundFor(f);assert.equal((await budgetFor(f)).free,1);await inboundFor(f);assert.equal((await budgetFor(f)).free,0);
});
test('agent campaigns preserve capacity for a ringing Power or Predictive customer',async()=>{
  const f=await blendingFixture();
  await driveSaga(pool,f.sagaId,{provider:f.provider});
  const campaign={...f.campaign,mode:'preview'};
  const first=await tx(t=>import('../lib/acd/outbound-blending.mjs').then(({outboundBlendingBudget})=>outboundBlendingBudget(t,campaign,{protectAutonomousDemand:true})));
  assert.equal(first.autonomousDebt,1);
  assert.equal(first.free,1);
  assert.equal(first.autonomousProtectedAgentIds.length,1);
  const protectedId=first.autonomousProtectedAgentIds[0];
  const availableId=[f.agentId,f.second].find(id=>id!==protectedId);
  const denied=await tx(t=>import('../lib/acd/outbound-blending.mjs').then(({outboundBlendingBudget})=>outboundBlendingBudget(t,campaign,{agentId:protectedId,protectAutonomousDemand:true})));
  assert.equal(denied.agentEligible,false);
  const previewWork=await tx(t=>createWorkItem(t,{channel:'voice',direction:'outbound',queueId:f.queueId,engineOwner:'acd_core'}));
  const reservationId=await tx(t=>tryReserveCapacity(t,{agentId:availableId,workItemId:previewWork.id,purpose:'outbound'}));
  const own=await tx(t=>import('../lib/acd/outbound-blending.mjs').then(({outboundBlendingBudget})=>outboundBlendingBudget(t,campaign,{agentId:availableId,reservationId,protectAutonomousDemand:true})));
  assert.equal(own.agentEligible,true);
  assert.equal(own.free,1);
});
test('dynamic blending protects the only skilled agent and leaves the other for outbound',async()=>{
  const f=await blendingFixture(),skill=randomUUID();await pool.query('INSERT INTO skills(id,name) VALUES($1,$1)',[skill]);
  await pool.query("UPDATE cc_queues SET routing_strategy='Skill-based' WHERE id=$1",[f.queueId]);
  await pool.query('UPDATE users SET skills=$2 WHERE id=$1',[f.agentId,{[skill]:5}]);
  await inboundFor(f,{[skill]:5});
  const b=await budgetFor(f);assert.equal(b.free,1);assert.ok(b.protectedAgentIds.includes(f.agentId));assert.equal((await budgetFor(f,{agentId:f.agentId})).agentEligible,false);
});
test('dynamic blending reuses skill relaxation and does not protect an ineligible agent early',async()=>{
  const f=await blendingFixture(),skill=randomUUID();await pool.query('INSERT INTO skills(id,name) VALUES($1,$1)',[skill]);
  await pool.query("UPDATE cc_queues SET routing_strategy='Skill-based',skill_relaxation_enabled=true,skill_relaxation_after_seconds=60,skill_relaxation_strategy='fallback' WHERE id=$1",[f.queueId]);
  await pool.query('UPDATE users SET skills=$2 WHERE id=$1',[f.agentId,{[skill]:3}]);const w=await inboundFor(f,{[skill]:5});
  assert.equal((await budgetFor(f)).free,2);await pool.query("UPDATE acd_work_items SET enqueued_at=now()-interval '70 seconds' WHERE id=$1",[w.id]);assert.equal((await budgetFor(f)).free,1);
});
test('global strict protection cannot be weakened by campaign dynamic setting',async()=>{
  const f=await blendingFixture();await inboundFor(f);await pool.query(`UPDATE outbound_settings SET settings=settings || '{"blending":{"mode":"pause_when_inbound_queued"}}' WHERE id='default'`);
  try{assert.equal((await budgetFor(f)).free,0);}finally{await pool.query("UPDATE outbound_settings SET settings=settings-'blending' WHERE id='default'");}
});
for(const mode of ['preview','progressive'])test(`${mode} yields its record to inbound without consuming the telephone attempt allowance`,async()=>{
  const f=await fixture(mode);
  const later=(await pool.query(`INSERT INTO outbound_contact_records(contact_list_id,row_data,validation_status,created_at)
    VALUES($1,'{"phone":"+15550003333"}','valid',now()+interval '1 second') RETURNING id`,[f.campaign.contact_list_id])).rows[0];
  const w=await inboundFor(f);await driveSaga(pool,f.sagaId,{provider:f.provider});
  const old=(await pool.query('SELECT * FROM outbound_attempt_ledger WHERE id=$1',[f.ledger.id])).rows[0];assert.equal(old.status,'cancelled');assert.equal(old.metadata.blending_deferred,true);assert.equal(f.provider.calls.length,0);
  assert.equal((await pool.query('SELECT last_attempt_at FROM outbound_contact_records WHERE id=$1',[f.ledger.contact_record_id])).rows[0].last_attempt_at,null);
  await pool.query('UPDATE outbound_contact_records SET last_attempt_at=now() WHERE id=$1',[f.ledger.contact_record_id]);
  const {DASHBOARD_SUMMARY_SQL}=await import('../lib/outbound-dialer/dashboard-summary.mjs');const stats=(await pool.query(DASHBOARD_SUMMARY_SQL,[[f.campaign.id]])).rows[0];assert.equal(stats.processed_records,0);assert.equal(stats.attempts_total,0);
  await tx(t=>applyTransition(t,{workItemId:w.id,to:'abandoned',eventType:'fixture',actor:'test'}));
  const {claimOneAgentlessRecord}=await import('../lib/outbound-dialer/execution.js');
  const retry=await tx(t=>claimOneAgentlessRecord(t,{...f.campaign,retry_policy:{maxAttempts:1}}));assert.ok(retry);assert.equal(retry.contact_record_id,f.ledger.contact_record_id);
  assert.notEqual(retry.contact_record_id,later.id,'a deferred record remains first even when legacy data retains a stale last_attempt_at');
});
test('overlapping campaign queues share inbound protection',async()=>{
  const f=await blendingFixture(),other=randomUUID();await seedQueue(pool,other,[f.agentId],{engineOwner:'acd_core'});await inboundFor({...f,queueId:other});const b=await budgetFor(f);assert.equal(b.free,1);assert.ok(b.protectedAgentIds.includes(f.agentId));
});

test('global buffer protects spare agents even when a campaign requests zero reserve',async()=>{
  const f=await blendingFixture();await pool.query(`UPDATE outbound_settings SET settings=settings||'{"blending":{"reserve_agents":1}}' WHERE id='default'`);
  try{assert.equal((await budgetFor(f)).free,1);await inboundFor(f);assert.equal((await budgetFor(f)).free,0);}finally{await pool.query("UPDATE outbound_settings SET settings=settings-'blending' WHERE id='default'");}
});
test('inbound demand never interrupts an already connected outbound conversation',async()=>{
  const f=await fixture('preview');await connectHuman(f);await inboundFor(f);const sent=f.provider.calls.length;await driveSaga(pool,f.sagaId,{provider:f.provider});assert.equal(f.provider.calls.length,sent);assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[f.workItemId])).rows[0].state,'active');
});

for(const mode of ['power','predictive'])test(`${mode}: an answered customer cannot take the agent protected for inbound`,async()=>{
  const f=await fixture(mode);await driveSaga(pool,f.sagaId,{provider:f.provider});await inboundFor(f);await event(f,'call.answered');
  const {routeOne}=await import('../lib/acd/router.mjs');const routed=await routeOne(pool,f.workItemId);assert.equal(routed.routed,false);
  const reserved=(await pool.query("SELECT id FROM acd_reservations WHERE work_item_id=$1 AND state<>'released'",[f.workItemId])).rows;assert.equal(reserved.length,0);
});

for (const mode of ['agentless_ai', 'agentless_flow']) test(`${mode}: answered handler completion disposes the attempt without agent wrapup`, async () => {
  const f = await fixture(mode);
  await driveSaga(pool, f.sagaId, { provider: f.provider });
  await event(f, 'call.answered');
  await event(f, 'call.hangup', { hangup_cause: 'normal_clearing' });
  const read = async () => (await pool.query('SELECT status,dial_state,metadata FROM outbound_attempt_ledger WHERE id=$1', [f.ledger.id])).rows[0];
  const ended = await read();
  assert.equal(ended.status, 'completed');
  assert.equal(ended.dial_state, 'disposed');
  assert.equal(await liveLines(f.ledger.id), 0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM acd_reservations WHERE work_item_id=$1', [f.workItemId])).rows[0].n, 0);
  await event(f, 'call.hangup', { hangup_cause: 'normal_clearing' });
  await event(f, 'call.answered');
  const replayed = await read();
  assert.equal(replayed.dial_state, 'disposed');
  assert.deepEqual(replayed.metadata.dial_state_history, ended.metadata.dial_state_history);
});

for (const amd of [false, true]) test(`agentless Flow replay forwards continuations after admission (AMD=${amd})`, async () => {
  const f = await fixture('agentless_flow', { amd });
  await driveSaga(pool, f.sagaId, { provider: f.provider });
  const answered = await event(f, 'call.answered');
  if (amd) {
    assert.equal(answered.skipAdapterEffects, true);
    assert.equal((await event(f, 'call.gather.ended', { digits: '7', status: 'valid' })).adapterEventType, null);
    const detected = await event(f, 'call.machine.premium.detection.ended', { result: 'human_residence' });
    assert.equal(detected.adapterEventType, 'call.answered');
  } else assert.equal(answered.adapterEventType, 'call.answered');
  for (const type of ['call.dtmf.received', 'call.gather.ended', 'call.speak.started', 'call.speak.ended']) {
    const continuation = await event(f, type, { digits: '7', status: 'valid' });
    assert.equal(continuation.skipAdapterEffects, false);
    assert.equal(continuation.adapterEventType, type, 'the verified adapter must receive the actual continuation event');
  }
  const duplicateAnswer = await event(f, 'call.answered');
  assert.equal(duplicateAnswer.skipAdapterEffects, true);
  assert.equal(duplicateAnswer.adapterEventType, null);
  await event(f, 'call.hangup');
  for (const type of ['call.gather.ended', 'call.speak.ended', 'call.answered']) {
    assert.equal((await event(f, type, { digits: '7' })).adapterEventType, null, 'ended Flow must not resume');
  }
  assert.equal(await liveLines(f.ledger.id), 0);
});

test('AI media events do not gain ordinary Flow execution permission', async () => {
  const f = await fixture('agentless_ai');
  await driveSaga(pool, f.sagaId, { provider: f.provider });
  await event(f, 'call.answered');
  for (const type of ['call.gather.ended', 'call.speak.ended']) {
    assert.equal((await event(f, type)).adapterEventType, null);
  }
  await event(f, 'call.hangup');
});
