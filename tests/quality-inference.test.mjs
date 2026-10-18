import test from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute,TEST_PLATFORM_MODEL} from './helpers/route-harness.mjs';
import * as scoring from '../lib/quality/scoring.mjs';
import * as models from '../lib/quality/models.mjs';
import * as errors from '../lib/quality/provider-error.mjs';
const schema={sections:[{id:'s',criteria:[{id:'verification',label:'Verification',type:'boolean',maxScore:1,weight:2},{id:'resolution',label:'Resolution',type:'score',maxScore:5,weight:1}]}]};
async function evaluator(fetch){
 return loadRoute('lib/quality/ai-evaluator.mjs',{
  '@/lib/telnyx':{buildTelnyxV2Url:p=>'https://api.telnyx.test/v2'+p},
  '@/lib/diagnostic-logger.mjs':{createDiagnosticLogger:()=>({error(){}})},
  '@/lib/quality/scoring.mjs':scoring,'./models.mjs':models,'./provider-error.mjs':errors,
  env:{TELNYX_API_KEY:'test-secret'},fetch});
}
test('without a scorecard model the evaluator uses the AI Copilot model chain and returns a complete scored draft',async()=>{
 let body;
 const api=await evaluator(async(url,request)=>{body=JSON.parse(request.body);assert.equal(url,'https://api.telnyx.test/v2/ai/chat/completions');return Response.json({choices:[{message:{content:JSON.stringify({answers:[{criterionId:'verification',score:1,reasoning:'Verified',evidence:'Confirmed details',confidence:0.9},{criterionId:'resolution',score:4,confidence:0.8}],summary:'Resolved'})}}]});});
 const result=await api.evaluateTranscriptWithAi({schema,transcriptText:'Agent: Confirmed details. Customer: Resolved.'});
 assert.equal(body.model,TEST_PLATFORM_MODEL);assert.equal('DEFAULT_EVALUATION_MODEL' in models,false,'no evaluation model in code');assert.equal(models.resolveEvaluationModel(null,{}),null);
 assert.equal(result.score.scorePercent,85.71);assert.equal(Object.keys(result.answers).length,2);assert.equal(result.answers.verification.source,'ai');
});
test('Telnyx errors[] are actionable, redact keys, and preserve provider status without logging conversation',async()=>{
 const api=await evaluator(async()=>Response.json({errors:[{code:'10015',detail:'openai/gpt-4o requires a customer-provided API key on public endpoints. test-secret'}]},{status:400}));
 await assert.rejects(api.evaluateTranscriptWithAi({schema,transcriptText:'Synthetic test',model:'openai/gpt-4o'}),e=>{
  assert.equal(e.status,422);assert.equal(e.providerStatus,400);assert.match(e.message,/customer-provided API key/);assert.match(e.message,/Telnyx-hosted/);assert.doesNotMatch(e.message,/test-secret/);return true;});
});
test('missing criteria and invalid scores never become a successful zero-scored AI draft',async()=>{
 for(const answers of [[],[{criterionId:'verification',score:1}],[{criterionId:'verification',score:1},{criterionId:'resolution',score:'wrong'}],[{criterionId:'verification',score:1},{criterionId:'resolution'}]]){
  const api=await evaluator(async()=>Response.json({choices:[{message:{content:JSON.stringify({answers})}}]}));
  await assert.rejects(api.evaluateTranscriptWithAi({schema,transcriptText:'Synthetic'}),/did not return valid scores/);
 }
});
test('N/A is permitted with evidence-based reason and explicit model choice is respected',async()=>{
 let selected;
 const api=await evaluator(async(_,r)=>{selected=JSON.parse(r.body).model;return Response.json({choices:[{message:{content:JSON.stringify({answers:[{criterionId:'verification',na:true,reasoning:'No identity task'},{criterionId:'resolution',score:5}]})}}]});});
 const result=await api.evaluateTranscriptWithAi({schema,transcriptText:'Synthetic',model:'custom/model',aiPromptConfig:{model:'form/model'}});
 assert.equal(selected,'custom/model');assert.equal(result.score.scorePercent,100);assert.equal(result.answers.verification.score,null);
 assert.equal(models.resolveEvaluationModel(null,{model:'form/model'}),'form/model');
});
test('Quality model catalogue filters hosted inference only without changing the general Assistant catalogue',async()=>{
 const catalogue=[{id:'native',owned_by:'Telnyx',task:'text-generation'},{id:'gemma',owned_by:'Telnyx',task:'text-to-text'},{id:'openai/gpt-4o',owned_by:'openai',task:'text generation'},{id:'embedding',owned_by:'Telnyx',task:'embedding'}];
 const route=await loadRoute('app/api/ai/models/route.js',{
  '@/lib/telnyx':{buildTelnyxV2Url:p=>'https://api.telnyx.test/v2'+p},'@/lib/quality/models.mjs':models,
  '@/lib/auth-server':{getAuthenticatedUser:async()=>({id:'tester',roles:['admin']})},
  env:{TELNYX_API_KEY:'test-secret'},fetch:async()=>Response.json({data:catalogue})});
 const scoped=await route.GET(new Request('http://local/api/ai/models?capability=quality-evaluation'));
 assert.equal(scoped.status,200);assert.deepEqual(scoped.body.models.map(m=>m.id),['native','gemma']);assert.equal(scoped.body.default_model,TEST_PLATFORM_MODEL,"the AI Copilot model, not a model in code");
 const all=await route.GET(new Request('http://local/api/ai/models'));assert.equal(all.body.models.length,4);
});
