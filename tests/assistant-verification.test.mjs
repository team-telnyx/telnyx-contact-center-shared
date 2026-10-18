import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantWriteDifferences} from '../lib/ai/assistant-verification.mjs';
test('read-back ignores retained silence volume and inactive noise engine tuning only',()=>{
 const previous={voice_settings:{background_audio:{type:'predefined_media',value:'office',volume:0.4}},telephony_settings:{noise_suppression:'deepfilternet',noise_suppression_config:{attenuation_limit:65,mode:'advanced'}}};
 const expected={voice_settings:{background_audio:{type:'predefined_media',value:'silence'}},telephony_settings:{noise_suppression:'aicoustics',noise_suppression_config:{family:'quail',size:'vf',enhancement_level:0.6}}};
 const actual={voice_settings:{background_audio:{...expected.voice_settings.background_audio,volume:0.4}},telephony_settings:{...expected.telephony_settings,noise_suppression_config:{...previous.telephony_settings.noise_suppression_config,...expected.telephony_settings.noise_suppression_config}}};
 assert.deepEqual(assistantWriteDifferences(expected,actual,'',previous),[]);
 actual.telephony_settings.noise_suppression_config.enhancement_level=0.8;
 assert.deepEqual(assistantWriteDifferences(expected,actual,'',previous),['telephony_settings.noise_suppression_config.enhancement_level']);
 assert.equal(previous.voice_settings.background_audio.volume,0.4);
});
test('active volume, attenuation, tool audio clearing, unknown settings and engine changes remain verified',()=>{
 for (const [expected,actual,path] of [
  [{voice_settings:{background_audio:{type:'predefined_media',value:'office',volume:0.4}}},{voice_settings:{background_audio:{type:'predefined_media',value:'office',volume:0.9}}},'voice_settings.background_audio.volume'],
  [{telephony_settings:{noise_suppression:'deepfilternet',noise_suppression_config:{attenuation_limit:65}}},{telephony_settings:{noise_suppression:'deepfilternet',noise_suppression_config:{attenuation_limit:100}}},'telephony_settings.noise_suppression_config.attenuation_limit'],
  [{voice_settings:{tool_call_audio:null}},{voice_settings:{tool_call_audio:{type:'predefined_media',value:'typing'}}},'voice_settings.tool_call_audio'],
  [{telephony_settings:{noise_suppression:'aicoustics',noise_suppression_config:{future_setting:1}}},{telephony_settings:{noise_suppression:'aicoustics',noise_suppression_config:{}}},'telephony_settings.noise_suppression_config.future_setting'],
  [{telephony_settings:{noise_suppression:'aicoustics'}},{telephony_settings:{noise_suppression:'deepfilternet'}},'telephony_settings.noise_suppression'],
 ]) assert(assistantWriteDifferences(expected,actual).includes(path));
});
test('workflow silence accepts irrelevant retained volume, but still detects changes to voice speed',()=>{
 const previous={conversation_flow:{nodes:[{id:'start',voice_settings:{voice_speed:1,background_audio:{type:'predefined_media',value:'office',volume:0.7}}}]}};
 const expected=structuredClone(previous); expected.conversation_flow.nodes[0].voice_settings.background_audio={type:'predefined_media',value:'silence'};
 const actual=structuredClone(expected); actual.conversation_flow.nodes[0].voice_settings.background_audio.volume=0.7;
 assert.deepEqual(assistantWriteDifferences(expected,actual,'',previous),[]);
 actual.conversation_flow.nodes[0].voice_settings.voice_speed=1.2;
 assert.deepEqual(assistantWriteDifferences(expected,actual,'',previous),['conversation_flow.nodes[0].voice_settings.voice_speed']);
});
test('switching to custom media accepts retained predefined volume without ignoring the chosen source',()=>{
 for(const type of ['media_url','media_name']) {
  const previous={voice_settings:{background_audio:{type:'predefined_media',value:'office',volume:0.4}}};
  const expected={voice_settings:{background_audio:{type,value:'custom-source'}}};
  const actual={voice_settings:{background_audio:{type,value:'custom-source',volume:0.4}}};
  assert.deepEqual(assistantWriteDifferences(expected,actual,'',previous),[]);
  actual.voice_settings.background_audio.value='wrong-source';
  assert.deepEqual(assistantWriteDifferences(expected,actual,'',previous),['voice_settings.background_audio.value']);
 }
});
test('read-back identifies silently ignored external fallback and voice speed',()=>{
 assert.deepEqual(assistantWriteDifferences({fallback_config:{external_llm:{model:'alias'}},voice_settings:{speed:1.1}},{fallback_config:{external_llm:null},voice_settings:{voice:'x'}}),['fallback_config.external_llm','voice_settings.speed']);
});
test('read-back accepts server defaults and observed empty normalization',()=>{
 assert.deepEqual(assistantWriteDifferences({model:'',enabled_features:[],voice_settings:{voice:'x'},fallback_config:null},{model:null,enabled_features:null,voice_settings:{voice:'x',temperature:0.5},fallback_config:{model:null,external_llm:null}}),[]);
});
test('read-back does not report external removal when null was ignored',()=>{
 assert.deepEqual(assistantWriteDifferences({external_llm:null},{external_llm:{model:'alias',base_url:'https://example.com'}}),['external_llm']);
});

test('read-back rejects ignored object and variable-map clearing',()=>{
 assert.deepEqual(assistantWriteDifferences({dynamic_variables:{}},{dynamic_variables:{old:'value'}}),['dynamic_variables']);
 assert.deepEqual(assistantWriteDifferences({dynamic_variables:{keep:'value'}},{dynamic_variables:{keep:'value',old:'value'}}),['dynamic_variables.old']);
 assert.deepEqual(assistantWriteDifferences({dynamic_variables:{}},{dynamic_variables:null}),[]);
 assert.deepEqual(assistantWriteDifferences({widget_settings:{theme:{}}},{widget_settings:{theme:{color:'red'}}}),['widget_settings.theme']);
});

test('read-back detects removed nested properties against the pre-write snapshot while allowing new defaults',()=>{
 const before={name:'before',voice_settings:{voice:'test',api_key_ref:'old-secret'}};
 const expected={voice_settings:{voice:'test'}};
 assert.deepEqual(assistantWriteDifferences(expected,{...before,voice_settings:{...before.voice_settings,speed:1}},'',before),['voice_settings.api_key_ref']);
 assert.deepEqual(assistantWriteDifferences(expected,{...before,voice_settings:{voice:'test',api_key_ref:null,speed:1}},'',before),[]);
 assert.deepEqual(assistantWriteDifferences({name:'renamed'},{...before,name:'renamed'},'',before),[]);
});
