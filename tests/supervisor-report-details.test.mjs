import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool, seedAgent, seedQueue } from "./helpers/acd-test-db.mjs";
import { readInteractionReport } from "../lib/acd/interaction-reporting.mjs";

const db = await prepareAcdTestPool("acd_core_test_supervisor_report_details");
after(() => db.end());
await db.query("CREATE TABLE IF NOT EXISTS cc_wrapup_codes(id TEXT PRIMARY KEY,name TEXT); DELETE FROM cc_wrapup_codes; INSERT INTO cc_wrapup_codes VALUES('resolved','Resolved'),('transfer','Transferred')");
await seedAgent(db,"alice");
await seedAgent(db,"bob");
await seedQueue(db,"sales",["alice"]);
await seedQueue(db,"support",["bob"]);
const scope={from:"2026-01-05T00:00:00Z",to:"2026-01-07T00:00:00Z",timezone:"UTC",bucket:"day",channel:null,queueId:null,agentId:null};
const at=seconds=>new Date(Date.parse("2026-01-05T10:00:00Z")+seconds*1000).toISOString();
async function item(channel,state="completed",created=0,ended=200,queue="support") {
  const id=randomUUID();
  await db.query("INSERT INTO acd_work_items(id,channel,direction,state,queue_id,created_at,terminal_at,terminal_reason,customer_address) VALUES($1,$2,'inbound',$3,$4,$5,$6,$7,'customer@test.example')",[id,channel,state,queue,at(created),at(ended),state==='failed'?'delivery_failed':state==='abandoned'?'customer_left':'resolved']);
  return id;
}
async function segment(id,seq,kind,queue,agent,start,end,{code=null,outcome="completed",wrapup=null,answered=null}={}) {
  await db.query("INSERT INTO acd_segments(id,work_item_id,seq,kind,queue_id,agent_id,started_at,ended_at,wrapup_code_id,outcome,wrapup_ended_at,answered_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[randomUUID(),id,seq,kind,queue,agent,at(start),at(end),code,outcome,wrapup==null?null:at(wrapup),answered==null?null:at(answered)]);
}
const voice=await item("voice");
await segment(voice,1,"queue_wait","sales",null,0,10);
await segment(voice,2,"agent","sales","alice",10,40,{code:"transfer",outcome:"transferred",answered:10});
await segment(voice,3,"queue_wait","support",null,40,60);
await segment(voice,4,"agent","support","bob",60,100,{code:"resolved",wrapup:110,answered:60});
await segment(voice,5,"agent","support","bob",110,200,{code:"resolved",answered:110});
const chat=await item("chat");
await segment(chat,1,"queue_wait","support",null,0,20);
await segment(chat,2,"agent","support","bob",20,200);
const email=await item("email","failed",-90000,100);
await segment(email,1,"queue_wait","support",null,-90000,100);
const abandoned=await item("voice","abandoned",0,25,"sales");
await segment(abandoned,1,"queue_wait","sales",null,0,25,{outcome:"abandoned"});
const unknownWait=await item("chat","abandoned");
const outside=await item("voice","completed",180000,180100);
await segment(outside,1,"agent","support","bob",180000,180100,{code:"resolved"});

test("queue report restores trends, arrival heatmap and queue-local durations after transfers",async()=>{
  const report=await readInteractionReport(db,scope,"queue-performance"),detail=report.detail;
  assert.equal(report.totals.closed,5);
  assert.equal(detail.trend[0].total,5);
  assert.equal(detail.heatmap.reduce((n,r)=>n+r.total,0),4); // Email arrived before the range.
  const support=detail.queues.find(r=>r.queue_id==='support'&&r.channel==='voice');
  assert.equal(support.total,1);assert.equal(support.avg_wait_seconds,20);assert.equal(support.avg_handling_seconds,140);assert.equal(support.avg_talk_seconds,130);
  assert.equal(detail.queues.find(r=>r.channel==='chat').avg_talk_seconds,null);
  assert.equal(detail.queues.find(r=>r.queue_id==='sales'&&r.channel==='voice').avg_wait_seconds,17.5);
  assert.equal(detail.queues.find(r=>r.queue_id==='sales').sla.rate,null);
});
test("agent scorecard counts distinct participation, sums repeated segments and respects queue attribution",async()=>{
  const { detail }=await readInteractionReport(db,scope,"agent-performance");
  assert.equal(detail.totals.agents,2);assert.equal(detail.totals.total,2);assert.equal(detail.totals.transfers,1);
  const bob=detail.agents.find(r=>r.agent_id==='bob'&&r.channel==='voice');
  assert.equal(bob.total,1);assert.equal(bob.avg_handling_seconds,140);assert.equal(bob.avg_talk_seconds,130);
  assert.equal(detail.agents.find(r=>r.channel==='chat').holds,null);
  const scoped=await readInteractionReport(db,{...scope,queueId:'sales'},"agent-performance");
  assert.deepEqual(scoped.detail.agents.map(r=>r.agent_id),['alice']);
  assert.equal(scoped.detail.agents[0].avg_handling_seconds,30);
});
test("abandonment restores wait buckets, reasons and recovery list without completed rows",async()=>{
  const {detail}=await readInteractionReport(db,scope,"abandonment");
  assert.deepEqual(new Set(detail.recent.map(r=>r.id)),new Set([email,abandoned,unknownWait]));
  assert.equal(detail.buckets.find(r=>r.label==='24h+').failed,1);
  assert.equal(detail.buckets.find(r=>r.label==='Not recorded').abandoned,1);
  assert.equal(detail.buckets.find(r=>r.label==='10–30s').abandoned,1);
  assert.equal(detail.reasons.find(r=>r.reason==='delivery_failed').total,1);
  assert.equal(detail.hourly.reduce((n,r)=>n+r.total,0),5);
});
test("wrap-up coverage uses distinct completed interactions, including repeated codes and uncoded segments",async()=>{
  const {detail}=await readInteractionReport(db,scope,"wrapup-codes");
  assert.deepEqual(detail.totals,{eligible:2,coded:1,distinct_codes:2});
  const code=detail.codes.find(r=>r.wrapup_code_id==='resolved');
  assert.equal(code.interactions,1);assert.equal(code.segments,2);
  assert.equal(detail.trend.find(r=>r.wrapup_code_id==='resolved').interactions,1);
  assert.equal(detail.queues.find(r=>r.wrapup_code_id==='transfer').queue_id,'sales');
});
test("all specialized reports filter channels, queues, agents and empty date ranges",async()=>{
  for(const type of ['queue-performance','agent-performance','abandonment','wrapup-codes']){
    const report=await readInteractionReport(db,{...scope,channel:'chat',queueId:'support',agentId:'bob'},type);
    assert.equal(report.totals.closed,1);assert.equal(report.detail.report,type);
    for(const rows of [report.detail.queues,report.detail.agents,report.detail.codes,report.detail.reasons,report.detail.recent])
      for(const row of rows||[])assert.equal(row.channel,'chat');
    const empty=await readInteractionReport(db,{...scope,from:'2025-01-01T00:00:00Z',to:'2025-01-02T00:00:00Z'},type);
    assert.equal(empty.totals.closed,0);
    assert.equal(empty.detail.trend?.length||empty.detail.recent?.length||0,0);
  }
});

test("SLA uses recorded queue policy evidence and includes measurements without closed work",async()=>{
  await seedQueue(db,'sla-only',[]);
  const id=await item('chat','active',0,100,'sla-only');
  await db.query('UPDATE acd_work_items SET terminal_at=NULL WHERE id=$1',[id]);
  await db.query(`INSERT INTO acd_sla_measurements(id,work_item_id,scope_key,channel,queue_id,policy,started_at,deadline_at,served_at)
    VALUES($1,$2,'interaction','chat','sla-only',$3,$4,$5,$6)`,[randomUUID(),id,JSON.stringify({status:'configured',thresholdSeconds:60,targetPercentage:92}),at(0),at(60),at(30)]);
  const {detail}=await readInteractionReport(db,{...scope,queueId:'sla-only'},'queue-performance');
  assert.equal(detail.queues.length,1);assert.equal(detail.queues[0].total,0);
  assert.equal(detail.queues[0].sla.rate,100);assert.equal(detail.queues[0].sla.target,92);assert.equal(detail.queues[0].sla.denominator,1);
});

test("agent reply times require human service evidence and accepted delivery",async()=>{
  const id=await item('email');
  await segment(id,1,'agent','support','bob',10,200);
  const conversation=randomUUID(),message=randomUUID();
  await db.query("INSERT INTO acd_conversations(id,channel) VALUES($1,'email')",[conversation]);
  await db.query("INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,created_at) VALUES($1,$2,$3,'agent','bob','reply',$4)",[message,conversation,id,at(30)]);
  await db.query("INSERT INTO acd_events(work_item_id,agent_id,type,payload,actor,occurred_at) VALUES($1,'bob','email_send_updated',$2,'test',$3)",[id,JSON.stringify({message_id:message,status:'failed'}),at(40)]);
  const failed=await readInteractionReport(db,{...scope,channel:'email'},'agent-performance');
  assert.equal(failed.detail.agents[0].avg_response_seconds,null);
  await db.query("INSERT INTO acd_events(work_item_id,agent_id,type,payload,actor,occurred_at) VALUES($1,'bob','email_send_updated',$2,'test',$3)",[id,JSON.stringify({message_id:message,status:'accepted'}),at(70)]);
  const accepted=await readInteractionReport(db,{...scope,channel:'email'},'agent-performance');
  assert.equal(accepted.detail.agents[0].avg_response_seconds,60);
  assert.equal(accepted.detail.agents[0].avg_talk_seconds,null);
});

test("holds are assigned to the owning agent segment and not repeated for every participant",async()=>{
  for(const [type,time] of [['hold_started',70],['hold_ended',80]])
    await db.query("INSERT INTO acd_events(work_item_id,agent_id,type,payload,actor,occurred_at) VALUES($1,'bob',$2,'{}','test',$3)",[voice,type,at(time)]);
  const {detail}=await readInteractionReport(db,{...scope,channel:'voice'},'agent-performance');
  const bob=detail.agents.find(r=>r.agent_id==='bob'),alice=detail.agents.find(r=>r.agent_id==='alice');
  assert.equal(bob.holds,1);assert.equal(bob.hold_seconds,10);assert.equal(alice.holds,0);
});
