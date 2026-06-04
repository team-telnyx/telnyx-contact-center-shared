import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

function assertEditorLanguageUi(editorSource, editorName) {
  assert.match(editorSource, /TELNYX_STT_LANGUAGE_OPTIONS/,
    `${editorName} should define model-aware Telnyx STT language options`);
  assert.match(editorSource, /telnyx_stt_language_source/,
    `${editorName} should support static vs variable STT language source`);
  assert.match(editorSource, /telnyx_stt_use_caller_language/,
    `${editorName} should expose Use Caller Language config`);
  assert.match(editorSource, /hasCallerLanguageParameterBefore[\s\S]*Use Caller Language/,
    `${editorName} should show Use Caller Language only when caller_language is available upstream`);
  assert.match(editorSource, /<VariableInput[\s\S]*(telnyx_stt_language|setTelnyxSttLanguageValue)/,
    `${editorName} should allow STT language to be entered as a variable`);
}

test("Answer and Streaming Start expose Telnyx STT language selector with caller_language support", async () => {
  assertEditorLanguageUi(await source("../components/voice-flow/AnswerNodeEditor.jsx"), "AnswerNodeEditor");
  assertEditorLanguageUi(await source("../components/voice-flow/StreamingStartNodeEditor.jsx"), "StreamingStartNodeEditor");
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
  assert.match(webhookSource, /agentLanguage[\s\S]*agent\?\.language/);
  assert.match(webhookSource, /outboundConfig = \{[\s\S]*language: agentLanguage/);
});
