import {test,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {prepareAcdTestPool,seedAgent,seedQueue,makeTxRunner} from "./helpers/acd-test-db.mjs";
import {createChatWork,appendTextMessage,actOnTextWork} from "../lib/acd/text-lifecycle.mjs";
import {heartbeatAgentSession} from "../lib/acd/sessions.mjs";
import {routeOne} from "../lib/acd/router.mjs";
import {clearSagaDeadlineWakeups} from "../lib/acd/saga-engine.mjs";
import {readTextDetail} from "../lib/acd/text-desktop.mjs";
import {generateChatCopilot,readChatCopilot,buildCopilotRequest,parseCopilotSuggestions,copilotUsage,chatCopilotCatalog} from "../lib/contact-center/chat-copilot.js";
import {parseChatCopilotSettings,DEFAULT_CHAT_COPILOT_SETTINGS} from "../lib/contact-center/chat-copilot-settings.mjs";
import {readChatAiContext,safeChatMetadata,summarizeChatCosts} from "../lib/contact-center/chat-ai-context.js";

const pool=await prepareAcdTestPool("acd_core_test_chat_copilot");
await pool.query(`DROP TABLE IF EXISTS app_settings,cc_queue_wrapup_codes,cc_wrapup_codes;
  CREATE TABLE app_settings(id text PRIMARY KEY,cc_settings jsonb);
  INSERT INTO app_settings VALUES('default','{"chat_copilot":{"model":"test-model","bucketIds":["support-knowledge"]}}');
  CREATE TABLE cc_wrapup_codes(id text,name text,is_active boolean);
  CREATE TABLE cc_queue_wrapup_codes(queue_id text,wrapup_code_id text);`);
after(async()=>{clearSagaDeadlineWakeups();await pool.end();});
const catalog=async()=>({models:[{id:"test-model",pricing:{input:"1",output:"2",currency:"USD",unit:"1M_tokens"}}]});
const request=async()=>({choices:[{message:{content:JSON.stringify({suggestions:[{text:"Here is how I can help.",confidence:0.75,rationale:"Based on the conversation."}]})}}],usage:{prompt_tokens:100,completion_tokens:50}});
async function fixture(){
  const agentId=randomUUID(),queueId=randomUUID();await seedAgent(pool,agentId,{voiceReady:false});await seedQueue(pool,queueId,[agentId]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,5,0.2)",[queueId]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,5,0.2)",[agentId]);
  await heartbeatAgentSession(pool,{agentId,sessionId:randomUUID(),chatReady:true});
  const work=await makeTxRunner(pool)(db=>createChatWork(db,{queueId,customerName:"John Wick",attributes:{handoff:{summary:"Customer needs help",reason:"Asked for a person",sentiment:"neutral"}}}));
  await makeTxRunner(pool)(db=>appendTextMessage(db,{work,senderRole:"customer",senderId:"visitor",clientId:randomUUID(),body:"How do I update my account?"}));
  const offer=await routeOne(pool,work.id);
  return {work,offer,agentId,identity:{workItemId:work.id,agentId},input:{workItemId:work.id,agentId,question:"How can I help?",requestId:randomUUID()}};
}

test("settings require a model and reject more than five buckets instead of silently truncating",()=>{
  assert.equal(parseChatCopilotSettings(DEFAULT_CHAT_COPILOT_SETTINGS).bucketIds.length,0);
  assert.throws(()=>parseChatCopilotSettings({model:"",bucketIds:[]}),/model/);
  assert.throws(()=>parseChatCopilotSettings({model:"test",bucketIds:["1","2","3","4","5","6"]}),/5/);
  assert.deepEqual(parseChatCopilotSettings({model:"test",bucketIds:["one","one"]}).bucketIds,["one"]);
});
test("legacy settings default to 6,000 tokens and token limits require bounded integers",()=>{
  assert.equal(parseChatCopilotSettings({model:"test",bucketIds:[]}).maxTokens,6000);
  for(const maxTokens of [256,12000,32768])assert.equal(parseChatCopilotSettings({model:"test",bucketIds:[],maxTokens}).maxTokens,maxTokens);
  for(const maxTokens of [null,"", "12000",0,255,32769,1.5,NaN,Infinity])assert.throws(()=>parseChatCopilotSettings({model:"test",bucketIds:[],maxTokens}),error=>error.status===400&&/Max tokens/.test(error.message));
});
test("a saved token budget is loaded and used by the next Copilot generation",async()=>{
  const f=await fixture();
  const previous=(await pool.query("SELECT cc_settings FROM app_settings WHERE id='default'")).rows[0].cc_settings;
  const settings=parseChatCopilotSettings({...previous.chat_copilot,maxTokens:12000});
  try{
    await pool.query("UPDATE app_settings SET cc_settings=jsonb_set(cc_settings,'{chat_copilot}',$1::jsonb) WHERE id='default'",[JSON.stringify(settings)]);
    assert.equal((await readChatCopilot(pool,f.identity)).settings.maxTokens,12000);
    let used;
    await generateChatCopilot(pool,f.input,{catalog,request:async(_path,{body})=>{used=body.max_tokens;return request();}});
    assert.equal(used,12000);
  }finally{await pool.query("UPDATE app_settings SET cc_settings=$1::jsonb WHERE id='default'",[JSON.stringify(previous)]);}
});
test("request uses server-selected model and retrieval sources and bounds conversation context",()=>{
  const settings={model:"test",bucketIds:["one","two","three","four","five"]};
  const result=buildCopilotRequest({settings,question:"Help",handoff:{summary:"Summary"},messages:Array.from({length:60},()=>({sender_role:"customer",body:"x".repeat(20000)}))});
  assert.equal(result.model,"test");assert.deepEqual(result.tools,[{type:"retrieval",retrieval:{bucket_ids:settings.bucketIds,max_num_results:5}}]);
  const context=JSON.parse(result.messages[1].content);assert.equal(context.question,"Help");assert(context.conversation.reduce((n,m)=>n+m.text.length,0)<=24000);
  assert.equal(buildCopilotRequest({settings:{...settings,bucketIds:[]},question:"Help",messages:[]}).tools,undefined);
});
test("suggestions are capped at five, deduplicated and carry only valid model confidence estimates",()=>{
  const result=parseCopilotSuggestions(JSON.stringify({suggestions:[{text:"Same",confidence:1.7},{text:"Same",confidence:0.9},...Array.from({length:9},(_,i)=>({text:`Answer ${i}`,confidence:i/10}))]}));
  assert.equal(result.length,5);assert.equal(result.filter(s=>s.text==="Same").length,1);assert.equal(result.find(s=>s.text==="Same").confidence,null);
  assert.throws(()=>parseCopilotSuggestions("Not JSON"),/usable/);
  assert.throws(()=>parseCopilotSuggestions('{"suggestions":[]}'),/usable/);
  assert.throws(()=>parseCopilotSuggestions('null'),/usable/);
  assert.throws(()=>parseCopilotSuggestions('{"suggestions":[null]}'),/usable/);
});
test("Copilot authenticates interaction ownership before any provider calls",async()=>{
  const f=await fixture();let called=false;
  await assert.rejects(generateChatCopilot(pool,{...f.input,agentId:"foreign-agent"},{request:async()=>{called=true;},catalog}),error=>error.status===403);
  assert.equal(called,false);
  await assert.rejects(readChatAiContext(pool,{...f.identity,agentId:"foreign-agent"},{request}),error=>error.status===403);
});
test("generations persist, retries reuse the same answer and never send a customer message",async()=>{
  const f=await fixture();let calls=0,body;
  const deps={catalog,request:async(_path,options)=>{calls++;body=options.body;return request();}};
  const before=(await pool.query("SELECT count(*)::int n FROM acd_messages WHERE conversation_id=$1",[f.work.conversation_id])).rows[0].n;
  const a=await generateChatCopilot(pool,f.input,deps),b=await generateChatCopilot(pool,f.input,deps);
  assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(body.model,"test-model");assert.equal(body.tools[0].retrieval.bucket_ids[0],"support-knowledge");
  assert.equal((await readChatCopilot(pool,f.identity)).latest.requestId,a.requestId);
  assert.equal(a.usage.estimatedCostUsd,0.0002);assert.equal(a.confidenceType,"model_estimate");
  assert.equal((await pool.query("SELECT count(*)::int n FROM acd_messages WHERE conversation_id=$1",[f.work.conversation_id])).rows[0].n,before);
  await assert.rejects(generateChatCopilot(pool,{...f.input,question:"Different"},deps),/already used/);
});
test("concurrent generation and uncertain retries cannot duplicate a provider request",async()=>{
  const f=await fixture();let release,entered;
  const blocked=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});let calls=0;
  const first=generateChatCopilot(pool,f.input,{catalog,request:async()=>{calls++;entered();await blocked;return request();}});
  try{await started;
    await assert.rejects(generateChatCopilot(pool,f.input,{request,catalog}),/still being confirmed/);
    await assert.rejects(generateChatCopilot(pool,{...f.input,requestId:randomUUID()},{request,catalog}),error=>error.status===429);
  }finally{release();await first;}
  assert.equal(calls,1);
  const failure=await fixture();let failures=0;const deps={catalog,request:async()=>{failures++;throw Object.assign(Error("Provider timeout"),{status:504});}};
  await assert.rejects(generateChatCopilot(pool,failure.input,deps),/timeout/);
  await assert.rejects(generateChatCopilot(pool,failure.input,deps),/Start a new request/);assert.equal(failures,1);
});
test("an offer revoked during generation cannot receive a late AI response",async()=>{
  const f=await fixture();
  await assert.rejects(generateChatCopilot(pool,f.input,{catalog,request:async()=>{
    await pool.query("UPDATE acd_offers SET state='cancelled' WHERE id=$1",[f.offer.offerId]);return request();
  }}),error=>error.status===403);
});
test("unusable completions mark the request failed so a fresh generation can succeed",async()=>{
  const f=await fixture();let calls=0;
  await assert.rejects(generateChatCopilot(pool,f.input,{catalog,request:async()=>{calls++;return {choices:[{message:{content:'{}'}}]};}}),error=>error.status===502&&error.requestState==="failed");
  assert.equal(calls,2);
  const row=(await pool.query("SELECT state FROM acd_chat_copilot_requests WHERE request_id=$1",[f.input.requestId])).rows[0];
  assert.equal(row.state,"failed");
  const next=await generateChatCopilot(pool,{...f.input,requestId:randomUUID()},{catalog,request});
  assert.equal(next.suggestions.length,1);
});
test("confidence and costs never invent certainty or a zero price when usage is unavailable",()=>{
  assert.equal(copilotUsage({},{}).estimatedCostUsd,null);
  assert.equal(copilotUsage({prompt_tokens:100,completion_tokens:50},{}).estimatedCostUsd,null);
  assert.equal(copilotUsage({prompt_tokens:100,completion_tokens:50,prompt_tokens_details:{cached_tokens:20}},{input:1,output:2,cached_prompt:0.5,currency:"USD",unit:"1M_tokens"}).estimatedCostUsd,0.00019);
  assert.deepEqual(summarizeChatCosts({}),{total:null,currency:"USD",items:[]});
  assert.equal(summarizeChatCosts({cost:{cumulative_cost:"0.005",currency:"USD"},children:[{product:"inference",cost:{event_cost:"0.005"}}]}).total,0.005);
});
test("agent details include customer and agent avatars; context reports recorded Copilot usage",async()=>{
  const f=await fixture();await pool.query("UPDATE users SET first_name='Alex',profile_picture_uri='https://example.com/alex.png' WHERE id=$1",[f.agentId]);
  let detail=await readTextDetail(pool,f.identity);assert.equal(detail.customerName,"John Wick");assert.equal(detail.agent.profile_picture_uri,"https://example.com/alex.png");
  await actOnTextWork(pool,{...f.identity,action:"accept",commandId:randomUUID(),expectedVersion:detail.work.version,offerId:f.offer.offerId});
  detail=await readTextDetail(pool,f.identity);
  await actOnTextWork(pool,{...f.identity,action:"send",body:"Hello John",commandId:randomUUID(),expectedVersion:detail.work.version});
  detail=await readTextDetail(pool,f.identity);assert.equal(detail.messages.at(-1).first_name,"Alex");assert.equal(detail.messages.at(-1).profile_picture_uri,"https://example.com/alex.png");
  await generateChatCopilot(pool,f.input,{request,catalog});const context=await readChatAiContext(pool,f.identity,{request});assert.equal(context.costs.copilot.length,1);assert.equal(context.handoff.summary,"Customer needs help");
});
test("metadata hides provider capabilities and catalog normalizes the embedded bucket response",async()=>{
  assert.deepEqual(safeChatMetadata({"customer.name":"John",cc_widget_handoff_token:"secret",api_key:"secret",nested:{secret:"value"},"customer.authenticated":true}),{"customer.name":"John","customer.authenticated":true});
  const options=await chatCopilotCatalog(async path=>path==="/ai/models"?{data:[{id:"test",pricing:{}}]}:{data:{buckets:["support",{bucket_name:"policies"}]}});
  assert.deepEqual(options.buckets,["support","policies"]);assert.equal(options.models[0].id,"test");
});
