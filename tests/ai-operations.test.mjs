import test from 'node:test';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AI_OPERATIONS, applyOperationConfig, operationConfigSchema, readOperationConfig } from '../lib/ai-operations/catalog.mjs';
import { loadRoute } from './helpers/route-harness.mjs';
import * as catalog from '../lib/ai-operations/catalog.mjs';
import * as copilot from '../lib/contact-center/chat-copilot-settings.mjs';
import * as settingsPayload from '../lib/ai-operations/settings-payload.mjs';
const body={model:'existing/model',temperature:0.2,max_tokens:4000,response_format:{type:'json_object'},messages:[{role:'system',content:'Mandatory schema and step rules.'},{role:'user',content:'Synthetic transcript.'}]};
test('15 unique operations preserve explicit model precedence and all execution controls',()=>{
 assert.equal(AI_OPERATIONS.length,15);assert.equal(new Set(AI_OPERATIONS.map(x=>x.id)).size,15);
 for(const operation of AI_OPERATIONS){
  const custom=applyOperationConfig(operation.id,body,{model:'central/model',instructions:'Use clear language.'});
  assert.equal(custom.model,'central/model');assert.equal(custom.max_tokens,4000);assert.deepEqual(custom.response_format,body.response_format);
  assert.deepEqual(custom.messages[1],body.messages[1]);assert.match(custom.messages[0].content,/Protected technical contract/);
  if(!operation.replaceSystem)assert.match(custom.messages[0].content,/Mandatory schema and step rules/);
  assert.equal(applyOperationConfig(operation.id,body,{model:'central/model',instructions:''},{preferredModel:'local/model'}).model,'local/model');
  // No model in code: the platform default applies; a model in the request body is never used.
  assert.deepEqual(applyOperationConfig(operation.id,body,readOperationConfig({},operation.id),{defaultModel:'platform/model'}),{...body,model:'platform/model'});
  assert.throws(()=>applyOperationConfig(operation.id,body,readOperationConfig({},operation.id)),catalog.AiModelNotConfiguredError);
  assert.equal('defaultModel' in operation,false,'operations carry no model of their own');
 }
});
test('platform default model: saved setting first, then TELNYX_AI_DEFAULT_MODEL, else none',()=>{
 assert.deepEqual(catalog.readDefaultModel({ai_default_model:'saved/model'},{TELNYX_AI_DEFAULT_MODEL:'env/model'}),{model:'saved/model',source:'settings'});
 assert.deepEqual(catalog.readDefaultModel({},{TELNYX_AI_DEFAULT_MODEL:' env/model '}),{model:'env/model',source:'env'});
 assert.deepEqual(catalog.readDefaultModel({},{}),{model:'',source:null});
 assert.equal(catalog.DEFAULT_MODEL_ENV,'TELNYX_AI_DEFAULT_MODEL');
});
test('configuration rejects protected fields, arbitrary execution flags and oversized instructions',()=>{
 for(const config of [{model:'a',contract:'override'},{instructions:'x'.repeat(6001)},{temperature:2},{max_tokens:100000}])assert.equal(operationConfigSchema.safeParse(config).success,false);
 assert.throws(()=>readOperationConfig({},'unknown'),/Unknown/);
});
async function setup(initial={},routePath='app/api/admin/ai-operations/route.js',env={}){
 let saved=structuredClone(initial);let locked=false;
 const tx={release(){},async query(sql,args){
  if(sql==='BEGIN'){locked=true;return {rows:[]};}
  if(sql==='COMMIT'||sql==='ROLLBACK'){locked=false;return {rows:[]};}
  if(sql.startsWith('SELECT'))return {rows:[{cc_settings:structuredClone(saved)}]};
  if(sql.startsWith('UPDATE')){assert.equal(locked,true);saved=JSON.parse(args[0]);}
  return {rows:[]};
 }};
 const pool={...tx,connect:async()=>tx};
 const route=await loadRoute(routePath,{
  env,
  zod:{z},'node:crypto':{createHash},
  '@/lib/postgres.mjs':{getPostgresPool:()=>pool},'@/lib/ai-operations/catalog.mjs':catalog,'@/lib/contact-center/chat-copilot-settings.mjs':copilot,'@/lib/ai-operations/settings-payload.mjs':settingsPayload,
  '@/lib/authz/guard':{withPermission:(permission,handler)=>async(req,auth={read:true,write:true})=>{
   if(!(permission.endsWith(':read')?auth.read:auth.write))return {status:403};
   return handler(req,{}, {user:{username:'controlled-admin'},can:()=>auth.write});
  }},
 });
 return {route,read:()=>saved};
}
const request=body=>new Request('http://localhost/api/admin/ai-operations',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
test('settings save is permission-gated, preserves unrelated settings and detects stale editors',async()=>{
 const {route,read}=await setup({consult_hold:{media_name:'keep'},chat_copilot:copilot.DEFAULT_CHAT_COPILOT_SETTINGS});
 const fetched=await route.GET();assert.equal(fetched.body.operations.length,15);
 const item=fetched.body.operations.find(x=>x.id==='call-summary');
 const change={id:item.id,revision:item.revision,config:{model:'new/model',instructions:'Write in Polish.'}};
 assert.equal((await route.PUT(request(change),{read:true,write:false})).status,403);
 assert.equal((await route.GET(null,{read:false,write:false})).status,403);
 assert.equal((await route.GET(null,{read:true,write:false})).body.canEdit,false);
 assert.equal((await route.PUT(request(change))).status,200);
 assert.deepEqual(read().consult_hold,{media_name:'keep'});assert.equal(read().ai_operations['call-summary'].model,'new/model');
 assert.equal((await route.PUT(request(change))).status,409);
 assert.equal((await route.PUT(request({...change,config:{instructions:'x',contract:'erase rules'}}))).status,400);
});
test('reply suggestions retain per-channel models, token budgets and retrieval buckets',async()=>{
 const {route,read}=await setup({chat_copilot:{model:'chat/model',maxTokens:6000,bucketIds:['existing']},sms_copilot:{model:'sms/model',maxTokens:4000,bucketIds:[]}});
 let result=await route.GET();let op=result.body.operations.find(x=>x.id==='reply-suggestions');
 const custom={model:'email/model',maxTokens:5000,bucketIds:['knowledge']};
 result=await route.PUT(request({id:op.id,revision:op.revision,config:op.config,channel:'email',copilot:custom}));
 assert.equal(result.status,200);assert.deepEqual(read().email_copilot,custom);assert.equal(read().sms_copilot.model,'sms/model');assert.deepEqual(read().chat_copilot.bucketIds,['existing']);
 op=result.body.operations.find(x=>x.id==='reply-suggestions');
 result=await route.PUT(request({id:op.id,revision:op.revision,config:op.config,channel:'email',copilot:null}));
 assert.equal(result.status,200);assert.equal(read().email_copilot,undefined);
});

test('the platform default model is saved with a revision and every operation inherits it after apply-to-all',async()=>{
 const initial={consult_hold:{media_name:'keep'},ai_operations:{'call-summary':{model:'old/model',instructions:'Write in Polish.'},'workflow-analysis':{model:'other/model',instructions:''}},chat_copilot:{model:'chat/model',maxTokens:6000,bucketIds:['kb']},sms_copilot:{model:'sms/model',maxTokens:4000,bucketIds:[]}};
 const {route,read}=await setup(initial,'app/api/admin/ai-operations/default/route.js');
 const ops=await setup(initial);
 const before=(await ops.route.GET()).body;
 assert.equal(before.defaultModel.source,process.env.TELNYX_AI_DEFAULT_MODEL?'env':null);
 const summary=before.operations.find(x=>x.id==='call-summary');
 assert.deepEqual(summary.effective,{model:'old/model',source:'ai-copilot'});
 const put=body=>new Request('http://localhost/api/admin/ai-operations/default',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const post=body=>new Request('http://localhost/api/admin/ai-operations/default',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await route.PUT(put({model:'moonshotai/Kimi-K2.5',revision:before.defaultModel.revision}),{read:true,write:false})).status,403);
 let result=await route.PUT(put({model:'moonshotai/Kimi-K2.5',revision:before.defaultModel.revision}));
 assert.equal(result.status,200);assert.equal(read().ai_default_model,'moonshotai/Kimi-K2.5');
 assert.deepEqual(result.body.defaultModel.model,'moonshotai/Kimi-K2.5');assert.equal(result.body.defaultModel.source,'settings');
 assert.equal((await route.PUT(put({model:'x/y',revision:before.defaultModel.revision}))).status,409,'stale revision');
 assert.equal((await route.PUT(put({model:'bad model',revision:result.body.defaultModel.revision}))).status,400);
 assert.equal((await route.POST(post({action:'something-else'}))).status,400);
 assert.equal((await route.POST(post({action:'apply-to-all'}))).status,400,'the confirmed revision is required');
 assert.equal((await route.POST(post({action:'apply-to-all',revision:before.defaultModel.revision}))).status,409,'the default changed after the dialog opened');
 result=await route.POST(post({action:'apply-to-all',revision:result.body.defaultModel.revision}));
 assert.equal(result.status,200);
 const saved=read();
 for(const op of AI_OPERATIONS)assert.equal(saved.ai_operations[op.id].model,'',op.id);
 assert.equal(saved.ai_operations['call-summary'].instructions,'Write in Polish.','instructions are kept');
 assert.equal(saved.chat_copilot.model,'');assert.deepEqual(saved.chat_copilot.bucketIds,['kb']);assert.equal(saved.sms_copilot.model,'');assert.equal(saved.sms_copilot.maxTokens,4000);
 assert.deepEqual(saved.consult_hold,{media_name:'keep'});
 assert.deepEqual(result.body.applied,{operations:15,clearedOperationModels:2,clearedChannelModels:2});
 for(const op of result.body.operations)assert.deepEqual(op.effective,{model:'moonshotai/Kimi-K2.5',source:'default'},op.id);
 // Without TELNYX_AI_DEFAULT_MODEL an empty value would leave inheriting operations without a model.
 assert.equal((await route.PUT(put({model:'',revision:result.body.defaultModel.revision}))).status,409);
 assert.equal(read().ai_default_model,'moonshotai/Kimi-K2.5');
 // With it, an empty value removes the saved default (the environment variable applies again).
 const withEnv=await setup(read(),'app/api/admin/ai-operations/default/route.js',{TELNYX_AI_DEFAULT_MODEL:'env/model'});
 result=await withEnv.route.PUT(put({model:'',revision:result.body.defaultModel.revision}));
 assert.equal(result.status,200);assert.equal('ai_default_model' in withEnv.read(),false);
});

test('apply-to-all is refused when no default model exists at all (Codex review on #1639)',async()=>{
 const initial={ai_operations:{'call-summary':{model:'own/model',instructions:''}},chat_copilot:{model:'chat/model',maxTokens:6000,bucketIds:[]}};
 const {route,read}=await setup(initial,'app/api/admin/ai-operations/default/route.js',{});
 const revision=settingsPayload.defaultModelRevision(initial);
 const result=await route.POST(new Request('http://localhost/api/admin/ai-operations/default',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'apply-to-all',revision})}));
 assert.equal(result.status,409);
 assert.equal(read().ai_operations['call-summary'].model,'own/model','operation models are kept');
 assert.equal(read().chat_copilot.model,'chat/model','channel models are kept');
});

test('AI Copilot page: env reset only with an env model, apply-to-all asks before discarding drafts',async()=>{
 const page=await readFile(new URL('../app/(portal)/admin/system/settings/ai-copilot/page.jsx',import.meta.url),'utf8');
 assert.match(page,/platform\?\.saved&&platform\?\.envModel&&<Button variant="outline" onClick=\{\(\)=>saveDefault\(''\)\}/);
 assert.match(page,/if\(dirty&&!window\.confirm\(tUi\("Discard unsaved changes\?"\)\)\)return;setConfirmApply\(true\);/);
 assert.match(page,/defaultApi\('POST',\{action:'apply-to-all',revision:platform\.revision\}\)/);
});
