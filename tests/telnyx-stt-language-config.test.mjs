import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

function assertEditorLanguageUi(editorSource, editorName) {
  assert.match(editorSource, /telnyx_stt_language_source/,
    `${editorName} should support static vs variable STT language source`);
  assert.match(editorSource, /telnyx_stt_use_caller_language/,
    `${editorName} should expose Use Caller Language config`);
  assert.match(editorSource, /hasCallerLanguageParameterBefore[\s\S]*Use Caller Language/,
    `${editorName} should show Use Caller Language only when caller_language is available upstream`);
  assert.match(editorSource, /<VariableInput[\s\S]*(telnyx_stt_language|setTelnyxSttLanguageValue)/,
    `${editorName} should allow STT language to be entered as a variable`);
}

test("Standalone STT language options are sourced per exact model from TRANSCRIPTION_PROVIDERS", async () => {
  const providerSource = await source("../config/ai-streaming-providers.js");

  assert.match(providerSource, /import \{ TRANSCRIPTION_PROVIDERS \} from "\.\/voice"/);
  assert.match(providerSource, /standaloneSttLanguagesForModel\(model\)/);
  assert.match(providerSource, /entry\.model_name === normalizedModel/);
  assert.match(providerSource, /provider\?\.languages/);
  assert.match(providerSource, /normalizeLanguageCode\(code/);
  assert.match(providerSource, /value: normalizedCode/);
  assert.match(providerSource, /const seen = new Set\(\)/);
  assert.match(providerSource, /label: `\$\{language\.flag\} \$\{language\.name\}`/);
  assert.doesNotMatch(
    providerSource,
    /label: `\$\{language\.flag\} \$\{language\.name\} \(\$\{code\}\)`/,
    "Language labels should not append language codes in parentheses",
  );
  assert.doesNotMatch(providerSource, /telnyxSttLanguagesForEngine/,
    "Do not use broad provider-level language lists; standalone STT languages differ per model");

  assert.match(providerSource, /model: "deepgram\/nova-2"[\s\S]*supported_languages: telnyxSttLanguagesForModel\("deepgram\/nova-2"\)/);
  assert.match(providerSource, /model: "deepgram\/nova-3"[\s\S]*supported_languages: telnyxSttLanguagesForModel\("deepgram\/nova-3"\)/);
  assert.match(providerSource, /model: "deepgram\/flux"[\s\S]*language: "auto"[\s\S]*supported_languages: telnyxSttLanguagesForModel\("deepgram\/flux"\)/);
  assert.match(providerSource, /model: "xai\/grok-stt"[\s\S]*supported_languages: telnyxSttLanguagesForModel\("xai\/grok-stt"\)/);
  assert.match(providerSource, /model: "speechmatics\/standard"[\s\S]*supported_languages: telnyxSttLanguagesForModel\("speechmatics\/standard"\)/);
});

test("Answer and Streaming Start expose Telnyx STT language selector with caller_language support", async () => {
  const answerEditor = await source("../components/voice-flow/AnswerNodeEditor.jsx");
  const streamingEditor = await source("../components/voice-flow/StreamingStartNodeEditor.jsx");

  assertEditorLanguageUi(answerEditor, "AnswerNodeEditor");
  assertEditorLanguageUi(streamingEditor, "StreamingStartNodeEditor");
  assert.match(answerEditor, /const model = provider\.telnyxStt\?\.model \|\| provider\.id;[\s\S]*const modelLabel = model;/,
    "AnswerNodeEditor model dropdown should show only the model, not provider/model with duplicated provider prefix");
  assert.match(streamingEditor, /const model = provider\.telnyxStt\?\.model \|\| provider\.id;[\s\S]*const modelLabel = model;/,
    "StreamingStartNodeEditor model dropdown should show only the model, not provider/model with duplicated provider prefix");
  assert.match(answerEditor, /\|\| "en";/,
    "AnswerNodeEditor STT fallback language should be a base code");
  assert.match(streamingEditor, /\|\| "en";/,
    "StreamingStartNodeEditor STT fallback language should be a base code");
  assert.doesNotMatch(answerEditor, /\|\| "en-US";/,
    "AnswerNodeEditor STT fallback language should not be regional en-US");
  assert.doesNotMatch(streamingEditor, /\|\| "en-US";/,
    "StreamingStartNodeEditor STT fallback language should not be regional en-US");
});

test("call flow page passes upstream caller_language availability to STT-capable editors", async () => {
  const pageSource = await source("../app/(portal)/admin/call-flows/[id]/page.jsx");
  assert.match(pageSource, /hasCallerLanguageParameterBeforeNode/);
  assert.match(pageSource, /<StreamingStartNodeEditor[\s\S]*hasCallerLanguageParameterBefore=\{hasCallerLanguageParameterBeforeNode\(selectedNode\.id\)\}/);
  assert.match(pageSource, /<AnswerNodeEditor[\s\S]*hasCallerLanguageParameterBefore=\{hasCallerLanguageParameterBeforeNode\(selectedNode\.id\)\}/);
});

test("voice-flow engine resolves Telnyx STT language from static, variable, or caller_language", async () => {
  const engineSource = await source("../lib/voice-flow-engine.js");
  assert.match(engineSource, /resolveTelnyxSttLanguage\(/);
  assert.match(engineSource, /normalizeSttLanguageCode/);
  assert.match(engineSource, /telnyx_stt_use_caller_language[\s\S]*caller_language/);
  assert.match(engineSource, /telnyx_stt_language_source === "variable"[\s\S]*resolveFormDataVariable/);
  assert.match(engineSource, /const\s+telnyxSttLanguage\s*=\s*resolveTelnyxSttLanguage/);
  assert.match(engineSource, /language:\s*telnyxSttLanguage/);
  assert.match(engineSource, /delete body\.telnyx_stt_language/);
  assert.match(engineSource, /delete body\.telnyx_stt_language_source/);
  assert.match(engineSource, /delete body\.telnyx_stt_use_caller_language/);
});

test("agent-leg Telnyx STT uses the assigned user's profile language", async () => {
  const webhookSource = await source("../lib/contact-center/webhook-handler.js");
  assert.match(webhookSource, /findUserByUsername\(agentUsername\)/);
  assert.match(webhookSource, /agentLanguage[\s\S]*normalizeLanguageCode\(agent\?\.language/);
  assert.match(webhookSource, /outboundConfig = \{[\s\S]*language: agentLanguage/);
  assert.doesNotMatch(webhookSource, /agent\?\.language \|\| sttConfig\.language \|\| "en-US"/);
});

test("language codes are normalized to STT-safe base codes", async () => {
  const { normalizeLanguageCode, normalizeSttLanguageCode } = await import("../lib/language-code-utils.js");

  assert.equal(normalizeLanguageCode("pl-PL"), "pl");
  assert.equal(normalizeLanguageCode("en-US"), "en");
  assert.equal(normalizeSttLanguageCode("pl-PL", { supportedCodes: ["en", "pl"] }), "pl");
  assert.equal(normalizeSttLanguageCode("en-US", { supportedCodes: ["en", "pl"] }), "en");
  assert.equal(normalizeSttLanguageCode("fr-FR", { supportedCodes: ["en", "pl"] }), "en");
});

test("queued interaction metadata is pre-populated with normalized agent language", async () => {
  const routerSource = await source("../lib/contact-center/queued-call-router.js");

  assert.match(routerSource, /u\.language/);
  assert.match(routerSource, /agent_language: agentLanguage/);
  assert.match(routerSource, /metadata: assignedMetadata \|\| interaction\.metadata/);
});

test("translation header and suggestions use bounded layout with language names", async () => {
  const workflowSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");

  assert.match(workflowSource, /normalizeBaseLanguageCode\(interactionMetadata\.caller_language/);
  assert.match(workflowSource, /normalizeBaseLanguageCode\(interactionMetadata\.agent_language/);
  assert.match(workflowSource, /en: "English"/);
  assert.match(workflowSource, /pl: "Polish"/);
  assert.doesNotMatch(workflowSource, /return String\(language\)\.toUpperCase\(\)/,
    "Translation header should show language names instead of raw PL-PL/EN-US codes");
  assert.match(workflowSource, /<span className="shrink-0">-<\/span>/);
  assert.match(workflowSource, /flex items-center gap-2 mb-2 min-w-0 overflow-hidden/);
  assert.match(workflowSource, /min-w-0 flex-1 truncate/);
});

test("Agent Assist transcription router accumulates provider-final STT deltas before translation", async () => {
  const routerSource = await source("../lib/agent-assist-transcription-router.mjs");

  assert.match(routerSource, /__agentAssistActiveTranscriptionSegments/);
  assert.match(routerSource, /function buildDisplayTranscript/);
  assert.match(routerSource, /isProviderFinal[\s\S]*activeTranscriptionSegments\.set/,
    "Provider-final chunks before speech_final should be accumulated for the open bubble");
  assert.match(routerSource, /transcript: displayTranscript \|\| transcriptionData\.transcript/,
    "Broadcasts and translation processing should use accumulated transcript text");
  assert.match(routerSource, /normalizeLanguageCode\(agent\?\.language, \{ fallback: "en" \}\)/,
    "Translation source/target languages should use normalized base language codes");
});
