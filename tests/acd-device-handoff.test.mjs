import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareAcdTestPool,seedAgent,makeTxRunner} from './helpers/acd-test-db.mjs';
import {registerVoiceEndpoint,chooseVoiceEndpoint,authenticateVoiceEndpoint,readVoiceEndpoints} from '../lib/acd/voice-endpoints.mjs';
import {heartbeatAgentSession} from '../lib/acd/sessions.mjs';
import {createWorkItem,openSegment} from '../lib/acd/lifecycle.mjs';
import {commandDeviceHandoff,readDeviceHandoff} from '../lib/acd/device-handoff.mjs';
import {startSaga,driveSaga,applySagaEvent,clearSagaDeadlineWakeups,sweepDueSagas} from '../lib/acd/saga-engine.mjs';
import '../lib/acd/sagas/index.mjs';
const pool=await prepareAcdTestPool('cc_device_handoff_test'),tx=makeTxRunner(pool);
after(async()=>{clearSagaDeadlineWakeups();await pool.end();});
process.env.TELNYX_SIP_CONNECTION_ID='sip-connection-not-for-dial';
process.env.TELNYX_CALL_CONTROL_ID='call-control-application';
const request=r=>({headers:new Headers({'x-cc-endpoint-token':r.token})});
async function fixture(channel='voice',parentType='connect') {
 const agentId=randomUUID();await seedAgent(pool,agentId);
 await pool.query(`INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'video',true,1,1) ON CONFLICT DO NOTHING`,[agentId]);
 const user={id:agentId,authSessionId:randomUUID()},other={id:agentId,authSessionId:randomUUID()};
 const reg=async(u,kind)=>(await registerVoiceEndpoint(pool,u,{kind,deviceId:randomUUID(),label:kind},async id=>({id,username:id}))).registration;
 const a=await reg(user,'web'),b=await reg(other,'ios');
 for(const [u,r] of [[user,a],[other,b]]){const e=await authenticateVoiceEndpoint(pool,u,r.token);await heartbeatAgentSession(pool,{agentId,sessionId:r.id,voiceEndpoint:e,voiceReady:true,ready:{video:true}});}
 await chooseVoiceEndpoint(pool,user,{endpointId:a.id,expectedGeneration:'0'});
 const work=await tx(db=>createWorkItem(db,{channel,direction:'inbound',actor:'test',customerAddress:'+15555550123'}));
 await pool.query(`UPDATE acd_work_items SET state='active' WHERE id=$1`,[work.id]);
 const segment=await tx(db=>openSegment(db,{workItemId:work.id,kind:'agent',agentId}));
 const provider={calls:[],async send(c){this.calls.push(c);return {outcome:'accepted',httpStatus:200,response:{data:c.operation==='device_handoff_dial'?{call_control_id:`new-${work.id}`}:{result:'ok'}}};}};
 let parent;
 if(channel==='voice'){
  parent=await tx(db=>startSaga(db,{type:parentType,workItemId:work.id,conflictKey:'assignment',initialStep:parentType==='connect'?'in_call':'handling',data:{agentId,customerProviderCallId:`customer-${work.id}`,agentProviderCallId:`source-${work.id}`,generation:1}}));
  for(const [role,id] of [['customer',`customer-${work.id}`],['agent_device',`source-${work.id}`]])await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,agent_id,owner_saga_id,state,answered_at) VALUES($1,$2,$3,$4,$5,$6,'bridged',now())`,[randomUUID(),work.id,role,id,agentId,parent.sagaId]);
 }else{
  const conversationId=randomUUID();await pool.query("INSERT INTO acd_conversations(id,channel) VALUES($1,'video')",[conversationId]);
  await pool.query(`INSERT INTO acd_video_sessions(work_item_id,conversation_id,room_id,room_session_id,state,participants) VALUES($1,$2,$3,$4,'active',$5::jsonb)`,[work.id,conversationId,randomUUID(),randomUUID(),JSON.stringify([{participant_id:'old-video',role:'agent'}])]);
  const reservation=randomUUID();await pool.query(`INSERT INTO acd_reservations(id,work_item_id,agent_id,channel,state,weight,lease_expires_at) VALUES($1,$2,$3,'video','active',1,now()+interval '1 hour')`,[reservation,work.id,agentId]);
  await pool.query(`INSERT INTO acd_text_assignments(work_item_id,agent_id,segment_id,reservation_id,state) VALUES($1,$2,$3,$4,'active')`,[work.id,agentId,segment.id,reservation]);
 }
 const startBody={action:'start',targetId:b.id,commandId:randomUUID()};
 const command=(body,u=user,r=a,options={})=>commandDeviceHandoff(pool,u,request(r),work.id,body,{provider,...options});
 const start=()=>command(startBody);
 const takeBody={action:'take_over',expectedOwnerId:a.id,expectedVersion:String(segment.wrapup_owner_version||0),commandId:randomUUID()};
 const take=()=>command(takeBody,other,b);
 const owner=async()=>(await pool.query('SELECT media_endpoint_id FROM acd_segments WHERE id=$1',[segment.id])).rows[0].media_endpoint_id;
 return {work,agentId,user,other,a,b,segment,parent,provider,start,startBody,take,takeBody,command,owner};
}
for(const parentType of ['connect','manual_outbound'])test(`voice ${parentType}: keeps source until exact bridge evidence and preserves segment`,async()=>{
 const f=await fixture('voice',parentType);const result=await f.take();const id=result.handoff.id;
 assert.equal(result.handoff.step,'await_answer');assert.equal(await f.owner(),f.a.id);
 assert.equal(f.provider.calls.length,1);assert.equal(f.provider.calls[0].operation,'device_handoff_dial');
 await f.take();assert.equal(f.provider.calls.length,1,'duplicate HTTP submission must not dial twice');
 assert.equal(f.provider.calls[0].request.connection_id,'call-control-application');
 assert.equal(f.provider.calls[0].request.park_after_unbridge,undefined,'standalone Dial cannot park without automatic bridging');
 assert.equal(f.provider.calls[0].request.bridge_on_answer,undefined,'source must stay bridged until explicit cutover');
 assert.equal(f.provider.calls[0].request.to,`sip:${f.b.id}@sip.telnyx.com`);
 await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,agent_id,owner_saga_id,state,answered_at)
 VALUES($1,$2,'handoff_target',$3,$4,$5,'answered',now())`,[randomUUID(),f.work.id,`device-${f.work.id}`,f.agentId,id]);
 await pool.query(`UPDATE acd_legs SET answered_at=now() WHERE provider_call_id=$1`,[`new-${f.work.id}`]);
 await driveSaga(pool,id,{provider:f.provider});
 assert.equal(await f.owner(),f.a.id,'Bridge HTTP acceptance must not claim ownership');
 assert.equal(f.provider.calls.at(-1).operation,'device_handoff_bridge');
 await applySagaEvent(pool,{workItemId:f.work.id,name:'leg.bridged',role:'customer',provider:f.provider});
 assert.equal(await f.owner(),f.a.id,'unrelated bridge event must not commit');
 await pool.query(`UPDATE acd_legs SET bridged_peer_call_id=$2,bridged_at=now() WHERE provider_call_id=$1`,[`customer-${f.work.id}`,`device-${f.work.id}`]);
 await driveSaga(pool,id,{provider:f.provider});
 assert.equal(await f.owner(),f.b.id);
 const preference=await readVoiceEndpoints(pool,f.agentId);assert.equal(preference.endpointId,f.b.id);
 assert.equal(f.provider.calls.at(-1).operation,'device_handoff_release_source');
 const s=(await pool.query('SELECT * FROM acd_segments WHERE id=$1',[f.segment.id])).rows[0];
 assert.equal(s.ended_at,null);assert.equal(s.wrapup_endpoint_id,f.b.id);
 const parent=(await pool.query('SELECT * FROM acd_sagas WHERE id=$1',[f.parent.sagaId])).rows[0];assert.equal(parent.state,'running');
 await applySagaEvent(pool,{workItemId:f.work.id,name:'leg.ended',role:'handoff_source',payload:{owner_saga_id:f.parent.sagaId},provider:f.provider});
 assert.equal((await pool.query('SELECT terminal_at FROM acd_work_items WHERE id=$1',[f.work.id])).rows[0].terminal_at,null);
});
test('voice: cancel and no-answer leave the original device in control',async()=>{
 const f=await fixture();const started=await f.start();
 const result=await f.command({action:'cancel',id:started.handoff.id});
 assert.equal(result.handoff.state,'cancelled');assert.equal(await f.owner(),f.a.id);
 assert.deepEqual(f.provider.calls.map(c=>c.operation),['device_handoff_dial','device_handoff_cancel_target']);
 const g=await fixture();const next=await g.start();
 await pool.query(`UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE id=$1`,[next.handoff.id]);
 await sweepDueSagas(pool,{provider:g.provider});assert.equal(await g.owner(),g.a.id);
 assert.equal((await readDeviceHandoff(pool,g.user,request(g.a),g.work.id)).handoff.state,'cancelled');
});
test('authorization, competing moves, stale sessions and offline target are rejected',async()=>{
 const f=await fixture();
 await assert.rejects(f.command(f.startBody,f.other,f.b),{status:409});
 await assert.rejects(f.command(f.startBody,f.user,f.b),{status:403});
 await pool.query("UPDATE cc_voice_endpoints SET expires_at=now()-interval '1 minute' WHERE id=$1",[f.b.id]);
 await assert.rejects(f.start(),{status:409});
 await pool.query("UPDATE cc_voice_endpoints SET expires_at=now()+interval '1 minute' WHERE id=$1",[f.b.id]);
 await f.start();await assert.rejects(f.command({...f.startBody,commandId:randomUUID()}),{status:409});
});
test('video: target joins muted; only signed participant evidence permits cutover',async()=>{
 const f=await fixture('video');const offered=await f.take();assert.equal(offered.handoff.step,'await_video');
 const id=offered.handoff.id;
 await assert.rejects(f.command({action:'join',id}),{status:409});
 const rooms={generateJoinToken:async()=>({token:'test',refreshToken:'refresh'})};
 const joining=await f.command({action:'join',id},f.other,f.b,{rooms});
 assert.ok(joining.join.context.handoffNonce);assert.equal(await f.owner(),f.a.id);
 await assert.rejects(f.command({action:'ready',id},f.other,f.b),{status:409});
 await pool.query(`UPDATE acd_video_sessions SET participants=participants||$2::jsonb WHERE work_item_id=$1`,[f.work.id,JSON.stringify([{participant_id:'new-video',role:'agent',handoff_nonce:joining.join.context.handoffNonce}])]);
 const waiting=await f.command({action:'ready',id},f.other,f.b);
 assert.equal(waiting.handoff.completed,false);assert.equal(await f.owner(),f.a.id,'Kick acceptance must not publish target media');
 await pool.query(`UPDATE acd_video_sessions SET participants=(SELECT jsonb_agg(CASE WHEN p->>'participant_id'='old-video' THEN p||jsonb_build_object('left_at',now()) ELSE p END) FROM jsonb_array_elements(participants) p) WHERE work_item_id=$1`,[f.work.id]);
 const completed=await f.command({action:'ready',id},f.other,f.b);
 assert.equal(completed.handoff.completed,true);assert.equal(await f.owner(),f.b.id);
 assert.deepEqual(f.provider.calls.map(c=>c.request.participants),[['old-video']]);
 const duplicate=await f.command({action:'ready',id},f.other,f.b);assert.equal(duplicate.handoff.completed,true);
 assert.equal(f.provider.calls.length,1);
});

test('voice: provider webhook binding rejects wrong nonce and adopts only the answered target',async()=>{
 const {routeAcdVoiceEvent}=await import('../lib/acd/live-intake.mjs');
 const f=await fixture();const {handoff}=await f.start();
 const headers=f.provider.calls[0].request.custom_headers;
 const event=(eventType,payload)=>routeAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType,occurredAt:new Date().toISOString(),payload},{node:'test'});
 const device=`device-${f.work.id}`;
 const bad=headers.map(h=>h.name==='X-CC-Handoff-Nonce'?{...h,value:'wrong'}:h);
 await event('call.initiated',{call_control_id:'wrong-'+device,direction:'incoming',custom_headers:bad});
 assert.equal((await pool.query('SELECT 1 FROM acd_legs WHERE provider_call_id=$1',['wrong-'+device])).rowCount,0);
 await event('call.initiated',{call_control_id:device,direction:'incoming',custom_headers:headers});
 assert.equal((await pool.query('SELECT role FROM acd_legs WHERE provider_call_id=$1',[device])).rows[0].role,'handoff_target');
 await event('call.answered',{call_control_id:device});
 assert.equal(await f.owner(),f.a.id);
 await event('call.answered',{call_control_id:`new-${f.work.id}`});
 await event('call.hangup',{call_control_id:`new-${f.work.id}`});
 assert.equal((await readDeviceHandoff(pool,f.user,request(f.a),f.work.id)).handoff.state,'running','transport teardown must not end the answered WebRTC device');
 await event('call.bridged',{call_control_id:`customer-${f.work.id}`});
 assert.equal(await f.owner(),f.a.id);
 await event('call.bridged',{call_control_id:device});
 // Provider peer evidence must have the same representation as regular bridge intake.
 await driveSaga(pool,handoff.id,{provider:f.provider});
 assert.equal(await f.owner(),f.b.id);
 const {agentBridgeEvidence,loadVoiceBridgeTopology}=await import('../lib/acd/voice-bridge-evidence.mjs');
 const topology=await loadVoiceBridgeTopology(pool,f.work.id);
 assert.ok(agentBridgeEvidence(topology.legs,topology.intents,f.agentId,{live:true}));
 await event('call.hangup',{call_control_id:`source-${f.work.id}`});
 assert.equal((await pool.query('SELECT terminal_at FROM acd_work_items WHERE id=$1',[f.work.id])).rows[0].terminal_at,null);
});

test('voice: an ambiguous Dial cannot release the handoff fence merely with elapsed time',async()=>{
 const f=await fixture();
 f.provider.send=async function(c){this.calls.push(c);return {outcome:'ambiguous',httpStatus:504,response:{}};};
 const result=await f.start();
 await pool.query("UPDATE acd_commands SET created_at=now()-interval '5 minutes' WHERE saga_id=$1",[result.handoff.id]);
 await pool.query("UPDATE acd_sagas SET step='cleanup_target',deadline_at=now()+interval '1 minute' WHERE id=$1",[result.handoff.id]);
 await driveSaga(pool,result.handoff.id,{provider:f.provider});
 assert.equal((await pool.query('SELECT handoff_saga_id FROM acd_work_items WHERE id=$1',[f.work.id])).rows[0].handoff_saga_id,result.handoff.id);
 assert.equal(await f.owner(),f.a.id);
});

test('voice: target failure during bridge restores source before cancelling',async()=>{
 const f=await fixture();const {handoff}=await f.start();
 await pool.query(`INSERT INTO acd_legs(id,work_item_id,role,provider_call_id,agent_id,owner_saga_id,state,answered_at)
 VALUES($1,$2,'handoff_target',$3,$4,$5,'answered',now())`,[randomUUID(),f.work.id,`device-${f.work.id}`,f.agentId,handoff.id]);
 await pool.query("UPDATE acd_legs SET answered_at=now() WHERE provider_call_id=$1",[`new-${f.work.id}`]);
 await driveSaga(pool,handoff.id,{provider:f.provider});
 await pool.query("UPDATE acd_legs SET ended_at=now() WHERE provider_call_id=$1",[`device-${f.work.id}`]);
 await driveSaga(pool,handoff.id,{provider:f.provider});
 assert.equal(f.provider.calls.at(-1).operation,'device_handoff_restore');
 assert.equal(await f.owner(),f.a.id);
 await pool.query("UPDATE acd_legs SET bridged_peer_call_id=$2,bridged_at=now() WHERE provider_call_id=$1",[`customer-${f.work.id}`,`source-${f.work.id}`]);
 await driveSaga(pool,handoff.id,{provider:f.provider});
 assert.equal((await readDeviceHandoff(pool,f.user,request(f.a),f.work.id)).handoff.state,'cancelled');
 assert.equal(await f.owner(),f.a.id);
});


test('pull handoff is authenticated, version fenced, idempotent and cannot choose a third device',async()=>{
 const f=await fixture();
 const view=await readDeviceHandoff(pool,f.other,request(f.b),f.work.id);
 assert.equal(view.canTakeOver,true);assert.equal(view.ownerLabel,'Computer');
 assert.equal((await readDeviceHandoff(pool,f.user,request(f.a),f.work.id)).canTakeOver,false);
 await assert.rejects(f.command({...f.takeBody,expectedOwnerId:randomUUID()},f.other,f.b),{status:409});
 await assert.rejects(f.command({...f.takeBody,expectedVersion:'99'},f.other,f.b),{status:409});
 await assert.rejects(f.command(f.takeBody,f.user,f.b),{status:403});
 const started=await f.command({...f.takeBody,targetId:randomUUID()},f.other,f.b);
 assert.equal(started.handoff.targetId,f.b.id,'destination comes from authenticated endpoint, never request');
 await f.take();assert.equal(f.provider.calls.length,1);
 await assert.rejects(f.command({...f.takeBody,commandId:randomUUID()},f.other,f.b),{status:409});
 assert.equal(await f.owner(),f.a.id);
});

test('a web session can pull from iPhone with the same ownership checks',async()=>{
 const f=await fixture();
 await pool.query('UPDATE acd_segments SET media_endpoint_id=$2 WHERE id=$1',[f.segment.id,f.b.id]);
 const view=await readDeviceHandoff(pool,f.user,request(f.a),f.work.id);
 assert.equal(view.canTakeOver,true);assert.equal(view.ownerLabel,'iPhone');
 const result=await f.command({action:'take_over',expectedOwnerId:f.b.id,expectedVersion:view.ownerVersion,commandId:randomUUID()});
 assert.equal(result.handoff.sourceId,f.b.id);assert.equal(result.handoff.targetId,f.a.id);
 assert.equal(await f.owner(),f.b.id);assert.equal(f.provider.calls.length,1);
});

test('offline target cannot pull; definitive provider failure is visible without ending the original call',async()=>{
 const f=await fixture();
 await pool.query('UPDATE cc_voice_endpoints SET ready=false,push_ready=true WHERE id=$1',[f.b.id]);
 assert.equal((await readDeviceHandoff(pool,f.other,request(f.b),f.work.id)).canTakeOver,false);
 await assert.rejects(f.take(),{status:409});
 await pool.query('UPDATE cc_voice_endpoints SET ready=true WHERE id=$1',[f.b.id]);
 f.provider.send=async function(c){this.calls.push(c);return {outcome:'failed',httpStatus:422,response:{errors:[{detail:'Rejected Dial'}]}};};
 const result=await f.take();
 assert.equal(result.handoff.state,'cancelled');assert.match(result.handoff.error,/HTTP 422/);
 assert.equal(await f.owner(),f.a.id);assert.equal(f.provider.calls.length,1);
 assert.equal(result.canTakeOver,true,'definitive failure can be retried with a new command');
});


test('voice can move repeatedly in both directions; source hangup confirms cleanup immediately and keeps shared monitoring',async()=>{
 const {routeAcdVoiceEvent}=await import('../lib/acd/live-intake.mjs');
 const {listAgentInteractionViews}=await import('../lib/acd/work-item-repository.mjs');
 const {readAgentSnapshot}=await import('../lib/acd/stream.mjs');
 const f=await fixture();
 await pool.query(`INSERT INTO acd_reservations(id,work_item_id,agent_id,channel,state,weight,lease_expires_at)
 VALUES($1,$2,$3,'voice','active',1,now()+interval '1 hour')`,[randomUUID(),f.work.id,f.agentId]);
 let step=0;
 f.provider.send=async function(c){this.calls.push(c);return c.operation==='device_handoff_release_source'
   ? {outcome:'ambiguous',httpStatus:504,response:{}}
   : {outcome:'accepted',httpStatus:200,response:{data:c.operation==='device_handoff_dial'?{call_control_id:`transport-${step}`}:{result:'ok'}}};};
 const event=(eventType,payload)=>routeAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType,occurredAt:new Date().toISOString(),payload},{node:'roundtrip'});
 let oldDevice=`source-${f.work.id}`;
 for(const [u,r] of [[f.other,f.b],[f.user,f.a],[f.other,f.b],[f.user,f.a]]) {
   step++;
   const before=await readDeviceHandoff(pool,u,request(r),f.work.id);
   assert.equal(before.canTakeOver,true,`takeover ${step} must be available`);
   const result=await f.command({action:'take_over',expectedOwnerId:before.ownerId,expectedVersion:before.ownerVersion,commandId:randomUUID()},u,r);
   const dial=f.provider.calls.findLast(c=>c.operation==='device_handoff_dial');
   const device=`device-${step}`;
   await event('call.initiated',{call_control_id:device,direction:'incoming',custom_headers:dial.request.custom_headers});
   await event('call.answered',{call_control_id:device});
   await event('call.bridged',{call_control_id:`customer-${f.work.id}`,call_control_id_to_bridge_with:device});
   await event('call.bridged',{call_control_id:device,call_control_id_to_bridge_with:`customer-${f.work.id}`});
   await driveSaga(pool,result.handoff.id,{provider:f.provider});
   assert.equal(await f.owner(),r.id);
   await event('call.hangup',{call_control_id:oldDevice});
   const after=await readDeviceHandoff(pool,u,request(r),f.work.id);
   assert.equal(after.handoff.state,'succeeded','source webhook must settle cleanup even if HTTP result was lost');
   const list=await listAgentInteractionViews(pool,f.agentId);
   assert.ok(list.some(item=>item.id===f.work.id && item.state==='connected'),'shared list keeps the same active interaction');
   const snapshot=await readAgentSnapshot(pool,f.agentId);
   const live=snapshot.interactions.find(item=>item.interaction_id===f.work.id);
   assert.ok(live?.owns_live_assignment);assert.equal(live.media_endpoint_id,r.id);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM acd_segments WHERE work_item_id=$1',[f.work.id])).rows[0].count,1);
   oldDevice=device;
 }
});
