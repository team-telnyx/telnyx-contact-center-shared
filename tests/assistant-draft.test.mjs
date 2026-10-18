import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantForEditor,payloadForSave} from '../lib/ai/assistant-draft.mjs';
import {normalizeAssistantPayload} from '../lib/ai/assistant-payload.mjs';
import {validateAssistantDraftChanges} from '../lib/ai/assistant-contract.mjs';

test('a cleared required messaging timeout remains a visible invalid draft instead of disappearing from the patch',()=>{
 const original={messaging_settings:{conversation_inactivity_minutes:45,delivery_status_webhook_url:'https://example.test/events'}};
 const draft=assistantForEditor(original);
 draft.messaging.conversation_inactivity_minutes='';
 const payload=payloadForSave(draft,{patch:true});
 assert.equal(payload.messaging_settings.conversation_inactivity_minutes,'');
 assert.equal(payload.messaging_settings.delivery_status_webhook_url,original.messaging_settings.delivery_status_webhook_url);
 assert(validateAssistantDraftChanges(payload,original).some(error=>error.includes('conversation_inactivity_minutes')));
 draft.messaging.conversation_inactivity_minutes=60;
 assert.deepEqual(validateAssistantDraftChanges(payloadForSave(draft,{patch:true}),original),[]);
});

test('name edit preserves all configured values including external fallback and independent voice speeds',()=>{
 const saved={id:'read-only',created_at:'read-only',name:'Before',instructions:'',model:'hosted',
  external_llm:null,fallback_config:{external_llm:{model:'EXACT_ALIAS',base_url:'https://example.com/v1'}},
  voice_settings:{voice:'ElevenLabs.x',voice_speed:1.1,speed:0.9,tool_call_audio:null,language_voices:{pl:'x'},temperature:0},
  telephony_settings:{recording_settings:{enabled:false,stop_on_conversation_end:true,channels:'dual',format:'wav'}},
  enabled_features:[],tags:[],description:'',post_conversation_settings:{enabled:false},
  conversation_flow:{nodes:[{id:'n',tools_mode:'append'}]}};
 const draft=assistantForEditor(saved);draft.name='After';
 const result=payloadForSave(draft);
 for(const [k,v] of Object.entries(saved))if(!['id','created_at','name'].includes(k))assert.deepEqual(result[k],v,k);
 assert.equal(result.id,undefined);assert.equal(result.name,'After');
});
test('default values displayed by legacy voice controls are not materialized on an unrelated save',()=>{
 const draft=assistantForEditor({name:'x',instructions:''});
 assert.equal(payloadForSave(draft).voice_settings,undefined);
 draft.voice_speed=1.2;assert.deepEqual(payloadForSave(draft).voice_settings,{voice_speed:1.2});
});
test('legacy voicemail actions load canonically without changing unrelated saves',()=>{
 for(const [legacy,action] of Object.entries({stop:'stop_assistant',leave_message:'leave_message_and_stop_assistant',continue:'continue_assistant'})){
  const source={name:'before',telephony_settings:{voicemail_detection:{on_voicemail_detected:legacy,voicemail_message:'Keep this message'}}};
  const draft=assistantForEditor(source);
  assert.equal(draft.telephony.voicemail_detection.on_voicemail_detected.action,action);
  if(legacy==='leave_message')assert.deepEqual(draft.telephony.voicemail_detection.on_voicemail_detected.voicemail_message,{type:'message',message:'Keep this message'});
  assert.deepEqual(payloadForSave(draft,{patch:true}),{});
  draft.name='after';assert.deepEqual(payloadForSave(draft,{patch:true}),{name:'after'});
  draft.telephony.voicemail_detection.on_voicemail_detected.action='continue_assistant';
  if(legacy!=='continue')assert.equal(payloadForSave(draft,{patch:true}).telephony_settings.voicemail_detection.on_voicemail_detected.action,'continue_assistant');
  assert.equal(source.telephony_settings.voicemail_detection.on_voicemail_detected,legacy);
 }
});
test('new canonical settings and legacy edited aliases coexist without overwriting unrelated fields',()=>{
 const draft=assistantForEditor({name:'x',voice_settings:{voice:'x',speed:1.1,tool_call_audio:null},telephony_settings:{disable_dtmf:true}});
 draft.voice_settings.tool_call_audio={type:'predefined_media',value:'typing'};draft.voice_speed=0.9;
 draft.telephony={...draft.telephony,recording_settings:{enabled:false}};
 const p=payloadForSave(draft);assert.equal(p.voice_settings.speed,1.1);assert.equal(p.voice_settings.voice_speed,0.9);
 assert.equal(p.voice_settings.tool_call_audio.value,'typing');assert.equal(p.telephony_settings.disable_dtmf,true);
});
test('legacy tool repairs are idempotent and preserve canonical placement and tools_mode',()=>{
 const source={tools:[{type:'webhook',async:false,webhook:{async:true,timeout_secs:12,filler_messages:[{type:'on_start',message:'Working'},{type:'on_delay',message:'Still working',delay_ms:1000}]}},{type:'transfer',warm_transfer_instructions:'Context',transfer:{sip_headers:[{name:'X-Test',value:'yes'}]}}],conversation_flow:{nodes:[{tools_mode:'replace',tools_override:true}]}};
 const n=normalizeAssistantPayload(source);assert.deepEqual(normalizeAssistantPayload(n),n);assert.equal(n.tools[0].timeout_ms,12000);assert.equal(n.tools[0].webhook.async,false);assert.equal(n.tools[0].webhook.messages[1].timing_ms,1000);assert.equal(n.tools[1].transfer.warm_transfer_instructions,'Context');assert.equal(n.conversation_flow.nodes[0].tools_mode,'replace');assert.equal(source.tools[0].webhook.async,true);
});

test('patch saves change only edited roots and do not overwrite concurrently managed settings',()=>{
 const draft=assistantForEditor({name:'before',instructions:'',description:'',model:'hosted',greeting:'',tools:[],dynamic_variables:{},fallback_config:{external_llm:{model:'alias',base_url:'https://example.com'}}});draft.name='after';
 assert.deepEqual(payloadForSave(draft,{patch:true}),{name:'after'});
});

test('catalog and advanced voice controls share a value without overwriting independent speeds',async()=>{
 const {assistantVoiceSettings,withAssistantVoiceSettings}=await import('../lib/ai/assistant-draft.mjs');
 let draft=assistantForEditor({voice_settings:{voice:'original',voice_speed:1,speed:0.9}});
 draft.voice_speed=1.2;
 draft=withAssistantVoiceSettings(draft,{...assistantVoiceSettings(draft),voice:'{{voice_id}}',tool_call_audio:{type:'predefined_media',value:'typing'}});
 const payload=payloadForSave(draft,{patch:true});
 assert.equal(payload.voice_settings.voice,'{{voice_id}}');assert.equal(payload.voice_settings.speed,0.9);assert.equal(payload.voice_settings.voice_speed,1.2);
 draft.voice='catalog-selection';assert.equal(assistantVoiceSettings(draft).voice,'catalog-selection');
});
