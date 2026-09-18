import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool, seedAgent, seedQueue, makeTxRunner } from "./helpers/acd-test-db.mjs";
import { heartbeatAgentSession } from "../lib/acd/sessions.mjs";
import { routeOne } from "../lib/acd/router.mjs";
import { createChatWork, actOnTextWork, endCustomerChat, sweepTextWrapups, NATIVE_TEXT_PROVIDER } from "../lib/acd/text-lifecycle.mjs";
import { completeAcdWrapup,saveAcdDisposition } from "../lib/acd/wrapup.mjs";
import { readAgentSnapshot } from "../lib/acd/stream.mjs";
import { findPendingAcdWrapupForAgent } from "../lib/acd/wrapup-context.mjs";
import { sweepWrapupDeadlines } from "../lib/acd/reconciler.mjs";
import { readUtilization, saveUtilization } from "../lib/acd/utilization.mjs";
import { createWorkItem, applyTransition, checkInvariants } from "../lib/acd/lifecycle.mjs";
import { sweepDueSagas, clearSagaDeadlineWakeups } from "../lib/acd/saga-engine.mjs";
import { messagingTransferTargets,transferTextWork } from "../lib/acd/text-transfer.mjs";
import { readTextDetail,readTextInteractions } from "../lib/acd/text-desktop.mjs";

const pool = await prepareAcdTestPool("acd_core_test_native_chat");
const withTx = makeTxRunner(pool);
after(async () => { clearSagaDeadlineWakeups(); await pool.end(); });

async function fixture({ agentMax=2, queueMax=5, weight=0.2 } = {}) {
  const agentId = randomUUID(), queueId = randomUUID();
  await seedAgent(pool,agentId,{ voiceReady:false });
  await pool.query("UPDATE users SET telephony_credentials_id=NULL WHERE id=$1",[agentId]);
  await seedQueue(pool,queueId,[agentId]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,$2,$3)",[agentId,agentMax,weight]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,$2,$3)",[queueId,queueMax,weight]);
  const ready = await heartbeatAgentSession(pool,{agentId,sessionId:randomUUID(),chatReady:true});
  return {agentId,queueId,ready,create:()=>withTx(tx=>createChatWork(tx,{queueId}))};
}
async function act(work,agentId,action,data={}) {
  const current=(await pool.query("SELECT * FROM acd_work_items WHERE id=$1",[work.id])).rows[0];
  const offer=(await pool.query("SELECT id FROM acd_offers WHERE work_item_id=$1 AND agent_id=$2 ORDER BY generation DESC LIMIT 1",[work.id,agentId])).rows[0];
  return actOnTextWork(pool,{workItemId:work.id,agentId,commandId:randomUUID(),expectedVersion:current.version,action,offerId:offer?.id,...data});
}

test("chat transfer offers to an eligible agent, preserves history, and revokes the source's active access",async()=>{
  const source=await fixture(),target=await fixture(),work=await source.create();
  await routeOne(pool,work.id);await act(work,source.agentId,"accept");await act(work,source.agentId,"send",{body:"History before transfer"});
  const before=(await pool.query("SELECT * FROM acd_work_items WHERE id=$1",[work.id])).rows[0];
  const input={workItemId:work.id,agentId:source.agentId,queueId:target.queueId,targetAgentId:target.agentId,expectedVersion:before.version,commandId:randomUUID()};
  assert.deepEqual(await transferTextWork(pool,input),{ok:true});
  assert.deepEqual(await transferTextWork(pool,input),{ok:true});
  await assert.rejects(transferTextWork(pool,{...input,queueId:source.queueId}),e=>e.status===409);
  const moved=(await pool.query("SELECT * FROM acd_work_items WHERE id=$1",[work.id])).rows[0];
  assert.equal(moved.state,"offered");assert.equal(moved.queue_id,target.queueId);assert.equal(moved.conversation_id,before.conversation_id);
  assert.equal((await readTextInteractions(pool,source.agentId)).interactions.length,0);
  assert.equal((await readTextInteractions(pool,target.agentId)).interactions[0].state,"ringing");
  await assert.rejects(readTextDetail(pool,{workItemId:work.id,agentId:source.agentId}),e=>e.status===403);
  await assert.rejects(act(work,source.agentId,"send",{body:"Forbidden after transfer"}),e=>e.status===403);
  await act(work,target.agentId,"accept");await act(work,target.agentId,"send",{body:"Continued by new agent"});
  assert.deepEqual((await pool.query("SELECT body FROM acd_messages WHERE conversation_id=$1 ORDER BY seq",[work.conversation_id])).rows.map(m=>m.body),["History before transfer","Continued by new agent"]);
  assert.equal((await readAgentSnapshot(pool,source.agentId)).agent.status,"Wrapup");
  await completeAcdWrapup(pool,{workItemId:work.id,expectedAgentId:source.agentId,wrapupCodeId:"resolved"});
  assert.equal((await readAgentSnapshot(pool,source.agentId)).agent.status,"Available");
  assert.equal((await readTextInteractions(pool,target.agentId)).interactions[0].state,"active");
  assert.deepEqual(await checkInvariants(pool),{});
});

test("chat transfers roll back for stale, foreign, disabled or full destinations; queue transfers release capacity",async()=>{
  const source=await fixture(),target=await fixture({agentMax:1}),work=await source.create();
  await routeOne(pool,work.id);await act(work,source.agentId,"accept");
  const version=(await pool.query("SELECT version FROM acd_work_items WHERE id=$1",[work.id])).rows[0].version;
  const input={workItemId:work.id,agentId:source.agentId,queueId:target.queueId,targetAgentId:target.agentId,expectedVersion:version,commandId:randomUUID()};
  await assert.rejects(transferTextWork(pool,{...input,expectedVersion:"0"}),e=>e.status===409);
  await assert.rejects(transferTextWork(pool,{...input,agentId:target.agentId}),e=>e.status===403);
  await pool.query("UPDATE cc_queue_channels SET enabled=false WHERE queue_id=$1 AND channel='chat'",[target.queueId]);
  await assert.rejects(transferTextWork(pool,input),e=>e.status===409);
  await pool.query("UPDATE cc_queue_channels SET enabled=true WHERE queue_id=$1 AND channel='chat'",[target.queueId]);
  const occupied=await target.create();await routeOne(pool,occupied.id);await act(occupied,target.agentId,"accept");
  await assert.rejects(transferTextWork(pool,input),e=>e.status===409);
  assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE work_item_id=$1",[work.id])).rows[0].state,"active");
  assert.equal((await pool.query("SELECT version FROM acd_work_items WHERE id=$1",[work.id])).rows[0].version,version);
  await transferTextWork(pool,{...input,targetAgentId:null});
  assert.equal((await pool.query("SELECT state FROM acd_work_items WHERE id=$1",[work.id])).rows[0].state,"queued");
  assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE work_item_id=$1",[work.id])).rows[0].state,"released");
  assert.deepEqual(await checkInvariants(pool),{});
});

test("messaging destinations require ownership and filter queue channel, agent availability and capacity",async()=>{
  const source=await fixture(),target=await fixture({agentMax:1}),work=await source.create();
  await routeOne(pool,work.id);await act(work,source.agentId,"accept");
  const input={workItemId:work.id,agentId:source.agentId,channel:"chat"};
  const first=await messagingTransferTargets(pool,input);
  assert(first.agents.some(a=>a.id===target.agentId&&a.queue_id===target.queueId));assert(!first.agents.some(a=>a.id===source.agentId));assert.equal(first.forward,null);
  await assert.rejects(messagingTransferTargets(pool,{...input,agentId:target.agentId}),e=>e.status===403);
  await assert.rejects(messagingTransferTargets(pool,{...input,channel:"email"}),e=>e.status===403);
  await pool.query("UPDATE acd_agent_state SET manual_status='Break' WHERE agent_id=$1",[target.agentId]);
  assert(!(await messagingTransferTargets(pool,input)).agents.some(a=>a.id===target.agentId));
  await pool.query("UPDATE acd_agent_state SET manual_status='Available' WHERE agent_id=$1",[target.agentId]);
  const occupied=await target.create();await routeOne(pool,occupied.id);
  assert(!(await messagingTransferTargets(pool,input)).agents.some(a=>a.id===target.agentId));
  await pool.query("UPDATE cc_queue_channels SET enabled=false WHERE queue_id=$1 AND channel='chat'",[target.queueId]);
  assert(!(await messagingTransferTargets(pool,input)).queues.some(q=>q.id===target.queueId));
});

test("chat readiness requires admin enablement but no SIP credentials", async()=>{
  const f=await fixture();
  assert.equal(f.ready.chatReady,true); assert.equal(f.ready.voiceReady,false);
  const other=randomUUID(); await seedAgent(pool,other,{voiceReady:false});
  const ready=await heartbeatAgentSession(pool,{agentId:other,sessionId:randomUUID(),chatReady:true});
  assert.equal(ready.chatReady,false);
  const a=await f.create(); assert.equal((await routeOne(pool,a.id)).routed,true);
});

test("concurrent offers respect agent limit 2 even when the queue allows 5",async()=>{
  const f=await fixture(); const works=[];
  for(let i=0;i<12;i++)works.push(await f.create());
  const routed=await Promise.all(works.map(w=>routeOne(pool,w.id)));
  assert.equal(routed.filter(r=>r.routed).length,2);
  const rows=(await pool.query("SELECT * FROM acd_reservations WHERE agent_id=$1 AND state<>'released'",[f.agentId])).rows;
  assert.equal(rows.length,2); assert.ok(rows.every(r=>r.owner_saga_id));
});

test("queue limit 2 narrows agent limit 5 and is global across queues and sessions",async()=>{
  const f=await fixture({agentMax:5,queueMax:2});
  const first=await f.create(); await routeOne(pool,first.id); await act(first,f.agentId,"accept");
  const q2=randomUUID(); await seedQueue(pool,q2,[f.agentId]);
  await pool.query("INSERT INTO cc_queue_channels VALUES($1,'chat',true,2,0.2,now())",[q2]);
  await heartbeatAgentSession(pool,{agentId:f.agentId,sessionId:randomUUID(),chatReady:true});
  const second=await withTx(tx=>createChatWork(tx,{queueId:q2}));
  assert.equal((await routeOne(pool,second.id)).routed,true);
  const third=await f.create(); assert.equal((await routeOne(pool,third.id)).routed,false);
});

test("editable chat maxima may exceed the old hard-coded limit of 3",async()=>{
  const f=await fixture({agentMax:5,queueMax:5,weight:0.1});
  for(let i=0;i<5;i++){const work=await f.create();assert.equal((await routeOne(pool,work.id)).routed,true);await act(work,f.agentId,"accept");}
  assert.equal((await routeOne(pool,(await f.create()).id)).routed,false);
});

test("aggregate budget can restrict concurrency below configured maxima",async()=>{
  const f=await fixture({agentMax:5,queueMax:5,weight:0.6});
  assert.equal((await routeOne(pool,(await f.create()).id)).routed,true);
  assert.equal((await routeOne(pool,(await f.create()).id)).routed,false);
});

test("accept, reply, disconnect and timed wrap-up use one slot and no voice commands",async()=>{
  const f=await fixture();const work=await f.create();await routeOne(pool,work.id);
  await act(work,f.agentId,"accept");
  const reply=await act(work,f.agentId,"send",{body:"Hello from the agent"});assert.equal(reply.message.body,"Hello from the agent");
  await act(work,f.agentId,"disconnect");
  assert.equal((await pool.query("SELECT state FROM acd_conversations WHERE id=$1",[work.conversation_id])).rows[0].state,"closed");
  assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE work_item_id=$1",[work.id])).rows[0].state,"active");
  const other=await f.create();assert.equal((await routeOne(pool,other.id)).routed,false);
  await pool.query("UPDATE acd_text_assignments SET wrapup_deadline_at=now()-interval '1 second' WHERE work_item_id=$1",[work.id]);
  assert.equal(await sweepTextWrapups(pool),1);
  assert.equal((await pool.query("SELECT state FROM acd_work_items WHERE id=$1",[work.id])).rows[0].state,"completed");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_commands WHERE saga_id IN(SELECT id FROM acd_sagas WHERE work_item_id=$1)",[work.id])).rows[0].n,0);
  assert.deepEqual(await checkInvariants(pool),{});
  assert.equal((await routeOne(pool,other.id)).routed,true);
});

test("disconnect publishes the global wrap-up snapshot and shared completion releases the chat",async()=>{
  const f=await fixture(),work=await f.create();await routeOne(pool,work.id);await act(work,f.agentId,"accept");
  await act(work,f.agentId,"disconnect");
  const snapshot=await readAgentSnapshot(pool,f.agentId);
  assert.equal(snapshot.agent.status,"Wrapup");assert.equal(snapshot.agent.routability,"not_routable");
  assert.equal(snapshot.agent.workflow_work_item_id,work.id);assert.equal(snapshot.pendingWrapup.channel,"chat");
  assert(snapshot.pendingWrapup.ended_at);assert(snapshot.pendingWrapup.wrapup_deadline_at);
  const pending=await findPendingAcdWrapupForAgent(pool,{agentId:f.agentId});assert.equal(pending.work_item_id,work.id);
  await withTx(tx=>saveAcdDisposition(tx,{segmentId:pending.id,agentId:f.agentId,codeId:"resolved",actor:"test"}));
  const completed=await completeAcdWrapup(pool,{workItemId:work.id,expectedAgentId:f.agentId});assert.equal(completed.completed,true);
  const after=await readAgentSnapshot(pool,f.agentId);assert.equal(after.agent.status,"Available");assert.equal(after.pendingWrapup,null);
  assert.equal(after.agent.routability,"routable");
  const assignment=(await pool.query("SELECT a.state,s.wrapup_code_id FROM acd_text_assignments a JOIN acd_segments s ON s.id=a.segment_id WHERE a.work_item_id=$1",[work.id])).rows[0];
  assert.equal(assignment.state,"completed");assert.equal(assignment.wrapup_code_id,"resolved");
  const duplicate=await completeAcdWrapup(pool,{workItemId:work.id,expectedAgentId:f.agentId,nextManualStatus:"Break"});
  assert.equal(duplicate.alreadyCompleted,true);assert.equal((await readAgentSnapshot(pool,f.agentId)).agent.status,"Available");
});

test("customer disconnect starts wrap-up; abandonment before acceptance does not",async()=>{
  const f=await fixture(),work=await f.create();await routeOne(pool,work.id);await act(work,f.agentId,"accept");
  await withTx(async tx=>{const current=(await tx.query("SELECT * FROM acd_work_items WHERE id=$1 FOR UPDATE",[work.id])).rows[0];await endCustomerChat(tx,current);});
  assert.equal((await readAgentSnapshot(pool,f.agentId)).agent.status,"Wrapup");
  await completeAcdWrapup(pool,{workItemId:work.id,expectedAgentId:f.agentId});
  const abandoned=await f.create();await routeOne(pool,abandoned.id);
  await withTx(async tx=>{const current=(await tx.query("SELECT * FROM acd_work_items WHERE id=$1 FOR UPDATE",[abandoned.id])).rows[0];await endCustomerChat(tx,current);});
  const snapshot=await readAgentSnapshot(pool,f.agentId);assert.equal(snapshot.pendingWrapup,null);assert.equal(snapshot.agent.status,"Available");
});

test("multiple ended chats retain Wrapup until every sheet is completed and Save & Break stays atomic",async()=>{
  const f=await fixture(),first=await f.create(),second=await f.create();
  for(const work of [first,second]){await routeOne(pool,work.id);await act(work,f.agentId,"accept");}
  await Promise.all([act(first,f.agentId,"disconnect"),act(second,f.agentId,"disconnect")]);
  const snapshot=await readAgentSnapshot(pool,f.agentId);const owner=snapshot.pendingWrapup.work_item_id;
  const remaining=[first,second].find(w=>w.id!==owner);
  await completeAcdWrapup(pool,{workItemId:owner,expectedAgentId:f.agentId,wrapupCodeId:"resolved",nextManualStatus:"Break"});
  const next=await readAgentSnapshot(pool,f.agentId);assert.equal(next.agent.status,"Wrapup");assert.equal(next.agent.manual_status,"Break");
  assert.equal(next.pendingWrapup.work_item_id,remaining.id);assert.equal((await findPendingAcdWrapupForAgent(pool,{agentId:f.agentId})).work_item_id,remaining.id);
  await completeAcdWrapup(pool,{workItemId:remaining.id,expectedAgentId:f.agentId,wrapupCodeId:"resolved"});
  const done=await readAgentSnapshot(pool,f.agentId);assert.equal(done.agent.status,"Break");assert.equal(done.agent.routability,"not_routable");
  assert.equal((await pool.query("SELECT count(*)::int n FROM acd_reservations WHERE agent_id=$1 AND state<>'released'",[f.agentId])).rows[0].n,0);
});

test("completing one wrap-up restores Busy for another active chat without releasing it",async()=>{
  const f=await fixture(),first=await f.create(),second=await f.create();
  for(const work of [first,second]){await routeOne(pool,work.id);await act(work,f.agentId,"accept");}
  await act(first,f.agentId,"disconnect");assert.equal((await readAgentSnapshot(pool,f.agentId)).agent.status,"Wrapup");
  await completeAcdWrapup(pool,{workItemId:first.id,expectedAgentId:f.agentId});
  const next=await readAgentSnapshot(pool,f.agentId);assert.equal(next.agent.status,"Busy");assert.equal(next.agent.workflow_work_item_id,second.id);
  assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE work_item_id=$1",[second.id])).rows[0].state,"active");
  assert.equal((await act(second,f.agentId,"send",{body:"Still connected"})).message.body,"Still connected");
});

test("an outstanding offer cannot be accepted while another chat owns Wrapup",async()=>{
  const f=await fixture(),active=await f.create(),offer=await f.create();
  await routeOne(pool,active.id);await act(active,f.agentId,"accept");await routeOne(pool,offer.id);
  await act(active,f.agentId,"disconnect");
  await assert.rejects(act(offer,f.agentId,"accept"),/Complete wrap-up/);
  await completeAcdWrapup(pool,{workItemId:active.id,expectedAgentId:f.agentId});
  await act(offer,f.agentId,"accept");assert.equal((await readAgentSnapshot(pool,f.agentId)).agent.status,"Busy");
});

test("shared completion rejects foreign and active chats, and text timeout closes the complete assignment",async()=>{
  const f=await fixture(),work=await f.create();await routeOne(pool,work.id);await act(work,f.agentId,"accept");
  assert.equal((await completeAcdWrapup(pool,{workItemId:work.id,expectedAgentId:f.agentId})).completed,false);
  await act(work,f.agentId,"disconnect");
  assert.equal((await completeAcdWrapup(pool,{workItemId:work.id,expectedAgentId:randomUUID()})).completed,false);
  await pool.query("UPDATE acd_text_assignments SET wrapup_deadline_at=now()-interval '1 second' WHERE work_item_id=$1",[work.id]);
  await pool.query("UPDATE acd_segments SET wrapup_deadline_at=now()-interval '1 second' WHERE work_item_id=$1 AND kind='agent'",[work.id]);
  await pool.query("UPDATE acd_agent_state SET workflow_deadline_at=now()-interval '1 second' WHERE agent_id=$1",[f.agentId]);
  await sweepWrapupDeadlines(pool);
  assert.equal((await pool.query("SELECT wrapup_ended_at FROM acd_segments WHERE work_item_id=$1 AND kind='agent'",[work.id])).rows[0].wrapup_ended_at,null);
  await sweepTextWrapups(pool);
  const row=(await pool.query("SELECT s.wrapup_code_id,a.state FROM acd_segments s JOIN acd_text_assignments a ON a.segment_id=s.id WHERE a.work_item_id=$1",[work.id])).rows[0];
  assert.equal(row.wrapup_code_id,"auto_timeout");assert.equal(row.state,"completed");assert.equal((await readAgentSnapshot(pool,f.agentId)).agent.status,"Available");
});

test("pre-sheet pending chats recover their original deadline and workflow after restart",async()=>{
  const f=await fixture(),work=await f.create();await routeOne(pool,work.id);await act(work,f.agentId,"accept");await act(work,f.agentId,"disconnect");
  const deadline=(await pool.query("SELECT wrapup_deadline_at FROM acd_text_assignments WHERE work_item_id=$1",[work.id])).rows[0].wrapup_deadline_at;
  await pool.query("UPDATE acd_segments SET wrapup_deadline_at=NULL WHERE work_item_id=$1 AND kind='agent'",[work.id]);
  await pool.query("UPDATE acd_agent_state SET workflow_state='handling',workflow_deadline_at=NULL WHERE agent_id=$1",[f.agentId]);
  await sweepTextWrapups(pool);
  const snapshot=await readAgentSnapshot(pool,f.agentId);assert.equal(snapshot.agent.status,"Wrapup");assert.deepEqual(snapshot.pendingWrapup.wrapup_deadline_at,deadline);
});

test("duplicate commands are idempotent and stale or foreign ownership is rejected",async()=>{
  const f=await fixture(), work=await f.create(); const offer=await routeOne(pool,work.id);
  const current=(await pool.query("SELECT version FROM acd_work_items WHERE id=$1",[work.id])).rows[0];
  const command={workItemId:work.id,agentId:f.agentId,commandId:randomUUID(),expectedVersion:current.version,action:"accept",offerId:offer.offerId};
  const accepted=await actOnTextWork(pool,command);assert.deepEqual(await actOnTextWork(pool,command),accepted);
  await assert.rejects(actOnTextWork(pool,{...command,action:"reject"}),/already used/);
  await assert.rejects(actOnTextWork(pool,{...command,commandId:randomUUID()}),/changed/);
  await assert.rejects(actOnTextWork(pool,{...command,agentId:randomUUID()}),/another agent/);
});

test("expired offers requeue durably and release capacity",async()=>{
  const f=await fixture(),work=await f.create();await routeOne(pool,work.id);
  await pool.query("UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE work_item_id=$1",[work.id]);
  await sweepDueSagas(pool,{provider:NATIVE_TEXT_PROVIDER});
  assert.equal((await pool.query("SELECT state FROM acd_work_items WHERE id=$1",[work.id])).rows[0].state,"queued");
  assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE work_item_id=$1",[work.id])).rows[0].state,"released");
});

test("lowering policy cancels unaccepted offers and lets accepted work drain",async()=>{
  const f=await fixture();const active=await f.create(),pending=await f.create();
  await routeOne(pool,active.id);await act(active,f.agentId,"accept");await routeOne(pool,pending.id);
  const settings=await readUtilization(pool,"agent",f.agentId);
  const policies=settings.policies.map(p=>p.channel==="chat"?{...p,maxConcurrent:1}:p);
  await saveUtilization(pool,{scope:"agent",id:f.agentId,policies,budget:1,expectedRevision:settings.revision,actor:"test-admin"});
  assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE work_item_id=$1",[active.id])).rows[0].state,"active");
  assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE work_item_id=$1",[pending.id])).rows[0].state,"released");
  await assert.rejects(saveUtilization(pool,{scope:"agent",id:f.agentId,policies,budget:1,expectedRevision:settings.revision,actor:"test-admin"}),/Settings changed/);
});

test("unreleased channels cannot enter the router even with a manually forged session",async()=>{
  const f=await fixture();const work=await withTx(async tx=>{
    const w=await createWorkItem(tx,{channel:"rcs",direction:"inbound",queueId:f.queueId});
    await applyTransition(tx,{workItemId:w.id,to:"queued",eventType:"test_queued",actor:"test"});return w;
  });
  assert.deepEqual(await routeOne(pool,work.id),{routed:false,reason:"channel_unavailable"});
});


test("higher chat cost revalidates every pending offer before retaining the oldest",async()=>{
  const f=await fixture({agentMax:2,queueMax:5,weight:0.2});
  const first=await f.create(),second=await f.create();
  await routeOne(pool,first.id);await routeOne(pool,second.id);
  const before=await readUtilization(pool,"agent",f.agentId);
  await saveUtilization(pool,{scope:"agent",id:f.agentId,expectedRevision:before.revision,actor:"admin",
    policies:before.policies.map(policy=>policy.channel==="chat"?{...policy,weight:0.6}:policy)});
  const live=(await pool.query("SELECT work_item_id,weight FROM acd_reservations WHERE agent_id=$1 AND state<>'released'",[f.agentId])).rows;
  assert.equal(live.length,1);assert.equal(live[0].work_item_id,first.id);assert.equal(Number(live[0].weight),0.6);
});
