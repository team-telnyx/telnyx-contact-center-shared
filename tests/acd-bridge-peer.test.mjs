import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, seedAgent, seedQueue, makeFakeProvider } from './helpers/acd-test-db.mjs';
import { routeAcdVoiceEvent } from '../lib/acd/live-intake.mjs';
import { agentBridgeEvidence, loadVoiceBridgeTopology } from '../lib/acd/voice-bridge-evidence.mjs';

const pool=await prepareAcdTestPool('acd_core_test_bridge_peer');
const skip=!pool;
after(async()=>{await pool?.end();});
async function fixture(){
  const work=randomUUID(),agent=randomUUID(),queue=randomUUID(),saga=randomUUID(),intent=randomUUID();
  const session=randomUUID(),transport=randomUUID(),device=randomUUID(),customer=randomUUID();
  await seedAgent(pool,agent,{workflowState:'handling'});await seedQueue(pool,queue,[agent]);
  await pool.query(`INSERT INTO acd_work_items(id,channel,direction,state,queue_id,provider_session_id)
    VALUES ($1,'voice','inbound','active',$2,$3)`,[work,queue,session]);
  for(const [id,role,agentId] of [[customer,'customer',null],[transport,'agent_transport',null],[device,'agent_device',agent]]){
    await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,provider_session_id,owner_saga_id,
      offer_generation,state,answered_at,agent_id) VALUES ($1,$2,$3,$4,$5,$6,1,'answered',now(),$7)`,
    [id,work,role,`v3:${id}`,session,saga,agentId]);
  }
  await pool.query(`INSERT INTO acd_leg_intents(id,work_item_id,agent_id,offer_generation,expected_role,command_id,state,transport_call_id,bound_leg_id,deadline_at)
    VALUES ($1::uuid,$2,$3,1,'agent_device',$1::uuid::text,'bound',$4,$5,now()+interval '30 seconds')`,[intent,work,agent,`v3:${transport}`,device]);
  const event={eventId:randomUUID(),eventType:'call.bridged',occurredAt:new Date().toISOString(),
    payload:{call_control_id:`v3:${customer}`,call_session_id:session,bridged_call_control_id:`v3:${transport}`}};
  return {work,agent,transport,device,customer,event,provider:makeFakeProvider()};
}
async function proof(f){const t=await loadVoiceBridgeTopology(pool,f.work);return agentBridgeEvidence(t.legs,t.intents,f.agent,{live:true});}

test('original customer event persists exact peer proof while transport webhook is absent',{skip},async()=>{
  const f=await fixture();assert.equal(await proof(f),null);
  await routeAcdVoiceEvent(pool,f.provider,f.event);
  const evidence=await proof(f);assert.equal(evidence.source,'customer_bridge_peer');assert.equal(evidence.eventId,f.event.eventId);
  const customer=(await pool.query('SELECT * FROM acd_legs WHERE id=$1',[f.customer])).rows[0];
  assert.equal(customer.bridged_peer_call_id,`v3:${f.transport}`);assert.equal(customer.bridged_event_id,f.event.eventId);
  assert.equal((await pool.query('SELECT bridged_at FROM acd_legs WHERE id=$1',[f.transport])).rows[0].bridged_at,null);
  assert.equal(f.provider.calls.length,0);
});

test('duplicate customer event and late transport notification do not create additional legs or commands',{skip},async()=>{
  const f=await fixture();await routeAcdVoiceEvent(pool,f.provider,f.event);
  await routeAcdVoiceEvent(pool,f.provider,{...f.event,payload:{...f.event.payload,bridged_call_control_id:'forged-duplicate'}});
  assert.equal((await proof(f)).source,'customer_bridge_peer');
  const late={eventId:randomUUID(),eventType:'call.bridged',payload:{call_control_id:`v3:${f.transport}`,bridged_call_control_id:`v3:${f.customer}`}};
  await routeAcdVoiceEvent(pool,f.provider,late);await routeAcdVoiceEvent(pool,f.provider,late);
  assert.equal((await proof(f)).source,'answered_device_on_bridged_transport');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM acd_legs WHERE work_item_id=$1',[f.work])).rows[0].n,3);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM acd_webhook_events WHERE event_id=ANY($1::text[])',[[f.event.eventId,late.eventId]])).rows[0].n,2);
  assert.equal(f.provider.calls.length,0);
});

test('a later contradictory peer invalidates the earlier pair instead of using a bare bridged flag',{skip},async()=>{
  const f=await fixture();await routeAcdVoiceEvent(pool,f.provider,f.event);
  await routeAcdVoiceEvent(pool,f.provider,{...f.event,eventId:randomUUID(),payload:{...f.event.payload,bridged_call_control_id:'another-call'}});
  assert.equal(await proof(f),null);
});

test('late bridge never revives ended media or a completed work item',{skip},async()=>{
  const f=await fixture();await routeAcdVoiceEvent(pool,f.provider,f.event);
  await pool.query("UPDATE acd_legs SET state='ended',ended_at=now() WHERE work_item_id=$1",[f.work]);
  await pool.query("UPDATE acd_work_items SET state='completed',terminal_at=now() WHERE id=$1",[f.work]);
  await routeAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.bridged',payload:{call_control_id:`v3:${f.transport}`,bridged_call_control_id:`v3:${f.customer}`}});
  assert.equal(await proof(f),null);
  assert.equal((await pool.query('SELECT state,bridged_at FROM acd_legs WHERE id=$1',[f.transport])).rows[0].bridged_at,null);
  assert.equal((await pool.query('SELECT state FROM acd_work_items WHERE id=$1',[f.work])).rows[0].state,'completed');
  assert.equal(f.provider.calls.length,0);
});
