import test from 'node:test';
import assert from 'node:assert/strict';
import {createDefaultTool} from '../lib/ai/assistant-tool-defaults.mjs';
import {normalizeAssistantTool} from '../lib/ai/assistant-payload.mjs';
import {validateAssistantToolConfiguration as validate} from '../lib/ai/assistant-tool-validation.js';
import {ASSISTANT_TOOL_TYPES} from '../config/assistant-tools.js';
test('every tool can be added without browser globals or demo data',()=>{
 for(const {type} of ASSISTANT_TOOL_TYPES) {const tool=createDefaultTool(type);assert.equal(tool.type,type);assert.notEqual(tool,createDefaultTool(type));}
 const webhook=createDefaultTool('webhook');assert.equal(webhook.webhook.name,'custom_webhook');assert.equal(validate(webhook),'');assert(!JSON.stringify(webhook).includes('integration_secret'));assert.equal(normalizeAssistantTool(webhook).timeout_ms,30000);
});
test('variable editor rejects missing, duplicate and reserved names',()=>{
 const tool={type:'update_dynamic_variables',update_dynamic_variables:{name:'collect_details',description:'Collect caller details',updatable_variables:[{name:'customer_name',type:'string'}]}};
 assert.equal(validate(tool),'');for(const vars of [[],[{name:'telnyx_secret'}],[{name:'bad name'}],[{name:'a'},{name:'a'}]])assert(validate({...tool,update_dynamic_variables:{...tool.update_dynamic_variables,updatable_variables:vars}}));
});
test('payment requires connector and clear instructions',()=>{
 assert(validate(createDefaultTool('pay')));assert.equal(validate({type:'pay',pay:{connector_name:'test',description:'Collect only on request'}}),'');
});
test('retrieval preserves selected sources and rejects invalid result limits',()=>{
 const tool={type:'retrieval',retrieval:{bucket_ids:['controlled-test'],max_num_results:3}};assert.equal(validate(tool),'');
 for(const max_num_results of [0,-1,1.5])assert(validate({...tool,retrieval:{...tool.retrieval,max_num_results}}));assert(validate(createDefaultTool('retrieval')));
});
