import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  helper: "lib/voice/logging.mjs",
  incomingWebhook: "app/api/voice/webhook/incoming/[flowId]/route.js",
  flowEngine: "lib/voice-flow-engine.js",
  streamingHandler: "app/api/voice/streaming/ws-handler.js",
  callAction: "app/api/voice/call-action/route.js",
  callState: "app/api/voice/calls/[callControlId]/state/route.js",
  recordingTranscribe: "app/api/voice/recordings/[id]/transcribe/route.js",
  telnyxProvider: "lib/telnyx.js",
};

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const forbiddenLegacyDiagnostics = /console\.(log|warn|error|info|debug)|[`"]\[[A-Za-z0-9][^`"]*\]|_legacy_/;
const forbiddenRawPayloadKeys = /\b(rawPayload|webhookPayload|eventPayload|fullPayload|requestBody|bodyText|providerResponse|llmResponse)\b/;

test("Voice/Telnyx logging helper exposes canonical topic loggers", async () => {
  const helper = await source(files.helper);

  for (const [name, topic] of [
    ["voiceWebhookLogger", "voice.webhooks"],
    ["voiceFlowLogger", "voice.flow"],
    ["callControlLogger", "voice.call-control"],
    ["recordingsLogger", "voice.recordings"],
    ["streamingLogger", "telnyx.streaming"],
    ["sttLogger", "telnyx.stt"],
    ["mediaLogger", "telnyx.media"],
    ["providerApiLogger", "telnyx.provider-api"],
  ]) {
    assert.match(helper, new RegExp(`export const ${name} = createDiagnosticLogger\\("${topic.replace(/[.]/g, "\\.")}\\"\\);`));
  }

  assert.match(helper, /export function voiceErrorPayload/);
  assert.match(helper, /export function voiceRuntimePayload/);
});

test("Voice Flow and Telnyx core runtime files use structured topic loggers", async () => {
  const expectations = [
    [files.incomingWebhook, /voiceWebhookLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.flowEngine, /voiceFlowLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.streamingHandler, /(streamingLogger|mediaLogger)\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.callAction, /callControlLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.callState, /callControlLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.recordingTranscribe, /recordingsLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
    [files.telnyxProvider, /providerApiLogger\.(debug|info|warn|error)\("[a-z0-9_]+"/],
  ];

  for (const [path, loggerPattern] of expectations) {
    const content = await source(path);
    assert.match(content, /voice\/logging\.mjs/, `${path} must import Voice/Telnyx logging helper`);
    assert.match(content, loggerPattern, `${path} must emit canonical structured logger events`);
    assert.doesNotMatch(content, forbiddenLegacyDiagnostics, `${path} still contains legacy console/bracket diagnostics`);
  }
});

test("Voice/Telnyx core logs keep compact correlation fields and avoid raw payload dumps", async () => {
  for (const path of Object.values(files)) {
    const content = await source(path);
    assert.doesNotMatch(content, forbiddenRawPayloadKeys, `${path} must not log raw provider/webhook payload fields`);
  }

  const combined = await Promise.all(Object.values(files).map(source)).then((parts) => parts.join("\n"));
  for (const field of ["eventType", "callControlId", "callSessionId", "flowId", "nodeId", "reason", "provider"]) {
    assert.match(combined, new RegExp(`\\b${field}\\b`), `expected safe field ${field} in Voice/Telnyx logging slice`);
  }
});
