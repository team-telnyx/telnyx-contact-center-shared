import {test, after, mock} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {prepareAcdTestPool,seedAgent,seedQueue} from "./helpers/acd-test-db.mjs";
import {createWidget,updateWidgetDraft,publishWidget} from "../lib/widgets/store.js";
import {assertPublishableWidgetConfig,publicWidgetConfig} from "../lib/widgets/config.js";
import {createWidgetBootstrapToken} from "../lib/widgets/session-tokens.js";
import {startWidgetSession,getWidgetSession,actAsWidgetCustomer,readWidgetConversation} from "../lib/widgets/sessions.js";
import {updateWidgetVoiceState} from "../lib/widgets/ai-sessions.js";
import {readUtilization,saveAdminSettings} from "../lib/acd/utilization.mjs";
import {sweepTextInactivity} from "../lib/acd/text-lifecycle.mjs";
import {widgetAiProvider} from "../lib/widgets/ai-provider.js";

process.env.WIDGET_SESSION_SIGNING_SECRET="widget-ai-test-only-signing-key-more-than-32-characters";
process.env.TELNYX_API_KEY="widget-ai-test-only";
const pool=await prepareAcdTestPool("acd_core_test_widget_ai");
after(()=>{mock.restoreAll();return pool.end();});
const requests=[];
mock.method(globalThis,"fetch",async(url)=>{
  requests.push(String(url));
  return Response.json({id:"test-assistant",greeting:"Welcome",telephony_settings:{supports_unauthenticated_web_calls:true}});
});
const provider={createConversation:async()=>randomUUID(),greeting:async()=>"Hello from the selected assistant",send:async()=>"Assistant reply"};
async function fixture(channel="messaging"){
  let widget=await createWidget(pool,{name:randomUUID(),actor:"admin"});
  const config=structuredClone(widget.draft.config);
  config.allowedOrigins=["https://customer.example.com"];config.decisions.enabled=false;
  config.channels.messaging.enabled=channel==="messaging";
  config.channels.voice.enabled=channel==="voice";
  config.channels[channel].assistantId="test-assistant";
  widget=await updateWidgetDraft(pool,{id:widget.id,config,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor:"admin"});
  widget=await publishWidget(pool,{id:widget.id,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor:"admin"},{provisionHandoff:async()=>({id:"test-shared-handoff"})});
  const options={publicId:widget.publicId,bootstrapToken:createWidgetBootstrapToken({publicId:widget.publicId,revisionId:widget.published.id,origin:config.allowedOrigins[0]}),clientKey:randomUUID(),channel,provider};
  return {widget,options};
}
test("AI chat uses the selected assistant and one conversation on duplicate session requests without offering a human",async()=>{
  const {options}=await fixture();let starts=0;
  const p={...provider,createConversation:async()=>{starts++;return randomUUID();}};
  const [a,b]=await Promise.all([startWidgetSession(pool,{...options,provider:p}),startWidgetSession(pool,{...options,provider:p})]);
  assert.equal(a.sessionToken,b.sessionToken);assert.equal(starts,1);assert.equal(a.runtimeKind,"ai_chat");
  assert.equal(a.greeting,"Hello from the selected assistant");
  assert.equal((await startWidgetSession(pool,{...options,clientKey:randomUUID(),sessionToken:a.sessionToken})).sessionToken,a.sessionToken);
  const session=await getWidgetSession(pool,a.sessionToken);
  assert.equal(session.assistant_id,"test-assistant");assert.ok(session.provider_conversation_id);
  assert.equal((await pool.query("SELECT count(*)::int n FROM acd_work_items WHERE conversation_id=$1",[session.conversation_id])).rows[0].n,0);
});
test("AI message retries use the persisted result and reject a reused ID with different content",async()=>{
  const {options}=await fixture(),started=await startWidgetSession(pool,options);let calls=0;
  const params={token:started.sessionToken,action:"send",messageId:randomUUID(),content:"Hello",provider:{...provider,send:async(session)=>{calls++;assert.equal(session.assistant_id,"test-assistant");return "Answer";}}};
  const a=await actAsWidgetCustomer(pool,params),b=await actAsWidgetCustomer(pool,params);
  assert.equal(calls,1);assert.equal(a.message.content,"Answer");assert.deepEqual(a.messages,b.messages);
  await assert.rejects(actAsWidgetCustomer(pool,{...params,content:"Changed"}),/already used/);
  const ended=await actAsWidgetCustomer(pool,{token:started.sessionToken,action:"disconnect"});
  assert.equal(ended.handoff.status,"disconnected");
  await assert.rejects(actAsWidgetCustomer(pool,{...params,messageId:randomUUID()}),/ended/);
});
test("an uncertain provider response cannot cause duplicate AI delivery",async()=>{
  const {options}=await fixture(),started=await startWidgetSession(pool,options);let calls=0;
  const params={token:started.sessionToken,action:"send",messageId:randomUUID(),content:"Hello",provider:{...provider,send:async()=>{calls++;throw Object.assign(new Error("Timeout"),{ambiguous:true,status:504});}}};
  await assert.rejects(actAsWidgetCustomer(pool,params),/Timeout/);
  const retry=await actAsWidgetCustomer(pool,params);
  assert.equal(calls,1);assert.equal(retry.pendingReply,true);
  await assert.rejects(actAsWidgetCustomer(pool,{...params,messageId:randomUUID()}),/still being confirmed/);
});
test("voice-only publication creates a scoped voice session and terminal states cannot reopen",async()=>{
  const {options}=await fixture("voice"),started=await startWidgetSession(pool,options);
  assert.equal(started.runtimeKind,"ai_voice");assert.ok(started.session.id);
  assert.equal((await updateWidgetVoiceState(pool,started.sessionToken,{status:"active"})).session.status,"active");
  await updateWidgetVoiceState(pool,started.sessionToken,{status:"completed"});
  assert.equal((await updateWidgetVoiceState(pool,started.sessionToken,{status:"active"})).session.status,"completed");
  await assert.rejects(actAsWidgetCustomer(pool,{token:started.sessionToken,action:"send",content:"bad",messageId:randomUUID()}),/messaging session/);
});
test("voice polls refresh active call expiry but terminal and abandoned calls still expire",async()=>{
  const {options}=await fixture("voice"),started=await startWidgetSession(pool,options);
  await updateWidgetVoiceState(pool,started.sessionToken,{status:"active"});
  const shorten=()=>pool.query("UPDATE cc_widget_sessions SET expires_at=now()+interval '10 seconds',created_at=now()-interval '1 hour' WHERE id=$1",[started.session.id]);
  await shorten();await updateWidgetVoiceState(pool,started.sessionToken);
  assert((await getWidgetSession(pool,started.sessionToken)).expires_at>new Date(Date.now()+240000));
  await sweepTextInactivity(pool);
  assert.equal((await updateWidgetVoiceState(pool,started.sessionToken)).session.status,"active");
  await updateWidgetVoiceState(pool,started.sessionToken,{status:"completed"});await shorten();
  const before=(await getWidgetSession(pool,started.sessionToken)).expires_at;
  await updateWidgetVoiceState(pool,started.sessionToken);
  assert.equal((await getWidgetSession(pool,started.sessionToken)).expires_at.getTime(),before.getTime());
  const abandoned=await startWidgetSession(pool,{...options,clientKey:randomUUID()});
  await pool.query("UPDATE cc_widget_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[abandoned.session.id]);
  await sweepTextInactivity(pool);
  assert.equal((await pool.query("SELECT runtime_state FROM cc_widget_sessions WHERE id=$1",[abandoned.session.id])).rows[0].runtime_state,"completed");
});
test("AI chat normalizes bounded metadata and renders dynamic greeting placeholders",async()=>{
  const {options}=await fixture();
  const context={"customer.name":"Ada","page.path":"/support",nested:{hidden:true},long:"x".repeat(600),widget_session_id:"spoofed"};
  const started=await startWidgetSession(pool,{...options,context,provider:{...provider,greeting:async()=>"Hello {{customer_name}} at {{page.path}} {{missing}}!"}});
  assert.equal(started.greeting,"Hello Ada at /support!");
  const session=await getWidgetSession(pool,started.sessionToken),original=globalThis.fetch;let sent;
  globalThis.fetch=async(_url,init)=>{sent=JSON.parse(init.body);return Response.json({id:randomUUID()});};
  try{await widgetAiProvider.createConversation(session);}finally{globalThis.fetch=original;}
  assert.equal(sent.metadata.customer_name,"Ada");assert.equal(sent.metadata.page_path,"/support");
  assert.equal(sent.metadata.nested,undefined);assert.equal(sent.metadata["customer.name"],undefined);
  assert.equal(sent.metadata.long.length,512);assert.equal(sent.metadata.widget_session_id,session.id);
});
test("one widget assistant persists across channel changes and serves both pinned runtimes",async()=>{
  const f=await fixture();let widget=f.widget;
  assert.equal(widget.draft.config.channels.voice.assistantId,"test-assistant");
  const config=structuredClone(widget.draft.config);config.channels.voice.enabled=true;
  widget=await updateWidgetDraft(pool,{id:widget.id,config,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor:"admin"});
  widget=await publishWidget(pool,{id:widget.id,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor:"admin"},{provisionHandoff:async()=>({id:"test-shared-handoff"})});
  const changed=structuredClone(widget.draft.config);
  changed.channels.messaging.assistantId=changed.channels.voice.assistantId="next-draft-assistant";
  await updateWidgetDraft(pool,{id:widget.id,config:changed,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor:"admin"});
  const bootstrapToken=createWidgetBootstrapToken({publicId:widget.publicId,revisionId:widget.published.id,origin:config.allowedOrigins[0]});
  for(const channel of ["messaging","voice"]){
    const started=await startWidgetSession(pool,{...f.options,bootstrapToken,clientKey:randomUUID(),channel});
    assert.equal((await getWidgetSession(pool,started.sessionToken)).assistant_id,"test-assistant");
  }
  assert.equal(publicWidgetConfig(widget.published.config).channels.voice.assistantId,"test-assistant");
});
test("draft save and publication reject different assistants even when one channel is disabled",async()=>{
  const {widget}=await fixture();
  const config=structuredClone(widget.draft.config);config.channels.voice.assistantId="different-assistant";
  await assert.rejects(updateWidgetDraft(pool,{id:widget.id,config,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor:"admin"}),/same Widget AI assistant/);
  for(const voiceEnabled of [false,true]){
    config.channels.voice.enabled=voiceEnabled;
    assert.throws(()=>assertPublishableWidgetConfig(config),/same Widget AI assistant/);
  }
  const stored=(await pool.query("SELECT config FROM cc_widget_revisions WHERE id=$1",[widget.draft.id])).rows[0].config;
  assert.equal(stored.channels.messaging.assistantId,stored.channels.voice.assistantId);
});
test("a stale utilization revision rolls back account and membership edits in the same save",async()=>{
  const agentId=randomUUID(),queueId=randomUUID();await seedAgent(pool,agentId);await seedQueue(pool,queueId,[]);
  const before=await readUtilization(pool,"agent",agentId);
  await assert.rejects(saveAdminSettings(pool,{scope:"agent",id:agentId,actor:"admin",utilization:{...before,expectedRevision:"stale"}},async db=>{
    await db.query("UPDATE users SET first_name='Must roll back' WHERE id=$1",[agentId]);
    await db.query("INSERT INTO cc_queue_user_assignments(queue_id,user_id) VALUES($1,$2)",[queueId,agentId]);
    return {id:agentId};
  }),/Settings changed/);
  assert.notEqual((await pool.query("SELECT first_name FROM users WHERE id=$1",[agentId])).rows[0].first_name,"Must roll back");
  assert.equal((await pool.query("SELECT 1 FROM cc_queue_user_assignments WHERE user_id=$1",[agentId])).rowCount,0);
  const policies=before.policies.map(p=>p.channel==="chat"?{...p,enabled:true,maxConcurrent:2}:p);
  await saveAdminSettings(pool,{scope:"agent",id:agentId,actor:"admin",utilization:{policies,budget:1,expectedRevision:before.revision}},async db=>{
    await db.query("UPDATE users SET first_name='Saved together' WHERE id=$1",[agentId]);return {id:agentId};
  });
  assert.equal((await readUtilization(pool,"agent",agentId)).policies.find(p=>p.channel==="chat").enabled,true);
  assert.equal((await pool.query("SELECT first_name FROM users WHERE id=$1",[agentId])).rows[0].first_name,"Saved together");
});

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
test("slow AI initialization releases widget and pool locks while retries keep one durable session",async()=>{
  const {options}=await fixture(),entered=deferred(),release=deferred();let calls=0;
  const slow={...provider,createConversation:async()=>{calls++;entered.resolve();await release.promise;return randomUUID();}};
  const first=startWidgetSession(pool,{...options,provider:slow});
  let timer;
  try {
    await entered.promise;
    const independent=async()=>{
      const retry=await startWidgetSession(pool,{...options,provider:slow});
      assert.equal(retry.session.status,"starting");assert.equal(calls,1);
      const other=await startWidgetSession(pool,{...options,clientKey:randomUUID()});
      assert.equal(other.session.status,"active");
      await assert.rejects(actAsWidgetCustomer(pool,{token:retry.sessionToken,action:"send",messageId:randomUUID(),content:"Early",provider}),/still connecting/);
      return retry;
    };
    const retry=await Promise.race([independent(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Widget admission blocked on provider")),2000);})]);
    release.resolve();assert.equal((await first).sessionToken,retry.sessionToken);
    assert.equal((await getWidgetSession(pool,retry.sessionToken)).runtime_state,"active");
  } finally {clearTimeout(timer);release.resolve();await first;}
});
test("failed AI initialization is durable and a retry cannot create a second provider conversation",async()=>{
  const {options}=await fixture();let calls=0;
  const failing={...provider,createConversation:async()=>{calls++;throw Error("Unconfirmed provider response");}};
  await assert.rejects(startWidgetSession(pool,{...options,provider:failing}),/Unconfirmed/);
  const retry=await startWidgetSession(pool,{...options,provider:failing});
  assert.equal(calls,1);assert.equal(retry.session.status,"failed");assert.equal(retry.handoff.status,"disconnected");
});
test("a disconnect during AI initialization cannot reopen the conversation",async()=>{
  const {options}=await fixture(),entered=deferred(),release=deferred();
  const first=startWidgetSession(pool,{...options,provider:{...provider,createConversation:async()=>{entered.resolve();await release.promise;return randomUUID();}}});
  try {
    await entered.promise;
    const retry=await startWidgetSession(pool,options);
    await actAsWidgetCustomer(pool,{token:retry.sessionToken,action:"disconnect"});
    release.resolve();assert.equal((await first).session.status,"completed");
  } finally {release.resolve();await first;}
});
