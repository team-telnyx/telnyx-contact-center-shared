import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("online translation is implemented with Telnyx chat completions and workflow model", () => {
  const translationService = read("lib/agent-assist/translation-service.js");
  const router = read("lib/agent-assist-transcription-router.mjs");
  const webhookHandler = read("lib/contact-center/webhook-handler.js");

  assert.match(translationService, /\/ai\/chat\/completions/);
  assert.match(translationService, /model:\s*model \|\| DEFAULT_TRANSLATION_MODEL/);
  assert.match(translationService, /response_format\s*:\s*responseFormat \|\| \{\s*type:\s*["']json_object["']/);
  assert.match(translationService, /export async function detectLanguage/);
  assert.doesNotMatch(translationService, /GOOGLE_TRANSLATE|translation\.googleapis/);

  assert.match(router, /resolveAgentAssistAnalysisModel\(assistConfig\)/);
  assert.match(router, /const translationModel = await resolveAgentAssistAnalysisModel\(assistConfig\)/);
  assert.match(router, /translateText\(\{[\s\S]*model:\s*translationModel/);
  assert.doesNotMatch(router, /detectLanguage|Google Translate/);
  assert.match(webhookHandler, /detectLanguage/);
  assert.doesNotMatch(webhookHandler, /Google Translate/);
  assert.match(router, /const callerLanguage = normalizeLanguageCode\(interaction\.metadata\?\.caller_language, \{ fallback: null \}\)/);
});

test("final translation updates stay attached to the finalized transcript bubble", () => {
  const router = read("lib/agent-assist-transcription-router.mjs");

  assert.match(router, /const transcriptionKey = getTranscriptionMessageKey\(callControlId, track, isMessageFinal\)/);
  assert.match(router, /processFinalTranscriptionEnhancements\(\{[\s\S]*transcriptionKey/);
  assert.match(router, /type:\s*["']transcription_update["']/);
  assert.match(router, /updates\.translation\s*=/);
});

test("Azure and Microsoft streaming services are removed from runtime and node configuration", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "lib/azure-speech-handler.mjs")), false);

  const streamingWs = read("lib/streaming-ws-handler.mjs");
  const voiceFlowEngine = read("lib/voice-flow-engine.js");
  const providerConfig = read("config/ai-streaming-providers.js");
  const answerEditor = read("components/voice-flow/AnswerNodeEditor.jsx");
  const streamingEditor = read("components/voice-flow/StreamingStartNodeEditor.jsx");
  const nodesConfig = read("config/voice-flow-nodes.js");
  const webhookHandler = read("lib/contact-center/webhook-handler.js");
  const pkg = read("package.json");

  for (const [name, source] of Object.entries({
    streamingWs,
    voiceFlowEngine,
    providerConfig,
    answerEditor,
    streamingEditor,
    nodesConfig,
    webhookHandler,
    pkg,
  })) {
    assert.doesNotMatch(source, /azure-transcription|\/streaming\/azure|startAzureTranscription|stopAzureTranscription|AZURE_SERVICE|AZURE_SPEECH|@azure|Microsoft|Azure/, `${name} still references Azure/Microsoft streaming services`);
  }
});

test("profile exposes user language selector and saves users.language", () => {
  const profile = read("app/(portal)/profile/page.jsx");
  const userActions = read("app/actions/user.js");

  assert.match(profile, /from\s+["']@\/lib\/languages["']/);
  assert.match(profile, /<Label htmlFor="language">Language<\/Label>/);
  assert.match(profile, /<Select[\s\S]*value=\{form\.language/);
  assert.match(profile, /fd\.set\("language",\s*form\.language/);
  assert.match(profile, /languageOptions\.map/);
  assert.match(userActions, /language:\s*user\.language \|\| "en-US"/);
  assert.match(userActions, /if \(formData\.has\("language"\)\)/);
});
