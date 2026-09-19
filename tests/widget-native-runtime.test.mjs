import { test,after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool,seedAgent,seedQueue } from "./helpers/acd-test-db.mjs";
import { createWidget,updateWidgetDraft,publishWidget,updateWidget } from "../lib/widgets/store.js";
import { createWidgetBootstrapToken,verifyWidgetBootstrapToken,attachmentAccessToken,verifyAttachmentAccessToken,widgetAdmissionKey } from "../lib/widgets/session-tokens.js";
import { widgetTestOrigin } from "../lib/widgets/config.js";
import { startWidgetSession,getWidgetSession,readWidgetConversation,actAsWidgetCustomer } from "../lib/widgets/sessions.js";
import { uploadTextAttachment,attachmentResponse,validateAttachment,receiveTextAttachment,admitTextAttachment } from "../lib/widgets/attachments.js";
import { heartbeatAgentSession } from "../lib/acd/sessions.mjs";
import { routeOne } from "../lib/acd/router.mjs";
import { actOnTextWork,sweepTextInactivity,sweepTextWrapups } from "../lib/acd/text-lifecycle.mjs";
import { clearSagaDeadlineWakeups } from "../lib/acd/saga-engine.mjs";
import { readTextDetail,saveTextDraft } from "../lib/acd/text-desktop.mjs";
import { drainQueuedOnce } from "../lib/acd/worker.mjs";
import { createWorkItem,applyTransition } from "../lib/acd/lifecycle.mjs";
import { transferTextWork } from "../lib/acd/text-transfer.mjs";
import { completeAcdWrapup } from "../lib/acd/wrapup.mjs";
import { receiveAgentChatMessage,readAgentChatCommand } from "../lib/contact-center/chat-message-upload.js";
import { withStreamedChatMessage } from "../lib/widgets/multipart-upload.js";

process.env.WIDGET_SESSION_SIGNING_SECRET="widget-runtime-test-only-signing-key-at-least-32-characters";
const pool=await prepareAcdTestPool("acd_core_test_widget_runtime");
await pool.query(`DROP TABLE IF EXISTS cc_queue_wrapup_codes,cc_wrapup_codes;
  CREATE TABLE cc_wrapup_codes(id TEXT PRIMARY KEY,name TEXT,is_active BOOLEAN DEFAULT true);
  CREATE TABLE cc_queue_wrapup_codes(queue_id TEXT,wrapup_code_id TEXT);
  INSERT INTO cc_wrapup_codes VALUES('resolved','Resolved',true);`);
after(async()=>{clearSagaDeadlineWakeups();await pool.end();});
const origin="https://customer.example.com";
async function fixture(configure=()=>{}){
  const queueId=randomUUID(),agentId=randomUUID();await seedAgent(pool,agentId,{voiceReady:false});await seedQueue(pool,queueId,[agentId]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,3,0.3)",[queueId]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,2,0.3)",[agentId]);
  await heartbeatAgentSession(pool,{agentId,sessionId:randomUUID(),chatReady:true});
  let widget=await createWidget(pool,{name:randomUUID(),actor:"admin"});
  const config=structuredClone(widget.draft.config);config.allowedOrigins=[origin];config.decisions.enabled=false;
  config.channels.messaging.routing={queueId,queueName:"Support",queues:[{id:queueId,name:"Support"}]};
  configure(config);
  widget=await updateWidgetDraft(pool,{id:widget.id,config,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor:"admin"});
  widget=await publishWidget(pool,{id:widget.id,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor:"admin"},{provisionHandoff:async()=>({id:"test-shared-handoff"})});
  const bootstrapToken=createWidgetBootstrapToken({publicId:widget.publicId,revisionId:widget.published.id,origin});
  const start={publicId:widget.publicId,bootstrapToken,clientKey:randomUUID(),context:{}};
  return {agentId,widget,start};
}
async function accepted(f,token){
  const session=await getWidgetSession(pool,token);
  const work=(await pool.query("SELECT * FROM acd_work_items WHERE conversation_id=$1",[session.conversation_id])).rows[0];
  const offer=await routeOne(pool,work.id);
  const current=(await pool.query("SELECT version FROM acd_work_items WHERE id=$1",[work.id])).rows[0];
  await actOnTextWork(pool,{workItemId:work.id,agentId:f.agentId,action:"accept",commandId:randomUUID(),expectedVersion:current.version,offerId:offer.offerId});
  return work;
}
function messageUpload(message,files){
  const form=new FormData();form.set('message',JSON.stringify(message));for(const file of files)form.append('file',file);
  return new Request('https://test.local',{method:'POST',body:form});
}
async function agentMessageFixture(body='Attached are the details',configure){
  const f=await fixture(configure),started=await startWidgetSession(pool,f.start),work=await accepted(f,started.sessionToken);
  const draft=await saveTextDraft(pool,{workItemId:work.id,agentId:f.agentId,body,expectedVersion:'0'});
  const detail=await readTextDetail(pool,{workItemId:work.id,agentId:f.agentId});
  return {...f,started,work,identity:{workItemId:work.id,agentId:f.agentId},message:{commandId:randomUUID(),expectedVersion:detail.work.version,draftVersion:draft.version,body}};
}
test('Markdown uploads from agent and widget normalize browser MIME variants and retain previewable content',async()=>{
  const f=await agentMessageFixture(),content='# Shared notes\n\n**Zażółć**';
  const files=['text/markdown','text/x-markdown','text/plain','application/octet-stream',''].map((type,i)=>new File([content],`notes-${i}.md`,{type}));
  await receiveAgentChatMessage(pool,{...f.identity,request:messageUpload(f.message,files)});
  for(const file of files){
    const form=new FormData();form.set('file',file);form.set('messageId',randomUUID());
    await receiveTextAttachment(pool,{token:f.started.sessionToken,request:new Request('https://test.local',{method:'POST',body:form})});
  }
  const rows=(await pool.query('SELECT * FROM acd_text_attachments WHERE conversation_id=$1',[f.work.conversation_id])).rows;
  assert.equal(rows.length,10);
  for(const row of rows){assert.equal(row.content_type,'text/markdown');assert.equal(row.bytes.toString(),content);}
  const visitor=await readWidgetConversation(pool,await getWidgetSession(pool,f.started.sessionToken));
  assert.equal(visitor.messages.flatMap(message=>message.attachments||[]).length,10);
  const detail=await readTextDetail(pool,f.identity);assert.equal(detail.messages.flatMap(message=>message.attachments||[]).length,10);
  const preview=await attachmentResponse(new Request('https://test.local?preview=1'),rows[0]);
  assert.deepEqual(await preview.json(),{kind:'markdown',text:content,truncated:false});
});
test('disabling Markdown rejects widget and agent uploads even when the browser reports plain text',async()=>{
  const f=await agentMessageFixture('Notes',config=>{
    for(const direction of ['inboundMimeTypes','outboundMimeTypes'])config.features.attachmentPolicy[direction]=['text/plain'];
  });
  const file=new File(['# Notes'],'notes.md',{type:'text/plain'});
  await assert.rejects(receiveAgentChatMessage(pool,{...f.identity,request:messageUpload(f.message,[file])}),{status:403});
  const form=new FormData();form.set('file',file);form.set('messageId',randomUUID());
  await assert.rejects(receiveTextAttachment(pool,{token:f.started.sessionToken,request:new Request('https://test.local',{method:'POST',body:form})}),{status:403});
  const detail=await readTextDetail(pool,f.identity);assert.equal(detail.messages.length,0);assert.equal(detail.draft.body,'Notes');
});
test('agent multipart send publishes one caption with all attachments and clears its saved draft atomically',async()=>{
  const f=await agentMessageFixture(),files=[new File(['First attachment'],'first.txt',{type:'text/plain'}),new File(['Second attachment'],'drugi.txt',{type:'text/plain'})];
  const sent=await receiveAgentChatMessage(pool,{...f.identity,request:messageUpload(f.message,files)});
  const detail=await readTextDetail(pool,f.identity);assert.equal(detail.messages.length,1);assert.equal(detail.messages[0].body,f.message.body);assert.equal(detail.messages[0].attachments.length,2);
  assert.equal(detail.draft.body,'');assert.equal(String(detail.draft.version),sent.draftVersion);
  const visitor=await readWidgetConversation(pool,await getWidgetSession(pool,f.started.sessionToken));
  assert.equal(visitor.messages.length,1);assert.equal(visitor.messages[0].content,f.message.body);assert.equal(visitor.messages[0].attachments.length,2);
  assert.equal((await pool.query("SELECT count(*)::int n FROM acd_events WHERE work_item_id=$1 AND type='text_message_created'",[f.work.id])).rows[0].n,1);
});
test('attachment-only messages retain empty captions and concurrent sends create one command and one file set',async()=>{
  const f=await agentMessageFixture(''),files=[new File(['One'],'one.txt',{type:'text/plain'}),new File(['Two'],'two.txt',{type:'text/plain'})];
  const results=await Promise.all([1,2].map(()=>receiveAgentChatMessage(pool,{...f.identity,request:messageUpload(f.message,files)})));
  assert.deepEqual(JSON.parse(JSON.stringify(results[0])),JSON.parse(JSON.stringify(results[1])));const detail=await readTextDetail(pool,f.identity);
  assert.equal(detail.messages.length,1);assert.equal(detail.messages[0].body,'');assert.equal(detail.messages[0].attachments.length,2);
  await assert.rejects(receiveAgentChatMessage(pool,{...f.identity,request:messageUpload({...f.message,body:'Changed'},files)}),/already used/);
  await assert.rejects(receiveAgentChatMessage(pool,{...f.identity,request:messageUpload(f.message,[new File(['Changed'],'one.txt',{type:'text/plain'})])}),/already used/);
});
test('confirmation reads only the original actor command after transfer without uploading the files again',async()=>{
  const f=await agentMessageFixture(),sent=await receiveAgentChatMessage(pool,{...f.identity,request:messageUpload(f.message,[new File(['File'],'file.txt',{type:'text/plain'})])});
  const detail=await readTextDetail(pool,f.identity);
  await transferTextWork(pool,{...f.identity,queueId:detail.work.queue_id,expectedVersion:detail.work.version,commandId:randomUUID()});
  assert.deepEqual(await readAgentChatCommand(pool,{...f.identity,commandId:f.message.commandId}),{result:JSON.parse(JSON.stringify(sent))});
  assert.deepEqual(await readAgentChatCommand(pool,{...f.identity,agentId:'another-agent',commandId:f.message.commandId}),{result:null});
  assert.deepEqual(await readAgentChatCommand(pool,{...f.identity,commandId:randomUUID()}),{result:null});
});
test('invalid files, excess file count and stale versions preserve the caption draft and publish nothing',async()=>{
  const f=await agentMessageFixture(),good=new File(['Good'],'good.txt',{type:'text/plain'}),bad=new File(['Not an image'],'bad.png',{type:'image/png'});
  await assert.rejects(receiveAgentChatMessage(pool,{...f.identity,request:messageUpload(f.message,[good,bad])}),/content does not match/);
  await assert.rejects(receiveAgentChatMessage(pool,{...f.identity,request:messageUpload(f.message,Array(6).fill(good))}));
  await assert.rejects(receiveAgentChatMessage(pool,{...f.identity,request:messageUpload({...f.message,expectedVersion:'9999'},[good])}),/changed/);
  const detail=await readTextDetail(pool,f.identity);assert.equal(detail.messages.length,0);assert.equal(detail.draft.body,f.message.body);
  assert.equal((await pool.query('SELECT 1 FROM acd_text_attachments WHERE conversation_id=$1',[f.work.conversation_id])).rowCount,0);
  assert.equal((await pool.query('SELECT 1 FROM cc_attachment_uploads WHERE conversation_id=$1 AND finished_at IS NULL',[f.work.conversation_id])).rowCount,0);
});
test('agent batch admission rejects another agent before reading multipart bytes',async()=>{
  const f=await agentMessageFixture();let reads=0;
  await assert.rejects(receiveAgentChatMessage(pool,{...f.identity,agentId:'another-agent',request:{get body(){reads++;throw Error('Body read');}}}),{status:403});
  assert.equal(reads,0);
});
test('batch streaming enforces aggregate and individual byte limits before consuming attachments',async()=>{
  const policy={mimeTypes:['text/plain'],maximumBytes:20,maximumTotalBytes:30,maximumFiles:5};let consumed=0;
  for(const sizes of [[16,16],[21]]){
    const files=sizes.map((n,i)=>new File(['a'.repeat(n)],`${i}.txt`,{type:'text/plain'}));
    await assert.rejects(withStreamedChatMessage(messageUpload({body:'caption'},files),policy,()=>{consumed++;}),{status:413});
  }
  assert.equal(consumed,0);
});
test("chat transfer keeps the visitor session and attachments while replacing the connected agent",async()=>{
  const source=await fixture(),target=await fixture(),started=await startWidgetSession(pool,source.start);
  await pool.query("UPDATE users SET first_name='Morgan',last_name='Brooks' WHERE id=$1",[target.agentId]);
  await uploadTextAttachment(pool,{token:started.sessionToken,file:new File(['Transfer attachment'],'notes.txt',{type:'text/plain'}),clientId:randomUUID()});
  const work=await accepted(source,started.sessionToken),detail=await readTextDetail(pool,{workItemId:work.id,agentId:source.agentId});
  const targetQueueId=target.widget.draft.config.channels.messaging.routing.queueId;
  await transferTextWork(pool,{workItemId:work.id,agentId:source.agentId,queueId:targetQueueId,targetAgentId:target.agentId,expectedVersion:detail.work.version,commandId:randomUUID()});
  const session=await getWidgetSession(pool,started.sessionToken),offered=await readWidgetConversation(pool,session);
  assert.equal(offered.handoff.status,'assigned');assert.equal(offered.handoff.agentName,'Morgan Brooks');assert.equal(offered.handoff.agentConnected,false);assert.equal(offered.handoff.agentTypingUntil,null);
  assert.equal(offered.messages[0].attachments[0].filename,'notes.txt');
  await actAsWidgetCustomer(pool,{token:started.sessionToken,action:'send',content:'Still here during transfer',messageId:randomUUID()});
  const offer=(await pool.query("SELECT * FROM acd_offers WHERE work_item_id=$1 AND state IN ('created','ringing')",[work.id])).rows[0];
  const incoming=await readTextDetail(pool,{workItemId:work.id,agentId:target.agentId});assert.equal(incoming.messages[0].attachments.length,1);
  await actOnTextWork(pool,{workItemId:work.id,agentId:target.agentId,action:'accept',commandId:randomUUID(),expectedVersion:incoming.work.version,offerId:offer.id});
  const connected=await readWidgetConversation(pool,await getWidgetSession(pool,started.sessionToken));assert.equal(connected.handoff.agentConnected,true);assert.equal(connected.handoff.status,'connected');assert.equal(connected.messages.at(-1).content,'Still here during transfer');
  assert.equal(connected.handoff.agentName,'Morgan Brooks');
  await completeAcdWrapup(pool,{workItemId:work.id,expectedAgentId:source.agentId,wrapupCodeId:'resolved'});
  assert.deepEqual((await readWidgetConversation(pool,session)).handoff,connected.handoff);
  const current=await readTextDetail(pool,{workItemId:work.id,agentId:target.agentId});
  await transferTextWork(pool,{workItemId:work.id,agentId:target.agentId,queueId:source.widget.draft.config.channels.messaging.routing.queueId,expectedVersion:current.work.version,commandId:randomUUID()});
  const waiting=await readWidgetConversation(pool,session);assert.equal(waiting.handoff.status,'waiting');assert.equal(waiting.handoff.agentConnected,false);assert.equal(waiting.handoff.agentName,null);
});
test("a late source wrap-up cannot replace the final agent in a closed visitor conversation",async()=>{
  const source=await fixture(),target=await fixture(),started=await startWidgetSession(pool,source.start);
  await pool.query("UPDATE users SET first_name='Morgan',last_name='Brooks' WHERE id=$1",[target.agentId]);
  const work=await accepted(source,started.sessionToken),detail=await readTextDetail(pool,{workItemId:work.id,agentId:source.agentId});
  await transferTextWork(pool,{workItemId:work.id,agentId:source.agentId,queueId:target.widget.draft.config.channels.messaging.routing.queueId,
    targetAgentId:target.agentId,expectedVersion:detail.work.version,commandId:randomUUID()});
  const incoming=await readTextDetail(pool,{workItemId:work.id,agentId:target.agentId});
  const offer=(await pool.query("SELECT id FROM acd_offers WHERE work_item_id=$1 AND state IN ('created','ringing')",[work.id])).rows[0];
  await actOnTextWork(pool,{workItemId:work.id,agentId:target.agentId,action:'accept',commandId:randomUUID(),expectedVersion:incoming.work.version,offerId:offer.id});
  await actAsWidgetCustomer(pool,{token:started.sessionToken,action:'disconnect'});
  await completeAcdWrapup(pool,{workItemId:work.id,expectedAgentId:target.agentId,wrapupCodeId:'resolved'});
  await completeAcdWrapup(pool,{workItemId:work.id,expectedAgentId:source.agentId,wrapupCodeId:'resolved'});
  const closed=await readWidgetConversation(pool,await getWidgetSession(pool,started.sessionToken));
  assert.equal(closed.handoff.status,'disconnected');assert.equal(closed.handoff.agentName,'Morgan Brooks');
});
test("bootstrap binds widget, revision, origin and expiry",()=>{
  const token=createWidgetBootstrapToken({publicId:"widget",revisionId:"revision",origin,now:1000000});
  assert.equal(verifyWidgetBootstrapToken(token,{publicId:"widget",now:1000000}).org,origin);
  assert.throws(()=>verifyWidgetBootstrapToken(token,{publicId:"other",now:1000000}));
  assert.throws(()=>verifyWidgetBootstrapToken(token,{publicId:"widget",now:1300000}));
  assert.throws(()=>verifyWidgetBootstrapToken(token+"x",{publicId:"widget",now:1000000}));
});
test("retrying session creation makes exactly one conversation and returns the same opaque token",async()=>{
  const f=await fixture();const [a,b]=await Promise.all([startWidgetSession(pool,f.start),startWidgetSession(pool,f.start)]);
  assert.equal(a.sessionToken,b.sessionToken);assert.equal(a.handoff.status,"waiting");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cc_widget_sessions WHERE widget_id=$1",[f.widget.id])).rows[0].n,1);
  const resumed=await startWidgetSession(pool,{...f.start,clientKey:randomUUID(),sessionToken:a.sessionToken});assert.equal(resumed.sessionToken,a.sessionToken);
  const row=(await pool.query("SELECT token_hash FROM cc_widget_sessions WHERE widget_id=$1",[f.widget.id])).rows[0];assert.notEqual(row.token_hash,a.sessionToken);
});
test("a client admission burst cannot exhaust admission for other visitors and retries stay idempotent",async()=>{
  const f=await fixture();
  const first=await startWidgetSession(pool,{...f.start,admissionKey:"client-one"});
  const results=await Promise.allSettled(Array.from({length:12},()=>startWidgetSession(pool,{...f.start,admissionKey:"client-one",clientKey:randomUUID()})));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,9);
  assert.equal(results.filter(r=>r.status==="rejected"&&r.reason.status===429).length,3);
  assert.equal((await startWidgetSession(pool,{...f.start,admissionKey:"client-one"})).sessionToken,first.sessionToken);
  await startWidgetSession(pool,{...f.start,admissionKey:"client-two",clientKey:randomUUID()});
  assert.equal((await pool.query("SELECT count(*)::int n FROM cc_widget_sessions WHERE widget_id=$1",[f.widget.id])).rows[0].n,11);
  assert.equal((await pool.query("SELECT count(*)::int n FROM acd_work_items WHERE attributes->>'widget_id'=$1",[f.widget.id])).rows[0].n,11);
});
test("admission identity ignores spoofed leading forwarding entries and normalizes addresses",()=>{
  const original=process.env.WIDGET_TRUSTED_PROXY_HOPS;process.env.WIDGET_TRUSTED_PROXY_HOPS="1";
  const key=forwarded=>widgetAdmissionKey({headers:new Headers({"x-forwarded-for":forwarded})});
  try{
    assert.equal(key("198.51.100.2, 203.0.113.9"),key("192.0.2.1, 203.0.113.9"));
    assert.notEqual(key("203.0.113.9"),key("203.0.113.10"));
    assert.equal(key("::ffff:203.0.113.9"),key("203.0.113.9"));
    assert.equal(key("2001:db8:0:0:0:0:0:1"),key("2001:db8::1"));
    assert.equal(key("garbage"),key(""));
  }finally{if(original===undefined)delete process.env.WIDGET_TRUSTED_PROXY_HOPS;else process.env.WIDGET_TRUSTED_PROXY_HOPS=original;}
});
test("a full unroutable voice batch cannot starve an eligible chat",async()=>{
  const f=await fixture(),blockedQueue=randomUUID();await seedQueue(pool,blockedQueue,[]);
  const tx=await pool.connect();
  try{
    await tx.query("BEGIN");
    for(let i=0;i<20;i++){
      const work=await createWorkItem(tx,{channel:"voice",direction:"inbound",queueId:blockedQueue,priority:100,actor:"test"});
      await applyTransition(tx,{workItemId:work.id,to:"queued",eventType:"work_item_queued",actor:"test"});
    }
    await tx.query("COMMIT");
  }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
  const started=await startWidgetSession(pool,f.start),session=await getWidgetSession(pool,started.sessionToken);
  await drainQueuedOnce(pool,{});
  const offer=(await pool.query("SELECT o.agent_id FROM acd_offers o JOIN acd_work_items w ON w.id=o.work_item_id WHERE w.conversation_id=$1",[session.conversation_id])).rows[0];
  assert.equal(offer.agent_id,f.agentId);
});
test("customer messages are deduplicated and delivered to the assigned agent, who can reply and wrap up",async()=>{
  const f=await fixture(),started=await startWidgetSession(pool,f.start),id=randomUUID();
  const send={token:started.sessionToken,action:"send",content:"I need help",messageId:id};
  await actAsWidgetCustomer(pool,send);await actAsWidgetCustomer(pool,send);
  await assert.rejects(actAsWidgetCustomer(pool,{...send,content:"Changed"}),/already used/);
  const work=await accepted(f,started.sessionToken);let detail=await readTextDetail(pool,{workItemId:work.id,agentId:f.agentId});
  assert.equal(detail.messages.length,1);
  const draft=await saveTextDraft(pool,{workItemId:work.id,agentId:f.agentId,body:"Draft retained",expectedVersion:"0"});
  await assert.rejects(saveTextDraft(pool,{workItemId:work.id,agentId:f.agentId,body:"Stale",expectedVersion:"0"}),/another session/);
  assert.equal(draft.body,"Draft retained");
  await actOnTextWork(pool,{workItemId:work.id,agentId:f.agentId,action:"send",body:"How can I help?",commandId:randomUUID(),expectedVersion:detail.work.version});
  const state=await readWidgetConversation(pool,await getWidgetSession(pool,started.sessionToken));
  assert.equal(state.handoff.status,"connected");assert.equal(state.messages[1].content,"How can I help?");
  await actAsWidgetCustomer(pool,{token:started.sessionToken,action:"disconnect"});
  detail=await readTextDetail(pool,{workItemId:work.id,agentId:f.agentId});
  await actOnTextWork(pool,{workItemId:work.id,agentId:f.agentId,action:"wrapup",codeId:"resolved",commandId:randomUUID(),expectedVersion:detail.work.version});
  assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE work_item_id=$1",[work.id])).rows[0].state,"released");
});
test("disabled widgets pause new admission while existing sessions drain and forged queue context cannot escape the allowlist",async()=>{
  const f=await fixture();const started=await startWidgetSession(pool,{...f.start,context:{"routing.queue":randomUUID(),"customer.authenticated":true}});
  const session=await getWidgetSession(pool,started.sessionToken);
  const work=(await pool.query("SELECT queue_id FROM acd_work_items WHERE conversation_id=$1",[session.conversation_id])).rows[0];
  assert.equal(work.queue_id,f.widget.draft.config.channels.messaging.routing.queueId);
  await updateWidget(pool,{id:f.widget.id,name:f.widget.name,enabled:false,actor:"admin"});
  assert.equal((await getWidgetSession(pool,started.sessionToken)).id,session.id);
  await assert.rejects(startWidgetSession(pool,{...f.start,clientKey:randomUUID()}),/changed or origin/);
});
test("a test-page session runs under a marked origin that is not on the allowlist, and an unmarked foreign origin is refused",async()=>{
  const f=await fixture();const foreign="https://cc.example.test";
  const token=value=>createWidgetBootstrapToken({publicId:f.widget.publicId,revisionId:f.widget.published.id,origin:value});
  await assert.rejects(startWidgetSession(pool,{...f.start,bootstrapToken:token(foreign),clientKey:randomUUID()}),/changed or origin/);
  const started=await startWidgetSession(pool,{...f.start,bootstrapToken:token(widgetTestOrigin(foreign)),clientKey:randomUUID()});
  const session=await getWidgetSession(pool,started.sessionToken);
  assert.equal(session.origin,`cc-test:${foreign}`);
  const work=(await pool.query("SELECT attributes FROM acd_work_items WHERE conversation_id=$1",[session.conversation_id])).rows[0];
  assert.equal(work.attributes.origin,`cc-test:${foreign}`);
});
test("attachments enforce content policy, idempotency, scoped access and byte ranges",async()=>{
  const f=await fixture(),started=await startWidgetSession(pool,f.start),clientId=randomUUID();
  const file=new File(["A safe text attachment"],"załącznik.txt",{type:"text/plain"});
  const params={token:started.sessionToken,file,clientId};
  await uploadTextAttachment(pool,params);await uploadTextAttachment(pool,params);
  const session=await getWidgetSession(pool,started.sessionToken);
  const files=(await pool.query("SELECT * FROM acd_text_attachments WHERE conversation_id=$1",[session.conversation_id])).rows;assert.equal(files.length,1);
  const access=attachmentAccessToken({attachmentId:files[0].id,sessionId:session.id,now:1000000});
  assert.equal(verifyAttachmentAccessToken(access,{attachmentId:files[0].id,now:1000000}).s,session.id);
  assert.throws(()=>verifyAttachmentAccessToken(access,{attachmentId:randomUUID(),now:1000000}));
  assert.throws(()=>verifyAttachmentAccessToken(access,{attachmentId:files[0].id,now:2000000}));
  const response=attachmentResponse(new Request("https://test.local",{headers:{Range:"bytes=2-5"}}),files[0]);
  assert.equal(response.headers.get("content-length"),"4");
  assert.equal(response.status,206);assert.equal(await response.text(),"safe");assert.ok(response.headers.get("content-disposition").includes("filename*=UTF-8''"));
  assert.throws(()=>validateAttachment(Buffer.from("<script>alert(1)</script>"),"image/png"),/content does not match/);
  const oversized=new File([Buffer.alloc(11*1048576,65)],"large.txt",{type:"text/plain"});
  await assert.rejects(uploadTextAttachment(pool,{token:started.sessionToken,file:oversized,clientId:randomUUID()}),/size limit/);
});


test("business inactivity abandons waiting work and moves accepted work through wrap-up",async()=>{
  for(const offerFirst of [false,true]){
    const f=await fixture(),started=await startWidgetSession(pool,f.start);
    const session=await getWidgetSession(pool,started.sessionToken);
    const work=(await pool.query("SELECT * FROM acd_work_items WHERE conversation_id=$1",[session.conversation_id])).rows[0];
    if(offerFirst)await routeOne(pool,work.id);
    await pool.query("UPDATE cc_widget_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[session.id]);
    await sweepTextInactivity(pool);
    assert.equal((await pool.query("SELECT state FROM acd_work_items WHERE id=$1",[work.id])).rows[0].state,"abandoned");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_reservations WHERE work_item_id=$1 AND state<>'released'",[work.id])).rows[0].n,0);
  }
  const f=await fixture(),started=await startWidgetSession(pool,f.start),work=await accepted(f,started.sessionToken);
  await pool.query("UPDATE cc_widget_sessions SET expires_at=now()+interval '5 seconds' WHERE conversation_id=$1",[work.conversation_id]);
  const current=(await readTextDetail(pool,{workItemId:work.id,agentId:f.agentId})).work;
  await actOnTextWork(pool,{workItemId:work.id,agentId:f.agentId,action:"send",body:"Still helping",commandId:randomUUID(),expectedVersion:current.version});
  assert((await getWidgetSession(pool,started.sessionToken)).expires_at>new Date(Date.now()+60000));
  await pool.query("UPDATE cc_widget_sessions SET expires_at=now()-interval '1 second' WHERE conversation_id=$1",[work.conversation_id]);
  await sweepTextInactivity(pool);
  assert.equal((await pool.query("SELECT state FROM acd_text_assignments WHERE work_item_id=$1",[work.id])).rows[0].state,"wrapup");
  assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE work_item_id=$1",[work.id])).rows[0].state,"active");
  await pool.query("UPDATE acd_text_assignments SET wrapup_deadline_at=now()-interval '1 second' WHERE work_item_id=$1",[work.id]);
  await sweepTextWrapups(pool);
  assert.equal((await pool.query("SELECT state FROM acd_work_items WHERE id=$1",[work.id])).rows[0].state,"completed");
});

test("attachment policy and admission are enforced before reading any request body",async()=>{
  const f=await fixture(),started=await startWidgetSession(pool,f.start);
  let reads=0;
  const request={headers:new Headers(),get body(){reads++;throw Error("Body must not be read");}};
  const session=await getWidgetSession(pool,started.sessionToken);
  const identity={token:started.sessionToken};
  const admissions=await Promise.all([admitTextAttachment(pool,identity),admitTextAttachment(pool,identity)]);
  await assert.rejects(receiveTextAttachment(pool,{...identity,request}),{status:429});
  assert.equal(reads,0);
  await pool.query("UPDATE cc_attachment_uploads SET finished_at=now() WHERE conversation_id=$1",[session.conversation_id]);
  for(let i=0;i<8;i++){
    const admitted=await admitTextAttachment(pool,identity);
    await pool.query("UPDATE cc_attachment_uploads SET finished_at=now() WHERE id=$1",[admitted.id]);
  }
  await assert.rejects(receiveTextAttachment(pool,{...identity,request}),{status:429});
  await pool.query("DELETE FROM cc_attachment_uploads WHERE conversation_id=$1",[session.conversation_id]);
  await pool.query("UPDATE acd_conversations SET state='closed' WHERE id=$1",[session.conversation_id]);
  await assert.rejects(receiveTextAttachment(pool,{...identity,request}),{status:409});
  assert.equal(reads,0);assert.equal(admissions.length,2);
});
test("disabled and AI attachment policies reject a public token before reading its body",async()=>{
  const f=await fixture(),started=await startWidgetSession(pool,f.start);
  const session=await getWidgetSession(pool,started.sessionToken);
  let reads=0;const request={get body(){reads++;throw Error("Unexpected body access");}};
  await pool.query("UPDATE cc_widget_sessions SET runtime_kind='ai_chat' WHERE id=$1",[session.id]);
  await assert.rejects(receiveTextAttachment(pool,{token:started.sessionToken,request}),{status:403});
  await pool.query("UPDATE cc_widget_sessions SET runtime_kind='human' WHERE id=$1",[session.id]);
  await pool.query(`UPDATE cc_widget_revisions SET config=jsonb_set(config,'{features,attachmentsAfterHandoff}','false') WHERE id=$1`,[session.revision_id]);
  await assert.rejects(receiveTextAttachment(pool,{token:started.sessionToken,request}),{status:403});
  assert.equal(reads,0);
});
test("streamed attachment requests preserve contents and release admission on malformed multipart",async()=>{
  const f=await fixture(),started=await startWidgetSession(pool,f.start),form=new FormData();
  form.set("file",new File(["Streamed content"],"żółw.txt",{type:"text/plain"}));form.set("messageId",randomUUID());
  const result=await receiveTextAttachment(pool,{token:started.sessionToken,request:new Request("https://test.local",{method:"POST",body:form})});
  const stored=(await pool.query("SELECT name,bytes FROM acd_text_attachments WHERE message_id=$1",[result.messageId])).rows[0];
  assert.equal(stored.name,"żółw.txt");assert.equal(stored.bytes.toString(),"Streamed content");
  assert.equal(result.clientId,form.get("messageId"));
  assert.notEqual(result.clientId,result.messageId);
  const state=await readWidgetConversation(pool,await getWidgetSession(pool,started.sessionToken));
  const immediateMessage=state.messages.find(message=>message.id===result.clientId);
  assert.equal(immediateMessage.attachments[0].filename,"żółw.txt");

  await assert.rejects(receiveTextAttachment(pool,{token:started.sessionToken,request:new Request("https://test.local",{method:"POST",body:"broken",headers:{"content-type":"multipart/form-data; boundary=missing"}})}));
  const session=await getWidgetSession(pool,started.sessionToken);
  assert.equal((await pool.query("SELECT count(*)::int n FROM cc_attachment_uploads WHERE conversation_id=$1 AND finished_at IS NULL",[session.conversation_id])).rows[0].n,0);
});
