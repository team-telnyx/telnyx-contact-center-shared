import { test,after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool,seedQueue,seedAgent } from "./helpers/acd-test-db.mjs";
import { createWidget,updateWidgetDraft,publishWidget,getWidget,updateWidget } from "../lib/widgets/store.js";
import { ensureWidgetHandoffTool,widgetHandoffToolDefinition } from "../lib/widgets/handoff-tool.js";
import { authenticateWidgetHandoff,handoffWidgetChat } from "../lib/widgets/handoff.js";
import { createWidgetBootstrapToken,widgetHandoffToken,widgetHandoffServiceToken } from "../lib/widgets/session-tokens.js";
import { startWidgetSession,getWidgetSession,readWidgetConversation,actAsWidgetCustomer } from "../lib/widgets/sessions.js";
import { widgetHandoffContext } from "../lib/widgets/handoff-context.js";
import { widgetAiProvider } from "../lib/widgets/ai-provider.js";
import { heartbeatAgentSession } from "../lib/acd/sessions.mjs";
import { routeOne } from "../lib/acd/router.mjs";
import { actOnTextWork } from "../lib/acd/text-lifecycle.mjs";
import { readTextDetail } from "../lib/acd/text-desktop.mjs";
import { clearSagaDeadlineWakeups } from "../lib/acd/saga-engine.mjs";
import { uploadTextAttachment } from "../lib/widgets/attachments.js";

process.env.WIDGET_SESSION_SIGNING_SECRET="handoff-test-only-signing-secret-with-at-least-32-characters";
const pool=await prepareAcdTestPool("acd_core_test_widget_handoff");
await pool.query(`DROP TABLE IF EXISTS cc_queue_wrapup_codes,cc_wrapup_codes;
  CREATE TABLE cc_wrapup_codes(id TEXT PRIMARY KEY,name TEXT,is_active BOOLEAN DEFAULT true);
  CREATE TABLE cc_queue_wrapup_codes(queue_id TEXT,wrapup_code_id TEXT);
  INSERT INTO cc_wrapup_codes VALUES('resolved','Resolved',true);`);
after(async()=>{clearSagaDeadlineWakeups();await pool.end();});
const origin="https://customer.example.com";
const provider={createConversation:async()=>randomUUID(),greeting:async()=>"Hello John",send:async()=>"AI answer"};
const localPublish={verifyAssistant:async()=>{},provisionHandoff:async()=>({id:"test"})};
const publish=(widget,deps=localPublish)=>publishWidget(pool,{id:widget.id,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor:"admin"},deps);
async function draft({queueId=randomUUID(),assistantId="test-assistant",allowlist=true}={}){
  await seedQueue(pool,queueId,[],{name:queueId});
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,5,0.2) ON CONFLICT DO NOTHING",[queueId]);
  let widget=await createWidget(pool,{name:randomUUID(),actor:"admin"});
  const config=structuredClone(widget.draft.config);config.allowedOrigins=[origin];config.decisions.enabled=false;
  config.channels.messaging.assistantId=assistantId;
  if(allowlist)config.channels.messaging.routing={queueId,queueName:queueId,queues:[{id:queueId,name:queueId}]};
  widget=await updateWidgetDraft(pool,{id:widget.id,config,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor:"admin"});
  return {widget,queueId};
}
async function fixture(options={}){
  const d=await draft(options),widget=await publish(d.widget);
  const started=await startWidgetSession(pool,{publicId:widget.publicId,bootstrapToken:createWidgetBootstrapToken({publicId:widget.publicId,revisionId:widget.published.id,origin}),
    clientKey:randomUUID(),context:{"customer.name":"John Wick","routing.queue":d.queueId,...options.context},provider:options.provider||provider});
  const session=await getWidgetSession(pool,started.sessionToken);
  const body={widget_session_id:session.id,telnyx_conversation_channel:"web_chat",reason:"Customer requested an agent",summary:"Customer needs help with their account"};
  return {...d,widget,started,session,body,handoff:overrides=>handoffWidgetChat(pool,{body:{...body,...overrides},sessionToken:widgetHandoffToken(session.id)})};
}
function fakeTelnyx(){
  const calls=[],secrets=[],tools=[],attachments=new Map();let uncertain=false,failAttach=false;
  return {calls,secrets,tools,attachments,set uncertain(value){uncertain=value;},set failAttach(value){failAttach=value;},
    async request(path,options={}){
      const method=options.method||"GET";calls.push({path,method,body:options.body});
      if(path.startsWith("/integration_secrets?"))return {data:secrets};
      if(path==="/integration_secrets"){secrets.push({identifier:options.body.identifier});return {data:secrets.at(-1)};}
      if(path.startsWith("/ai/tools?"))return {data:tools};
      if(path==="/ai/tools"){
        const tool={id:randomUUID(),...options.body};tools.push(tool);
        if(uncertain){uncertain=false;throw Object.assign(Error("Lost create response"),{ambiguous:true});}
        return {data:tool};
      }
      if(path.startsWith("/ai/tools/")){
        const tool=tools.find(t=>t.id===path.split("/").at(-1));
        if(!tool)throw Object.assign(Error("Not found"),{providerStatus:404});
        if(method==="PATCH")Object.assign(tool,options.body);
        return {data:tool};
      }
      if(path.startsWith("/ai/assistants/")&&method==="PUT"){
        if(failAttach)throw Error("Attachment unavailable");
        const [, , ,assistantId,,toolId]=path.split("/");
        const existing=attachments.get(assistantId)||new Set(["unrelated-tool"]);existing.add(toolId);attachments.set(assistantId,existing);
        return {data:{}};
      }
      throw Error(`Unexpected API request: ${method} ${path}`);
    },
  };
}
function provisioner(fake){return (db,options)=>ensureWidgetHandoffTool(db,{...options,request:fake.request,baseUrl:"https://cc.example.com"});}
const resetIntegration=()=>pool.query("DELETE FROM cc_widget_handoff_integration");

test("AI handoff enables configured customer attachments and preserves MIME and disabled-policy restrictions",async()=>{
  const f=await fixture();
  const file=new File(["Account details for the support agent"],"account.txt",{type:"text/plain"});
  const params={token:f.started.sessionToken,file,clientId:randomUUID()};
  await assert.rejects(uploadTextAttachment(pool,params),/unavailable/);
  await f.handoff();
  await uploadTextAttachment(pool,params);
  const conversation=await readWidgetConversation(pool,await getWidgetSession(pool,f.started.sessionToken));
  assert.equal(conversation.messages.at(-1).attachments[0].filename,"account.txt");
  await assert.rejects(uploadTextAttachment(pool,{...params,clientId:randomUUID(),file:new File(["<html>blocked</html>"],"page.html",{type:"text/html"})}),/type is disabled/);
  await pool.query("UPDATE cc_widget_revisions SET config=jsonb_set(config,'{features,attachmentsAfterHandoff}','false') WHERE id=$1",[f.session.revision_id]);
  await assert.rejects(uploadTextAttachment(pool,{...params,clientId:randomUUID()}),/disabled/);
});

test("first publication creates one shared tool, reuses it and attaches every widget assistant without replacing other tools",async()=>{
  await resetIntegration();const fake=fakeTelnyx(),deps={verifyAssistant:async()=>{},provisionHandoff:provisioner(fake)};
  const first=await publish((await draft({assistantId:"assistant-one"})).widget,deps);
  await publish(first,deps);await publish((await draft({assistantId:"assistant-two"})).widget,deps);
  assert.equal(fake.tools.length,1);assert.equal(fake.secrets.length,1);
  for(const id of ["assistant-one","assistant-two"])assert.deepEqual([...fake.attachments.get(id)],["unrelated-tool",fake.tools[0].id]);
  assert.equal(fake.tools[0].webhook.url,"https://cc.example.com/api/widgets/handoff");
  assert.equal(fake.tools[0].webhook.headers.find(h=>h.name==="x-cc-widget-handoff-token").value,"{{cc_widget_handoff_token}}");
});
test("a lost create response is recovered by discovery without a second POST",async()=>{
  await resetIntegration();const fake=fakeTelnyx();fake.uncertain=true;const ensure=provisioner(fake);
  await assert.rejects(ensure(pool,{assistantIds:["one"]}),/Lost create/);
  const result=await ensure(pool,{assistantIds:["one"]});assert.equal(result.id,fake.tools[0].id);
  assert.equal(fake.calls.filter(c=>c.path==="/ai/tools"&&c.method==="POST").length,1);
});
test("uncertain creation never triggers a blind duplicate and a concurrent publisher cannot acquire the lease",async()=>{
  await resetIntegration();const fake=fakeTelnyx(),installationId=randomUUID();
  await pool.query("INSERT INTO cc_widget_handoff_integration(installation_id,creation_state) VALUES($1,'creating')",[installationId]);
  await assert.rejects(provisioner(fake)(pool,{assistantIds:[]}),/unconfirmed/);
  assert.equal(fake.tools.length,0);
  await pool.query("UPDATE cc_widget_handoff_integration SET lease_id=$1,lease_until=now()+interval '1 minute'",[randomUUID()]);
  await assert.rejects(provisioner(fake)(pool,{assistantIds:[]}),error=>error.status===409);
});
test("provider attachment failure leaves the draft unpublished and retries reuse the created tool",async()=>{
  await resetIntegration();const fake=fakeTelnyx();fake.failAttach=true;
  const {widget}=await draft(),deps={verifyAssistant:async()=>{},provisionHandoff:provisioner(fake)};
  await assert.rejects(publish(widget,deps),/Attachment unavailable/);
  assert.equal((await getWidget(pool,widget.id)).published,null);
  fake.failAttach=false;await publish(widget,deps);assert.equal(fake.tools.length,1);
});
test("draft edits remain possible during provider provisioning and cannot be published without review",async()=>{
  const {widget}=await draft();
  await assert.rejects(publish(widget,{verifyAssistant:async()=>{},provisionHandoff:async()=>{
    const config=structuredClone(widget.draft.config);config.content.welcomeMessage="Concurrent edit";
    await updateWidgetDraft(pool,{id:widget.id,config,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor:"admin"});
    return {id:"tool"};
  }}),/draft changed/);
  const stored=await getWidget(pool,widget.id);assert.equal(stored.published,null);assert.equal(stored.draft.config.content.welcomeMessage,"Concurrent edit");
});

test('publication rechecks the draft before provider writes after a slow tool lookup',async()=>{
  await resetIntegration();const fake=fakeTelnyx(),first=await publish((await draft({assistantId:'assistant-one'})).widget,{verifyAssistant:async()=>{},provisionHandoff:provisioner(fake)});
  const start=fake.calls.length;let edited=false;
  const request=async(path,options)=>{
    const result=await fake.request(path,options);
    if(!edited&&path.startsWith('/ai/tools/')&&!options?.method){
      edited=true;const config=structuredClone(first.draft.config);config.channels.messaging.assistantId='assistant-two';config.channels.voice.assistantId='assistant-two';
      await updateWidgetDraft(pool,{id:first.id,config,expectedDraftId:first.draft.id,expectedEditVersion:first.draft.editVersion,actor:'admin'});
    }
    return result;
  };
  await assert.rejects(publish(first,{verifyAssistant:async()=>{},provisionHandoff:(db,options)=>ensureWidgetHandoffTool(db,{...options,request,baseUrl:'https://cc.example.com'})}),e=>e.status===409);
  assert(edited);assert(!fake.calls.slice(start).some(c=>c.method!=='GET'));
  const current=await getWidget(pool,first.id);assert.equal(current.published.id,first.published.id);assert.equal(current.draft.config.channels.messaging.assistantId,'assistant-two');
  await publish(current,{verifyAssistant:async()=>{},provisionHandoff:provisioner(fake)});assert(fake.attachments.has('assistant-two'));
});

test('a draft change during preflight stops handoff provisioning entirely',async()=>{
  const {widget}=await draft();let called=false;
  await assert.rejects(publish(widget,{verifyAssistant:async()=>{const config=structuredClone(widget.draft.config);config.content.welcomeMessage='Changed during preflight';await updateWidgetDraft(pool,{id:widget.id,config,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor:'admin'});},provisionHandoff:async()=>{called=true;}}),e=>e.status===409);
  assert.equal(called,false);
});
test("tool URLs require HTTPS and service and session capabilities are independent",async()=>{
  for(const baseUrl of ["http://cc.example.com","https://user:password@cc.example.com","https://cc.example.com/subpath"])
    assert.throws(()=>widgetHandoffToolDefinition({installationId:randomUUID(),baseUrl,secretIdentifier:"secret"}),/HTTPS origin/);
  const integration=(await pool.query("SELECT installation_id FROM cc_widget_handoff_integration")).rows[0];
  await authenticateWidgetHandoff(pool,widgetHandoffServiceToken(integration.installation_id));
  await assert.rejects(authenticateWidgetHandoff(pool,null),error=>error.status===401);
  await assert.rejects(authenticateWidgetHandoff(pool,widgetHandoffToken(integration.installation_id)),error=>error.status===401);
  const f=await fixture();
  await assert.rejects(handoffWidgetChat(pool,{body:f.body,sessionToken:widgetHandoffToken(randomUUID())}),error=>error.status===401);
  await assert.rejects(f.handoff({telnyx_conversation_channel:"voice"}),/Invalid chat/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM acd_work_items WHERE conversation_id=$1",[f.session.conversation_id])).rows[0].n,0);
});
test("AI handoff preserves the thread, transcript and summary; concurrent retries create only one work item",async()=>{
  const f=await fixture();
  await actAsWidgetCustomer(pool,{token:f.started.sessionToken,action:"send",messageId:"first",content:"Hello",provider});
  const [a,b]=await Promise.all([f.handoff(),f.handoff()]);assert.equal(a.work_item_id,b.work_item_id);
  const session=await getWidgetSession(pool,f.started.sessionToken);assert.equal(session.runtime_kind,"human");assert.equal(session.conversation_id,f.session.conversation_id);
  const state=await readWidgetConversation(pool,session);
  assert.equal(state.handoff.status,"waiting");assert.equal(state.greeting,"Hello John");
  assert.deepEqual(state.messages.map(m=>[m.id,m.role,m.content]),[["first","user","Hello"],["ai_first","assistant","AI answer"]]);
  const work=(await pool.query("SELECT * FROM acd_work_items WHERE conversation_id=$1",[session.conversation_id])).rows;
  assert.equal(work.length,1);assert.equal(work[0].attributes.handoff.summary,f.body.summary);
  assert.equal(work[0].customer_address,"John Wick");
  await actAsWidgetCustomer(pool,{token:f.started.sessionToken,action:"send",messageId:"first",content:"Hello",provider:{send:()=>assert.fail("AI must not be called")}});
  const next=await actAsWidgetCustomer(pool,{token:f.started.sessionToken,action:"send",messageId:"second",content:"Still waiting",provider:{send:()=>assert.fail("AI must not be called")}});
  assert.equal(next.messages.length,3);
});
test("in-flight AI handoff suppresses late AI replies and tolerates a lost provider response after transfer",async()=>{
  for(const reject of [false,true]){
    const f=await fixture();
    const result=await actAsWidgetCustomer(pool,{token:f.started.sessionToken,action:"send",messageId:"handoff-trigger",content:"  Connect me to an agent  ",provider:{...provider,send:async()=>{
      await f.handoff();if(reject)throw Object.assign(Error("Lost provider response"),{ambiguous:true});return "Late AI answer";
    }}});
    assert.equal(result.runtimeKind,"human");assert.equal(result.handoff.status,"waiting");
    assert.deepEqual(result.messages.map(m=>m.content),["Connect me to an agent"]);
    const retry=await actAsWidgetCustomer(pool,{token:f.started.sessionToken,action:"send",messageId:"handoff-trigger",content:"  Connect me to an agent  "});
    assert.equal(retry.messages.length,1);
  }
});
test("queue allowlists reject foreign or disabled queues, show failure and permit a valid retry",async()=>{
  const f=await fixture(),other=await draft();
  const bad=await f.handoff({queue_name:other.queueId});assert.equal(bad.ok,false);assert.deepEqual(bad.available_queues,[f.queueId]);
  assert.equal((await readWidgetConversation(pool,await getWidgetSession(pool,f.started.sessionToken))).handoff.status,"failed");
  assert.equal((await getWidgetSession(pool,f.started.sessionToken)).runtime_kind,"ai_chat");
  await pool.query("UPDATE cc_queue_channels SET enabled=false WHERE queue_id=$1 AND channel='chat'",[f.queueId]);
  assert.equal((await f.handoff()).ok,false);
  await pool.query("UPDATE cc_queue_channels SET enabled=true WHERE queue_id=$1 AND channel='chat'",[f.queueId]);
  assert.equal((await f.handoff()).ok,true);
});
test("page queue context resolves a real chat-enabled queue when no widget allowlist is configured",async()=>{
  const f=await fixture({allowlist:false});assert.equal((await f.handoff()).queue_name,f.queueId);
  const ambiguous=await fixture({allowlist:false,context:{"routing.queue":""}});
  assert.equal((await ambiguous.handoff()).ok,false);
});
test("a newer publication can revoke an older session's allowed destination",async()=>{
  const f=await fixture(),other=await draft();
  const config=structuredClone(f.widget.draft.config);
  config.channels.messaging.routing={queueId:other.queueId,queueName:other.queueId,queues:[{id:other.queueId,name:other.queueId}]};
  const changed=await updateWidgetDraft(pool,{id:f.widget.id,config,expectedDraftId:f.widget.draft.id,expectedEditVersion:f.widget.draft.editVersion,actor:"admin"});
  await publish(changed);
  const denied=await f.handoff();assert.equal(denied.ok,false);assert.deepEqual(denied.available_queues,[]);
});
test("closed, expired and disabled widget sessions cannot start a handoff",async()=>{
  const closed=await fixture();await actAsWidgetCustomer(pool,{token:closed.started.sessionToken,action:"disconnect"});
  await assert.rejects(closed.handoff(),/active widget AI chat/);
  const expired=await fixture();await pool.query("UPDATE cc_widget_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.session.id]);
  await assert.rejects(expired.handoff(),/expired/);
  const disabled=await fixture();await updateWidget(pool,{id:disabled.widget.id,name:disabled.widget.name,enabled:false,actor:"admin"});
  await assert.rejects(disabled.handoff(),/disabled/);
});
test("private handoff context cannot be forged by host metadata or exposed in the public session response",async()=>{
  let initialized;
  const f=await fixture({context:{widget_session_id:"spoof",cc_widget_handoff_token:"spoof",cc_handoff_tool:"spoof"},
    provider:{...provider,configureConversation:async session=>{initialized=session;}}});
  assert.equal(initialized.handoffContext.token,widgetHandoffToken(f.session.id));
  assert.equal(initialized.handoffContext.defaultQueue,f.queueId);
  assert(!JSON.stringify(f.started).includes(initialized.handoffContext.token));
  const original=globalThis.fetch;const calls=[];process.env.TELNYX_API_KEY="test-only";
  globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({id:randomUUID()});};
  try{await widgetAiProvider.createConversation(initialized);await widgetAiProvider.configureConversation(initialized);}
  finally{globalThis.fetch=original;}
  assert.equal(calls[0].metadata.cc_widget_handoff_token,widgetHandoffToken(f.session.id));
  assert.equal(calls[0].metadata.widget_session_id,f.session.id);
  assert.equal(calls[1].role,"system");assert(calls[1].content.includes(f.session.id));
  assert(!calls[1].content.includes(initialized.handoffContext.token));
  assert.deepEqual((await widgetHandoffContext(pool,f.session)).queues,[{id:f.queueId,name:f.queueId}]);
});
test("handoff offers respect agent capacity and emit assigned, connected and disconnected notifications",async()=>{
  const f=await fixture(),agentId=randomUUID();await seedAgent(pool,agentId,{voiceReady:false});
  await seedQueue(pool,f.queueId,[agentId]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',false,1,0.2)",[agentId]);
  await heartbeatAgentSession(pool,{agentId,sessionId:randomUUID(),chatReady:true});
  const handed=await f.handoff();assert.equal((await routeOne(pool,handed.work_item_id)).routed,false);
  await pool.query("UPDATE cc_agent_channel_policies SET enabled=true WHERE agent_id=$1 AND channel='chat'",[agentId]);
  await seedAgent(pool,agentId,{voiceReady:false});
  await heartbeatAgentSession(pool,{agentId,sessionId:randomUUID(),chatReady:true});
  const offer=await routeOne(pool,handed.work_item_id);assert.equal(offer.routed,true);
  const state=()=>getWidgetSession(pool,f.started.sessionToken).then(s=>readWidgetConversation(pool,s));
  assert.equal((await state()).handoff.status,"assigned");assert.equal((await state()).handoff.agentConnected,false);
  let detail=await readTextDetail(pool,{workItemId:handed.work_item_id,agentId});
  assert.equal(detail.work.attributes.handoff.summary,f.body.summary);
  assert.equal(detail.messages[0].sender_id,"widget-ai");assert.equal(detail.messages[0].body,"Hello John");
  await actOnTextWork(pool,{workItemId:handed.work_item_id,agentId,action:"accept",commandId:randomUUID(),expectedVersion:detail.work.version,offerId:offer.offerId});
  assert.equal((await state()).handoff.status,"connected");
  const second=await fixture({queueId:f.queueId});const other=await second.handoff();
  assert.equal((await routeOne(pool,other.work_item_id)).routed,false);
  detail=await readTextDetail(pool,{workItemId:handed.work_item_id,agentId});
  await actOnTextWork(pool,{workItemId:handed.work_item_id,agentId,action:"disconnect",commandId:randomUUID(),expectedVersion:detail.work.version});
  const ended=await state();assert.equal(ended.handoff.status,"disconnected");assert.equal(ended.handoff.agentConnected,true);
  assert.equal((await routeOne(pool,other.work_item_id)).routed,false);
  detail=await readTextDetail(pool,{workItemId:handed.work_item_id,agentId});
  await actOnTextWork(pool,{workItemId:handed.work_item_id,agentId,action:"wrapup",codeId:"resolved",commandId:randomUUID(),expectedVersion:detail.work.version});
  assert.equal((await routeOne(pool,other.work_item_id)).routed,true);
});
