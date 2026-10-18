import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_OPERATIONS, applyOperationConfig } from '../lib/ai-operations/catalog.mjs';
import { AI_OPERATION_USAGE } from '../lib/ai-operations/usage.mjs';
import { operationSample, buildOperationPreview, validateOperationOutput } from '../lib/ai-operations/playground.mjs';
import { sentimentSystem } from '../lib/ai-operations/prompts/core.mjs';
import { buildWorkflowAnalysisSystemPrompt } from '../lib/agent-assist/workflow-prompts.js';
import { loadRoute } from './helpers/route-harness.mjs';
import * as playground from '../lib/ai-operations/playground.mjs';
// The platform default model is supplied by the server (no model in code).
const build=(value)=>buildOperationPreview(value,{defaultModel:'platform/model'});
const input=id=>({id,config:{model:'',instructions:''},sample:operationSample(id)});
test('all operations expose synthetic context, real prompt builders and usage locations',()=>{
 for(const {id} of AI_OPERATIONS){
  const request=input(id),preview=build(request);
  assert.ok(AI_OPERATION_USAGE[id].screens.length);
  assert.equal(preview.request.messages[0].role,'system');assert.ok(preview.request.messages[0].content.length>80);
  assert.equal(preview.request.messages[1].role,'user');assert.equal(preview.request.stream,false);
  assert.deepEqual(preview.request,{...preview.baseline,model:'platform/model'});
  assert.equal('model' in preview.baseline,false,'no model in the generated request');
  const config={model:'test/model',instructions:'Use precise terminology.'};
  const overridden=build({...request,config,model:'test/model'});
  assert.deepEqual(overridden.request,applyOperationConfig(id,preview.baseline,config,{preferredModel:'test/model'}));
 }
});
test('sentiment preview includes every requested instruction, not the short contract summary',()=>{
 const value=input('sentiment-intent');
 assert.equal(build(value).request.messages[0].content,sentimentSystem());
 const intent=build({...value,sample:{...value.sample,includeSentiment:false}});
 assert.equal(intent.request.max_tokens,100);assert.doesNotMatch(intent.request.messages[0].content,/sentimentScore/);assert.match(intent.request.messages[0].content,/tags/);
 const sentiment=build({...value,sample:{...value.sample,includeIntent:false}});
 assert.doesNotMatch(sentiment.request.messages[0].content,/tags/);assert.match(sentiment.request.messages[0].content,/no allergies/);
 assert.throws(()=>build({...value,sample:{...value.sample,includeIntent:false,includeSentiment:false}}));
});
test('workflow and scorecard context are composed with production builders',()=>{
 const value=input('workflow-analysis');
 value.sample.allowCorrections=true;value.sample.isReadBackStage=true;
 assert.equal(build(value).request.messages[0].content,buildWorkflowAnalysisSystemPrompt(value.sample));
 const quality=input('quality-evaluation');quality.sample.aiPromptConfig.persona='Focus on careful listening.';
 const preview=build(quality);
 assert.match(preview.request.messages[0].content,/Focus on careful listening/);
 assert.match(preview.request.messages[1].content,/resolved and confirmed/);
 for(const scenarioType of ['workflow_specific','early_transfer','mid_workflow_transfer','out_of_order','frustrated_customer']){
  const scenario=input('test-scenario');scenario.sample.scenarioType=scenarioType;
  assert.ok(build(scenario).request.messages[0].content.includes('CUSTOMER'));
 }
 for(const variant of ['web','generated-call']){
  const caller=input('test-caller');caller.sample.variant=variant;caller.sample.expressiveKind='ultra';
  assert.match(build(caller).request.messages[0].content,/SSML emotion/);
 }
});
test('test request rejects oversized and malformed context, unknown operations and injected transport fields',()=>{
 assert.throws(()=>build({...input('call-summary'),endpoint:'https://other.example'}));
 assert.throws(()=>build({...input('call-summary'),id:'unknown'}));
 assert.throws(()=>build({...input('call-summary'),sample:{transcriptionText:'x'.repeat(40001)}}));
 assert.throws(()=>build({...input('call-summary'),sample:{transcriptionText:42}}));
});
test('output checks report invalid JSON, truncation and out-of-bound quality scores without accepting null',()=>{
 for(const raw of ['null','[]','"text"','not JSON'])assert.equal(validateOperationOutput('sentiment-intent',raw,operationSample('sentiment-intent'),'stop').valid,false);
 assert.equal(validateOperationOutput('call-summary','A complete summary.',{},'length').valid,false);
 assert.equal(validateOperationOutput('quality-evaluation',JSON.stringify({answers:[{criterionId:'resolution',score:9}]}),operationSample('quality-evaluation'),'stop').valid,false);
 assert.equal(validateOperationOutput('sentiment-intent',JSON.stringify({intent:'Appointment problem',tags:['appointment'],sentiment:'negative',sentimentScore:20}),operationSample('sentiment-intent'),'stop').valid,true);
});
test('preview is read-permission protected and never invokes the provider',async()=>{
 const route=await loadRoute('app/api/admin/ai-operations/preview/route.js',{
  '@/lib/ai-operations/playground.mjs':playground,
  '@/lib/ai-operations/runtime.mjs':{platformDefaultModel:async()=>({model:'platform/model',source:'settings'})},
  '@/lib/authz/guard':{withPermission:(permission,handler)=>{assert.equal(permission,'system_settings:read');return (req,allowed=true)=>allowed?handler(req):{status:403};}}
 });
 assert.equal((await route.GET(new Request('http://localhost/preview?id=sentiment-intent'),false)).status,403);
 assert.equal((await route.GET(new Request('http://localhost/preview?id=sentiment-intent'))).status,200);
 const req=body=>new Request('http://localhost/preview',{method:'POST',body:JSON.stringify(body)});
 assert.equal((await route.POST(req(input('sentiment-intent')))).status,200);
 assert.equal((await route.POST(req({...input('call-summary'),sample:{}}))).status,400);
});

test('test runner submits the exact preview once and exposes output, timing and token usage',async()=>{
 const {runOperationTest}=await import('../lib/ai-operations/playground-service.mjs');
 const value=input('sentiment-intent');value.model='native/test-model';let count=0;
 const result=await runOperationTest(value,{apiKey:'synthetic-test-key',fetchImpl:async(url,options)=>{
  count++;assert.equal(url,'https://api.telnyx.com/v2/ai/chat/completions');
  assert.deepEqual(JSON.parse(options.body),build(value).request);
  return Response.json({usage:{prompt_tokens:100,completion_tokens:30},choices:[{finish_reason:'stop',message:{content:JSON.stringify({intent:'Appointment problem',tags:[],sentiment:'negative',sentimentScore:20})}}]});
 }});
 assert.equal(count,1);assert.equal(result.validation.valid,true);assert.equal(result.usage.inputTokens,100);assert.equal(result.model,value.model);
 assert.deepEqual(result.request,build(value).request);
});
test('provider failures do not expose sensitive payloads or trigger a retry',async()=>{
 const {runOperationTest}=await import('../lib/ai-operations/playground-service.mjs');let count=0;
 await assert.rejects(runOperationTest(input('call-summary'),{apiKey:'test',defaultModel:'platform/model',fetchImpl:async()=>{count++;return Response.json({error:'SECRET-SAMPLE-CONTENT'},{status:400});}}),error=>error.providerStatus===400&&!error.message.includes('SECRET'));
 assert.equal(count,1);
 await assert.rejects(runOperationTest(input('call-summary'),{apiKey:'',defaultModel:'platform/model'}),error=>error.status===503);
 // Without any configured model the lab reports it instead of using a model from code.
 await assert.rejects(runOperationTest(input('call-summary'),{apiKey:'test'}),error=>error.status===503&&/No AI model is configured/.test(error.message));
});
test('test endpoint requires update permission and rejects read-only users',async()=>{
 const {readPlaygroundInput}=await import('../lib/ai-operations/playground-service.mjs');let calls=0;
 const route=await loadRoute('app/api/admin/ai-operations/test/route.js',{
  '@/lib/ai-operations/playground-service.mjs':{readPlaygroundInput,runOperationTest:async(_input,options)=>{calls++;assert.equal(options.defaultModel,'platform/model');return {ok:true};}},
  '@/lib/ai-operations/runtime.mjs':{platformDefaultModel:async()=>({model:'platform/model',source:'env'})},
  '@/lib/authz/guard':{withPermission:(permission,handler)=>{assert.equal(permission,'system_settings:update');return (req,allowed=false)=>allowed?handler(req):{status:403};}}
 });
 const req=()=>new Request('http://localhost/test',{method:'POST',body:JSON.stringify(input('call-summary'))});
 assert.equal((await route.POST(req())).status,403);assert.equal(calls,0);
 assert.equal((await route.POST(req(),true)).status,200);assert.equal(calls,1);
});
