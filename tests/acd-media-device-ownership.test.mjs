import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, seedAgent, makeTxRunner } from './helpers/acd-test-db.mjs';
import { registerVoiceEndpoint, chooseVoiceEndpoint, authenticateVoiceEndpoint, readVoiceEndpoints } from '../lib/acd/voice-endpoints.mjs';
import { heartbeatAgentSession } from '../lib/acd/sessions.mjs';
import { createWorkItem, openSegment } from '../lib/acd/lifecycle.mjs';
import { mediaDevicePresentation, withWrapupDevice, takeOverWrapup, withVideoDevice } from '../lib/acd/media-device-control.mjs';
const pool = await prepareAcdTestPool('cc_media_device_ownership_test');
after(() => pool.end());
const tx = makeTxRunner(pool);
const request = registration => ({ headers: new Headers({ 'x-cc-endpoint-token': registration.token }) });
async function setup(channel = 'voice') {
  const id = randomUUID(); await seedAgent(pool, id);
  await pool.query(`INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'video',true,1,1) ON CONFLICT(agent_id,channel) DO UPDATE SET enabled=true`,[id]);
  const web = { id, authSessionId: randomUUID() }, phone = { id, authSessionId: randomUUID() };
  const register = user => registerVoiceEndpoint(pool, user, {kind:user===web?'web':'ios', deviceId:randomUUID(),label:user===web?'Computer':'iPhone'}, async id=>({id:`cred-${id}`,username:`sip-${id}`}));
  const a = (await register(web)).registration, b = (await register(phone)).registration;
  for (const [user, registration] of [[web,a],[phone,b]]) {
    const endpoint = await authenticateVoiceEndpoint(pool,user,registration.token);
    await heartbeatAgentSession(pool,{agentId:id,sessionId:endpoint.id,voiceEndpoint:endpoint,voiceReady:true,ready:{video:true}});
  }
  await chooseVoiceEndpoint(pool,web,{endpointId:a.id,expectedGeneration:'0'});
  const work = await tx(db=>createWorkItem(db,{channel,direction:'inbound',actor:'test'}));
  return {id,web,phone,a,b,work,options:{workItemId:work.id,wrapup:true}};
}
async function endedSegment(f) {
  const segment = await tx(db=>openSegment(db,{workItemId:f.work.id,kind:'agent',agentId:f.id}));
  await pool.query(`UPDATE acd_segments SET ended_at=now(),outcome='completed' WHERE id=$1`,[segment.id]);
  return segment;
}
for (const channel of ['voice','video']) test(`${channel}: handling owner is frozen; takeover changes only wrap-up and rejects stale writes`, async()=>{
  const f=await setup(channel), segment=await endedSegment(f);
  assert.equal(segment.media_endpoint_id,f.a.id);
  assert.equal((await mediaDevicePresentation(pool,f.phone,request(f.b),f.options)).canControl,false);
  await assert.rejects(withWrapupDevice(pool,f.phone,request(f.b),{...f.options,ownerVersion:'0'},()=>assert.fail('unauthorized write')),{status:409});
  await assert.rejects(withWrapupDevice(pool,f.web,request(f.a),f.options,()=>assert.fail('missing version')),{status:409});
  await withWrapupDevice(pool,f.web,request(f.a),{...f.options,ownerVersion:'0'},async()=>true);
  await takeOverWrapup(pool,f.phone,request(f.b),{...f.options,segmentId:segment.id,expectedVersion:'0'});
  const after=await mediaDevicePresentation(pool,f.phone,request(f.b),f.options);
  assert.equal(after.canControl,true); assert.equal(after.version,'1');
  assert.equal((await readVoiceEndpoints(pool,f.id)).endpointId,f.a.id);
  assert.equal((await pool.query('SELECT media_endpoint_id FROM acd_segments WHERE id=$1',[segment.id])).rows[0].media_endpoint_id,f.a.id);
  await assert.rejects(withWrapupDevice(pool,f.web,request(f.a),{...f.options,ownerVersion:'0'},()=>assert.fail('stale owner')),{status:409});
  await withWrapupDevice(pool,f.phone,request(f.b),{...f.options,ownerVersion:'1'},async()=>true);
  await takeOverWrapup(pool,f.web,request(f.a),{...f.options,segmentId:segment.id,expectedVersion:'1'});
  await assert.rejects(withWrapupDevice(pool,f.web,request(f.a),{...f.options,ownerVersion:'0'},()=>assert.fail('ABA stale write')),{status:409});
});
test('a simultaneous completion and takeover serialize; completion prevents takeover',async()=>{
  const f=await setup(),segment=await endedSegment(f);
  let release,enter;
  const gate=new Promise(resolve=>release=resolve), entered=new Promise(resolve=>enter=resolve);
  const save=withWrapupDevice(pool,f.web,request(f.a),{...f.options,ownerVersion:'0'},async()=>{
    enter();await gate;await pool.query('UPDATE acd_segments SET wrapup_ended_at=now() WHERE id=$1',[segment.id]);
  });
  await entered;
  const takeover=takeOverWrapup(pool,f.phone,request(f.b),{...f.options,segmentId:segment.id,expectedVersion:'0'});
  const rejected=assert.rejects(takeover,{status:409});release();await save;await rejected;
});
test('only selected device can act on video and device choice is blocked during video reservation',async()=>{
  const f=await setup('video');
  await withVideoDevice(pool,f.web,request(f.a),f.work.id,async()=>true);
  await assert.rejects(withVideoDevice(pool,f.phone,request(f.b),f.work.id,()=>assert.fail('wrong device')),{status:409});
  await pool.query(`INSERT INTO acd_reservations(id,work_item_id,agent_id,channel,state,weight,lease_expires_at)
    VALUES($1,$2,$3,'video','active',1,now()+interval '1 minute')`,[randomUUID(),f.work.id,f.id]);
  await assert.rejects(chooseVoiceEndpoint(pool,f.phone,{endpointId:f.b.id,expectedGeneration:'1'}),{status:409});
});
test('selected video readiness moves immediately without waiting for heartbeat',async()=>{
  const f=await setup('video');
  const ready=async()=>(await pool.query(`SELECT id FROM acd_agent_sessions WHERE agent_id=$1 AND capabilities->>'video'='true'`,[f.id])).rows.map(r=>r.id);
  assert.deepEqual(await ready(),[f.a.id]);
  await chooseVoiceEndpoint(pool,f.phone,{endpointId:f.b.id,expectedGeneration:'1'});
  assert.deepEqual(await ready(),[f.b.id]);
});
test('missing, revoked and cross-session credentials cannot take over; live segments cannot be claimed',async()=>{
  const f=await setup();const segment=await tx(db=>openSegment(db,{workItemId:f.work.id,kind:'agent',agentId:f.id}));
  await assert.rejects(takeOverWrapup(pool,f.phone,request(f.b),{...f.options,expectedVersion:'0'}),{status:409});
  await pool.query(`UPDATE acd_segments SET ended_at=now(),outcome='completed' WHERE id=$1`,[segment.id]);
  await assert.rejects(takeOverWrapup(pool,f.phone,{headers:new Headers()}, {...f.options,expectedVersion:'0'}),{status:409});
  await assert.rejects(takeOverWrapup(pool,f.web,request(f.b),{...f.options,expectedVersion:'0'}),{status:403});
  await pool.query('UPDATE cc_voice_endpoints SET revoked_at=now() WHERE id=$1',[f.b.id]);
  await assert.rejects(takeOverWrapup(pool,f.phone,request(f.b),{...f.options,expectedVersion:'0'}),{status:403});
});
