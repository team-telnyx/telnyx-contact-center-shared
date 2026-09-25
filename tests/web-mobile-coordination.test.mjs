import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareAcdTestPool,seedAgent,makeTxRunner} from './helpers/acd-test-db.mjs';
import {mutateRefreshSession,hasAuthSession} from '../lib/auth-refresh-sessions.mjs';
import {registerVoiceEndpoint,chooseVoiceEndpoint,readVoiceEndpoints,authenticateVoiceEndpoint,withVoiceControl,revokeAuthVoiceEndpoints} from '../lib/acd/voice-endpoints.mjs';
import {heartbeatAgentSession} from '../lib/acd/sessions.mjs';
import {effectiveAgentStatus,readAgentStatusPresentation,setManualAgentStatus,setWorkflowState} from '../lib/acd/agent-state.mjs';
import {createWorkItem} from '../lib/acd/lifecycle.mjs';
import {tryOfferAndReserve} from '../lib/acd/reservations.mjs';
import {upsertDevice} from '../lib/mobile/devices.mjs';
import {drainMobileAlerts,mobileAlertPayload} from '../lib/mobile/alerts.mjs';
const pool=await prepareAcdTestPool('cc_web_mobile_coordination_test');
after(()=>pool.end());
const tx=makeTxRunner(pool);
const provision=async id=>({id:`cred-${id}`,username:`sip-${id}`});
async function setup(){
  const id=randomUUID(); await seedAgent(pool,id);
  const web={id,username:`${id}@test.local`,authSessionId:randomUUID()};
  const mobile={...web,authSessionId:randomUUID()};
  for(const user of [web,mobile])await mutateRefreshSession(id,{add:{sessionId:user.authSessionId,refreshToken:user.authSessionId}},pool);
  const a=await registerVoiceEndpoint(pool,web,{kind:'web',deviceId:randomUUID(),label:'Computer'},provision);
  const deviceId=randomUUID();
  const b=await registerVoiceEndpoint(pool,mobile,{kind:'ios',deviceId,label:'Phone'},provision);
  for(const [user,state] of [[web,a],[mobile,b]]){
    const endpoint=await authenticateVoiceEndpoint(pool,user,state.registration.token);
    await heartbeatAgentSession(pool,{agentId:id,sessionId:endpoint.id,voiceEndpoint:endpoint,voiceReady:true});
  }
  return {id,web,mobile,a,b,deviceId};
}
const request=(registration,generation)=>({headers:new Headers({'x-cc-endpoint-token':registration.token,'x-cc-voice-generation':generation})});

test('independent concurrent logins, single-use rotations and per-session revocation',async()=>{
  const id=randomUUID();await seedAgent(pool,id);
  await Promise.all(['phone','web'].map(sessionId=>mutateRefreshSession(id,{add:{sessionId,refreshToken:sessionId}},pool)));
  const results=await Promise.allSettled([1,2].map(n=>mutateRefreshSession(id,{consume:'phone',add:{sessionId:'phone',refreshToken:`rotated-${n}`}},pool)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const winner=results[0].status==='fulfilled'?'rotated-1':'rotated-2';
  await mutateRefreshSession(id,{revoke:winner},pool);
  const user=(await pool.query('SELECT * FROM users WHERE id=$1',[id])).rows[0];
  assert.equal(hasAuthSession(user,'phone'),false);assert.equal(hasAuthSession(user,'web'),true);
});

test('selection is explicit; heartbeat never takes ownership; stale and forged controls fail',async()=>{
  const {id,web,mobile,a,b}=await setup();
  assert.equal((await readVoiceEndpoints(pool,id)).endpointId,null);
  const webState=await chooseVoiceEndpoint(pool,web,{endpointId:a.registration.id,expectedGeneration:'0'});
  assert.equal(webState.generation,'1');
  const phone=await authenticateVoiceEndpoint(pool,mobile,b.registration.token);
  await heartbeatAgentSession(pool,{agentId:id,sessionId:phone.id,voiceEndpoint:phone,voiceReady:true});
  assert.equal((await readVoiceEndpoints(pool,id)).endpointId,a.registration.id);
  const sessions=(await pool.query("SELECT id,capabilities FROM acd_agent_sessions WHERE agent_id=$1 AND capabilities->>'voice'='true'",[id])).rows;
  assert.deepEqual(sessions.map(s=>s.id),[a.registration.id]);
  await assert.rejects(withVoiceControl(pool,mobile,request(b.registration,'1'),()=>true),{status:409});
  await assert.rejects(withVoiceControl(pool,mobile,request(a.registration,'1'),()=>true),{status:403});
  await chooseVoiceEndpoint(pool,mobile,{endpointId:b.registration.id,expectedGeneration:'1'});
  await assert.rejects(withVoiceControl(pool,web,request(a.registration,'1'),()=>true),{status:409});
  assert.equal(await withVoiceControl(pool,mobile,request(b.registration,'2'),async()=>true),true);
});

test('a new companion registration never disables the selected device',async()=>{
  const {id,web,a}=await setup();
  await chooseVoiceEndpoint(pool,web,{endpointId:a.registration.id,expectedGeneration:'0'});
  await registerVoiceEndpoint(pool,web,{kind:'web',deviceId:randomUUID(),label:'Other tab'},provision);
  const live=(await pool.query("SELECT id FROM acd_agent_sessions WHERE agent_id=$1 AND capabilities->>'voice'='true'",[id])).rows;
  assert.deepEqual(live.map(row=>row.id),[a.registration.id]);
});

test('busy and wrap-up cannot be released by another UI, stale status and handoff are rejected',async()=>{
  const {id,web,mobile,a,b}=await setup();
  await chooseVoiceEndpoint(pool,web,{endpointId:a.registration.id,expectedGeneration:'0'});
  const old=await readAgentStatusPresentation(pool,id);
  await tx(db=>setWorkflowState(db,id,'handling',{actor:'test',reason:'answered'}));
  await assert.rejects(setManualAgentStatus(pool,{agentId:id,status:'Available',expectedVersion:old.version}),{status:409});
  const busy=await readAgentStatusPresentation(pool,id);
  await setManualAgentStatus(pool,{agentId:id,status:'Available',expectedVersion:busy.version});
  assert.equal((await readAgentStatusPresentation(pool,id)).status,'Busy');
  await assert.rejects(chooseVoiceEndpoint(pool,mobile,{endpointId:b.registration.id,expectedGeneration:'1'}),{status:409});
  await assert.rejects(revokeAuthVoiceEndpoints(pool,web,web.authSessionId),{status:409});
  await revokeAuthVoiceEndpoints(pool,mobile,mobile.authSessionId);
  assert.equal((await readAgentStatusPresentation(pool,id)).status,'Busy');
  await tx(db=>setWorkflowState(db,id,'wrapup',{actor:'test',reason:'ended'}));
  assert.equal((await readAgentStatusPresentation(pool,id)).status,'Wrapup');
});

test('idle handoff serializes against a command that starts handling',async()=>{
  const {id,web,mobile,a,b}=await setup();
  await chooseVoiceEndpoint(pool,web,{endpointId:a.registration.id,expectedGeneration:'0'});
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;});
  const entered=new Promise(resolve=>{started=resolve;});
  const command=withVoiceControl(pool,web,request(a.registration,'1'),async()=>{
    started();await gate;await tx(db=>setWorkflowState(db,id,'handling',{actor:'test',reason:'outbound'}));
  });
  await entered;
  const handoff=chooseVoiceEndpoint(pool,mobile,{endpointId:b.registration.id,expectedGeneration:'1'});
  release();await command;
  await assert.rejects(handoff,{status:409});
});

test('committed offers notify the companion once and retry transient APNs failures',async()=>{
  const {id,web,mobile,a,deviceId}=await setup();
  await chooseVoiceEndpoint(pool,web,{endpointId:a.registration.id,expectedGeneration:'0'});
  await upsertDevice(id,{deviceId,kind:'ios',voipToken:'a'.repeat(64),alertToken:'b'.repeat(64),bundleIdentifier:'test.bundle',environment:'test',authSessionId:mobile.authSessionId},pool);
  await tx(async db=>{
    const work=await createWorkItem(db,{channel:'voice',direction:'inbound',actor:'test'});
    const offer=await tryOfferAndReserve(db,{workItemId:work.id,agentId:id,channel:'voice',offerDeadlineMs:60000,actor:'test'});
    assert.ok(offer);
  });
  let calls=0;
  await drainMobileAlerts(pool,{send:async()=>{calls++;return {status:503,reason:'Unavailable'};}});
  assert.equal(calls,1);
  await pool.query("UPDATE cc_mobile_alerts SET next_attempt_at=now() WHERE user_id=$1",[id]);
  await drainMobileAlerts(pool,{send:async notification=>{calls++;assert.equal(notification.user_id,id);return {status:200};}});
  await drainMobileAlerts(pool,{send:async()=>{calls++;return {status:200};}});
  assert.equal(calls,2);
});

test('multiple subscribers receive updates; removing one does not evict the other',async()=>{
  const {addSseClient,removeSseClient,broadcastToKey}=await import('../lib/sse.js');
  const key=`test:${randomUUID()}`, first=[], second=[];
  const a={write:async value=>first.push(value)},b={write:async value=>second.push(value)};
  addSseClient(key,a);addSseClient(key,b);
  await broadcastToKey(key,{status:'Busy'},'status_changed');
  assert.equal(first.length,1);assert.equal(second.length,1);
  removeSseClient(key,a);
  await broadcastToKey(key,{status:'Wrapup'},'status_changed');
  assert.equal(first.length,1);assert.equal(second.length,2);
  removeSseClient(key,b);
});


test('first enrollment while busy is rejected before remote provisioning, then succeeds when idle', async () => {
  const id = randomUUID(); await seedAgent(pool, id);
  const user = { id, authSessionId: randomUUID() };
  const body = { kind: 'web', deviceId: randomUUID(), label: 'Computer' };
  let provisions = 0;
  const create = async endpointId => { provisions++; return provision(endpointId); };
  await tx(db => setWorkflowState(db, id, 'handling', { actor: 'test', reason: 'existing_work' }));
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(registerVoiceEndpoint(pool, user, body, create), { status: 409 });
  }
  assert.equal(provisions, 0);
  assert.equal((await readVoiceEndpoints(pool, id)).endpoints.length, 0);
  assert.equal((await readAgentStatusPresentation(pool, id)).status, 'Busy');
  await tx(db => setWorkflowState(db, id, 'idle', { actor: 'test', reason: 'work_finished' }));
  const result = await registerVoiceEndpoint(pool, user, body, create);
  assert.ok(result.registration.id);
  assert.equal(result.endpointId, null);
  assert.equal(provisions, 1);
});


test('messaging reservations and workflow do not lock the selected voice device',async()=>{
  const {id,web,mobile,a,b}=await setup();
  await chooseVoiceEndpoint(pool,web,{endpointId:a.registration.id,expectedGeneration:'0'});
  await tx(async db=>{
    const work=await createWorkItem(db,{channel:'sms',direction:'inbound',actor:'test'});
    await db.query(`INSERT INTO acd_reservations(id,work_item_id,agent_id,channel,state,weight,lease_expires_at)
      VALUES($1,$2,$3,'sms','active',0.2,now()+interval '1 minute')`,[randomUUID(),work.id,id]);
    await setWorkflowState(db,id,'handling',{workItemId:work.id,actor:'test',reason:'sms_active'});
  });
  const before=(await pool.query('SELECT * FROM acd_agent_state WHERE agent_id=$1',[id])).rows[0];
  const selected=await chooseVoiceEndpoint(pool,mobile,{endpointId:b.registration.id,expectedGeneration:'1'});
  assert.equal(selected.endpointId,b.registration.id);
  await chooseVoiceEndpoint(pool,web,{endpointId:a.registration.id,expectedGeneration:'2'});
  const after=(await pool.query('SELECT * FROM acd_agent_state WHERE agent_id=$1',[id])).rows[0];
  assert.equal(after.workflow_state,before.workflow_state);
  assert.equal(after.workflow_work_item_id,before.workflow_work_item_id);
});

test('notification content carries channel, queue, customer and interaction deep link',()=>{
  const payload=mobileAlertPayload({channel:'whatsapp',queue_name:'Sales',customer_name:'Ada Lovelace',customer_address:'+15555550123',work_item_id:'work-1',event_id:12});
  assert.match(payload.aps.alert.title,/WhatsApp.*Sales/);
  assert.match(payload.aps.alert.body,/Ada Lovelace.*\+15555550123/);
  assert.equal(payload.interactionId,'work-1');
  assert.equal(payload.aps.category,'CC_INTERACTION');
  assert.ok(Buffer.byteLength(JSON.stringify(payload))<4096);
});
