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
  assert.match(providerSource, /function uniqueLanguageOptions\(codes\)/);
  assert.match(providerSource, /const seen = new Set\(\)/);
  assert.match(providerSource, /return uniqueLanguageOptions\(GOOGLE_STANDALONE_STT_LANGUAGE_CODES\)/,
    "Google regional language codes should be deduplicated after base-code normalization");
  assert.match(providerSource, /return uniqueLanguageOptions\(provider\?\.languages\)/);
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
  assert.match(providerSource, /model: "deepgram\/flux"[\s\S]*language: "en"[\s\S]*supported_languages: telnyxSttLanguagesForModel\("deepgram\/flux"\)/);
  assert.match(providerSource, /model: "xai\/grok-stt"[\s\S]*supported_languages: telnyxSttLanguagesForModel\("xai\/grok-stt"\)/);
  assert.match(providerSource, /model: "speechmatics\/standard"[\s\S]*supported_languages: telnyxSttLanguagesForModel\("speechmatics\/standard"\)/);
});

test("Answer and Streaming Start expose Telnyx STT language selector with caller_language support", async () => {
  const answerEditor = await source("../components/voice-flow/AnswerNodeEditor.jsx");
  const streamingEditor = await source("../components/voice-flow/StreamingStartNodeEditor.jsx");

  assertEditorLanguageUi(answerEditor, "AnswerNodeEditor");
  assertEditorLanguageUi(streamingEditor, "StreamingStartNodeEditor");
  assert.match(answerEditor, /const modelLabel = formatTelnyxSttModelLabel\(provider\);/,
    "AnswerNodeEditor model dropdown should show every model in provider/model format");
  assert.match(streamingEditor, /const modelLabel = formatTelnyxSttModelLabel\(provider\);/,
    "StreamingStartNodeEditor model dropdown should show every model in provider/model format");
  assert.match(answerEditor, /\|\| "en";/,
    "AnswerNodeEditor STT fallback language should be a base code");
  assert.match(streamingEditor, /\|\| "en";/,
    "StreamingStartNodeEditor STT fallback language should be a base code");
  assert.doesNotMatch(answerEditor, /\|\| "en-US";/,
    "AnswerNodeEditor STT fallback language should not be regional en-US");
  assert.doesNotMatch(streamingEditor, /\|\| "en-US";/,
    "StreamingStartNodeEditor STT fallback language should not be regional en-US");
});

test("Standalone STT model labels add the engine prefix only when the runtime model has none", async () => {
  const providerSource = await source("../config/ai-streaming-providers.js");

  assert.match(providerSource, /export function formatTelnyxSttModelLabel\(provider\)/);
  assert.match(providerSource, /provider\?\.telnyxStt\?\.transcription_engine/);
  assert.match(providerSource, /if \(!model \|\| model\.includes\("\/"\) \|\| !engine\) return model;/);
  assert.match(providerSource, /return `\$\{engine\}\/\$\{model\}`;/);
  assert.match(providerSource, /transcription_engine: "Google"[\s\S]*model: "phone_call"/,
    "The runtime model must stay unprefixed because the Telnyx WebSocket API receives the engine separately");
  assert.match(providerSource, /transcription_engine: "Google"[\s\S]*model: "latest_long"/);
  assert.match(providerSource, /transcription_engine: "Google"[\s\S]*model: "default"/);
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

test("agent transport transcript uses the assigned user's profile language", async () => {
  const webhookSource = await source("../lib/acd/media-events.mjs");
  assert.match(webhookSource, /SELECT language FROM users WHERE username = \$1/);
  assert.match(webhookSource, /agentLanguage[\s\S]*normalizeLanguageCode\(user\?\.language/);
  assert.match(webhookSource, /const outboundConfig = \{[\s\S]*language: agentLanguage/);
  assert.match(webhookSource, /startTelnyxSttMediaStream\([\s\S]*outboundConfig/);
  assert.doesNotMatch(webhookSource, /user\?\.language \|\| config\.language \|\| "en-US"/);
});

test("prewarmed agent-leg STT normalizes the profile language against the model", async () => {
  const handlerSource = await source("../lib/telnyx-stt-handler.mjs");
  assert.match(handlerSource, /normalizeAgentSttLanguage\(agent\?\.language, config\)/);
  assert.match(handlerSource, /configuredSupportedLanguageCodes/);
});

test("language codes are normalized to STT-safe base codes", async () => {
  const { normalizeLanguageCode, normalizeSttLanguageCode } = await import("../lib/language-code-utils.js");

  assert.equal(normalizeLanguageCode("pl-PL"), "pl");
  assert.equal(normalizeLanguageCode("en-US"), "en");
  assert.equal(normalizeSttLanguageCode("pl-PL", { supportedCodes: ["en", "pl"] }), "pl");
  assert.equal(normalizeSttLanguageCode("en-US", { supportedCodes: ["en", "pl"] }), "en");
  assert.equal(normalizeSttLanguageCode("fr-FR", { supportedCodes: ["en", "pl"] }), "en");
});

test("Core intake preserves the materialized agent language", async () => {
  const intakeSource = await source("../lib/acd/live-intake.mjs");
  assert.match(intakeSource, /agent_language: intake\.agentLanguage/);
});

test("translation header and suggestions use bounded layout with language names", async () => {
  const workflowSource = await source("../components/contact-center/AgentAssistWorkflow.jsx");

  assert.match(workflowSource, /contactCenter\?\.metadata/);
  assert.match(workflowSource, /normalizeBaseLanguageCode\(interactionMetadata\.caller_language/);
  assert.match(workflowSource, /normalizeBaseLanguageCode\(interactionMetadata\.agent_language/);
  assert.match(workflowSource, /\.\.\.\(interaction\?\.metadata \|\| \{\}\)[\s\S]*\.\.\.\(contactCenter\?\.metadata \|\| \{\}\)/,
    "Live active-call metadata should override stale interaction metadata so agent_language updates are reflected in the header");
  assert.match(workflowSource, /en: "English"/);
  assert.match(workflowSource, /pl: "Polish"/);
  assert.doesNotMatch(workflowSource, /return String\(language\)\.toUpperCase\(\)/,
    "Translation header should show language names instead of raw PL-PL/EN-US codes");
  assert.match(workflowSource, /<span className="shrink-0">→<\/span>/);
  assert.match(workflowSource, /flex flex-wrap items-center gap-1\.5 mb-2 min-w-0 max-w-full overflow-hidden/);
  assert.match(workflowSource, /max-w-full min-w-0 overflow-hidden truncate/);
});

test("Agent Assist transcription router accumulates provider-final STT deltas before translation", async () => {
  const routerSource = await source("../lib/agent-assist-transcription-router.mjs");
  const webhookSource = await source("../lib/acd/media-events.mjs");

  assert.match(routerSource, /__agentAssistActiveTranscriptionSegments/);
  assert.doesNotMatch(routerSource, /__agentAssistActiveConversationTracks/,
    "Do not close bubbles by speaker/track switching; each call leg must rely on STT finality markers");
  assert.match(routerSource, /const isMessageFinal = isUtteranceFinal\(transcriptionData\)/,
    "speech_final=true should close a bubble; is_final=true alone is only a fallback when speech_final is absent");
  assert.doesNotMatch(routerSource, /const isMessageFinal = (?!isUtteranceFinal)/,
    "the transcription router must not re-derive finality locally");
  assert.match(webhookSource, /return routeAgentAssistTranscription\(payload\)/,
    "the Core media adapter must delegate transcript finality to the shared router");
  assert.match(routerSource, /function buildDisplayTranscript/);
  assert.match(routerSource, /isProviderFinal[\s\S]*activeTranscriptionSegments\.set/,
    "Provider-final chunks before speech_final should be accumulated for the open bubble");
  assert.match(routerSource, /transcript: displayTranscript \|\| transcriptionData\.transcript/,
    "Broadcasts and translation processing should use accumulated transcript text");
  assert.match(routerSource, /normalizeLanguageCode\(agent\?\.language, \{ fallback: "en" \}\)/,
    "Translation source/target languages should use normalized base language codes");
});
