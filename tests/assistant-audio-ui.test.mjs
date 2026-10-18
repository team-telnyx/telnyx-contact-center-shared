import test from "node:test";
import assert from "node:assert/strict";
import { enabledAiCousticsSettings } from "../lib/ai/assistant-audio-ui.mjs";
import { backgroundAudioEnabled, compatibleVoiceAudio } from "../lib/ai/assistant-audio-ui.mjs";
import { assistantForEditor, assistantVoiceSettings, withAssistantVoiceSettings, payloadForSave } from "../lib/ai/assistant-draft.mjs";
import { normalizeAssistantPayload } from "../lib/ai/assistant-payload.mjs";
import { assistantSaveErrorMessage, assistantVerificationMessage } from "../lib/ai/assistant-save-feedback.mjs";

test("all background sound sources block tool audio, including zero volume and unfinished custom sources", () => {
  for (const background of [{type:'predefined_media',value:'office',volume:0}, {type:'media_url',value:''}, {type:'media_name',value:'sound'}]) {
    assert.equal(backgroundAudioEnabled(background), true);
    assert.equal(compatibleVoiceAudio({background_audio:background,tool_call_audio:{type:'predefined_media',value:'typing'}}).tool_call_audio,null);
  }
  for (const background of [undefined,null,{type:'predefined_media',value:'silence'}]) assert.equal(backgroundAudioEnabled(background),false);
});

test("switching to background audio clears saved tool audio atomically without altering other voice settings", () => {
  const voice = {voice:'Telnyx.KokoroTTS.af_heart',voice_speed:1.1,tool_call_audio:{type:'predefined_media',value:'typing',volume:0.4},background_audio:{type:'predefined_media',value:'silence',volume:0.5}};
  const original = {name:'Fixture',voice_settings:voice};
  const draft=assistantForEditor(original);
  const changed={...draft,background_audio:{type:'predefined_media',value:'office',volume:0.7}};
  const updated=withAssistantVoiceSettings(changed,compatibleVoiceAudio(assistantVoiceSettings(changed)));
  assert.equal(updated.voice_settings.tool_call_audio,null);
  assert.deepEqual(payloadForSave(updated,{patch:true}),{voice_settings:{...voice,background_audio:changed.background_audio,tool_call_audio:null}});
  const silence=withAssistantVoiceSettings(updated,compatibleVoiceAudio({...assistantVoiceSettings(updated),background_audio:{type:'predefined_media',value:'silence'}}));
  assert.equal(silence.voice_settings.tool_call_audio,null, 'Silence must not reactivate tool audio automatically');
  assert.deepEqual(original.voice_settings,voice);
});

test("save normalization protects main voice and workflow overrides and sends explicit clearing even when omitted", () => {
  const settings={voice:'x',background_audio:{type:'predefined_media',value:'office',volume:0.5}};
  const input={voice_settings:settings,conversation_flow:{nodes:[{id:'start',voice_settings:{...settings,tool_call_audio:{type:'predefined_media',value:'typing'}}}]}};
  const result=normalizeAssistantPayload(input);
  assert.equal(result.voice_settings.tool_call_audio,null);
  assert.equal(result.conversation_flow.nodes[0].voice_settings.tool_call_audio,null);
  assert(!('tool_call_audio' in input.voice_settings));
});

test("save messages describe settings and recovery without exposing API paths", () => {
  const warning=assistantVerificationMessage({paths:['voice_settings.background_audio.volume','telephony_settings.noise_suppression_config.attenuation_limit']});
  assert.match(warning,/background audio volume/); assert.match(warning,/noise reduction strength/); assert.match(warning,/draft/);
  assert.doesNotMatch(warning,/voice_settings|telephony_settings|attenuation_limit/);
  for (const error of ['voice_settings.tool_call_audio cannot be set while voice_settings.background_audio is enabled.', 'voice_settings.background_audio.volume: should be number', 'Unknown schema FooSettings null array', {message:'body.voice_settings: invalid'}]) {
    assert.doesNotMatch(assistantSaveErrorMessage(error),/voice_settings|FooSettings|should be number|body\./);
  }
  assert.match(assistantSaveErrorMessage('tool_call_audio conflicts with background_audio'),/Choose Silence/);
  assert.match(assistantVerificationMessage({status:'unavailable'}),/could not confirm/);
});
test("re-enabling AiCoustics preserves compatible saved tuning", () => {
  const config = { family: "quail", size: "vf_2_0_l", enhancement_level: 0.35 };
  const enabled = enabledAiCousticsSettings({
    noise_suppression: "disabled",
    noise_suppression_config: config,
  });
  assert.deepEqual(enabled, config);
  assert.notEqual(enabled, config);
});
test("unconfigured or incompatible suppression gets valid AiCoustics defaults", () => {
  for (const telephony of [
    {},
    { noise_suppression_config: { attenuation_limit: 80, mode: "advanced" } },
  ]) {
    assert.deepEqual(enabledAiCousticsSettings(telephony), {
      family: "quail",
      size: "vf",
      enhancement_level: 0.8,
    });
  }
});
