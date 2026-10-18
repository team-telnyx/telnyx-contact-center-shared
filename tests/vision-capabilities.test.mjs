import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantVisionCapability, assertVisionCapability } from '../lib/ai/vision-capabilities.mjs';
import { validateAssistantDraftChanges } from '../lib/ai/assistant-contract.mjs';
import { readVideoResponse } from '../lib/video/client-response.mjs';
import { validateAssistantVisionTools } from '../lib/ai/vision-validation.mjs';
const catalog = [ {id:'moonshotai/Kimi-K2.6',is_vision_supported:true,recommended_for_assistants:true}, {id:'text-only',is_vision_supported:false,recommended_for_assistants:true} ];
test('Vision checks provider, catalog, fallback and the known failing model',()=>{
 const model='moonshotai/Kimi-K2.6';
 assert.equal(assistantVisionCapability({model},catalog).recommended,true);
 for(const config of [{model:'text-only'},{model:'unknown'},{model,external_llm:{base_url:'https://example.test'}},{model,fallback_config:{model:'text-only'}},{model:'moonshotai/Kimi-K2.5'}])assert.throws(()=>assertVisionCapability(config,catalog),e=>e.status===400);
 assert.throws(()=>assertVisionCapability({model:'openai/gpt-live-1'},catalog,{buffered:true}),/GPT-Live/);
});
test('Vision contract permits documented defaults and rejects stale-frame limits below one',()=>{
 for(const tool of [{type:'vision'},{type:'vision',vision:{}},{type:'vision',vision:{max_frame_age_secs:10}}])assert.deepEqual(validateAssistantDraftChanges({tools:[tool]}),[]);
 assert(validateAssistantDraftChanges({tools:[{type:'vision',vision:{max_frame_age_secs:0}}]}).length);
});
test('Vision validates every prompt-node LLM override including external and credential-only bundles',()=>{
 const model='moonshotai/Kimi-K2.6';
 const assistant=nodes=>({model,fallback_config:{model},conversation_flow:{nodes}});
 for(const override of [{model:'text-only'},{model:'unknown'},{external_llm:{model:'custom',base_url:'https://example.test'}},{llm_api_key_ref:'node-secret'}]) {
  const config=assistant([{id:'first',model},{id:'review',name:'Review image',...override}]);
  assert.throws(()=>assertVisionCapability(config,catalog),/Workflow node Review image:/);
 }
 assert.equal(assertVisionCapability(assistant([{id:'inherited'},{id:'cleared',model:null,external_llm:null,llm_api_key_ref:null},{id:'override',type:'prompt',model,llm_api_key_ref:'node-secret'},{id:'script',type:'speak',message:'Hello'},{id:'tool',type:'tool',shared_tool_id:'test'}]),catalog).status,'supported');
 assert.throws(()=>assertVisionCapability(assistant([{id:'realtime',model:'openai/gpt-live-1'}]),catalog,{buffered:true}),/Workflow node realtime: GPT-Live/);
});
test('chat image capability follows the catalog independently of buffered-frame tool support',()=>{
 const model='openai/gpt-live-1';
 // Live catalog on 2026-10-18 marks GPT-Live as not supporting images.
 assert.throws(()=>assertVisionCapability({model},[{id:model,is_vision_supported:false,recommended_for_assistants:true}]),/does not support images/);
 // If chat image support is added, the buffered Vision tool restriction must
 // remain specific to the realtime frame transport, not ordinary chat images.
 const futureCatalog=[{id:model,is_vision_supported:true,recommended_for_assistants:true}];
 assert.equal(assertVisionCapability({model},futureCatalog).status,'supported');
 assert.throws(()=>assertVisionCapability({model},futureCatalog,{buffered:true}),/GPT-Live/);
});
test('Vision does not certify a workflow that transfers images to an unverified assistant',()=>{
 const root={id:'source',model:'moonshotai/Kimi-K2.6',conversation_flow:{nodes:[],edges:[{target:{type:'assistant',assistant_id:'other'}}]}};
 assert.equal(assistantVisionCapability(root,catalog).status,'unknown');
 assert.throws(()=>assertVisionCapability(root,catalog),/workflow assistant transitions/);
 assert.throws(()=>assertVisionCapability(root,catalog,{buffered:true}),/workflow assistant transitions/);
 root.conversation_flow.edges[0].target.assistant_id='source';assert.equal(assertVisionCapability(root,catalog).status,'supported');
 root.conversation_flow.edges[0].target={type:'node',node_id:'same-assistant'};assert.equal(assertVisionCapability(root,catalog).status,'supported');
});
test('shared and node-level Vision attachments require a compatible model',async()=>{
 const request=async path=>path==='/ai/openai/models'?{data:catalog}:{data:{type:'vision'}};
 for(const config of [{tools:[{type:'vision'}]},{tool_ids:['shared-vision']},{conversation_flow:{nodes:[{id:'inspect',shared_tool_ids:['shared-vision']}]}}]) {
  await assert.rejects(validateAssistantVisionTools({model:'text-only',...config},{request}),/does not support images/);
  await validateAssistantVisionTools({model:'moonshotai/Kimi-K2.6',...config},{request});
 }
});
test('clearing shared Vision is allowed and non-Vision tools do not require a Vision model',async()=>{
 let calls=0;
 await validateAssistantVisionTools({model:'text-only',tools:[{tool_id:'removed',type:'vision'}],tool_ids:[]},{request:async()=>{calls++;throw Error('Unexpected lookup');}});
 assert.equal(calls,0);
 await validateAssistantVisionTools({model:'text-only',tool_ids:['normal-tool']},{request:async()=>({data:{type:'webhook'}})});
 await assert.rejects(validateAssistantVisionTools({model:'text-only',tool_ids:['unknown-tool']},{request:async()=>{throw Error('Tool unavailable');}}),/Tool unavailable/);
});
test('video actions handle empty error responses without surfacing JSON parser errors',async()=>{
 await assert.rejects(readVideoResponse(new Response(null,{status:503})),/service is unavailable/);
 await assert.rejects(readVideoResponse(new Response('upstream failed',{status:502})),/could not be confirmed/);
 await assert.rejects(readVideoResponse(Response.json({error:'Publish the video profile'},{status:503})),/Publish the video profile/);
 assert.deepEqual(await readVideoResponse(Response.json({ok:true})),{ok:true});
});
