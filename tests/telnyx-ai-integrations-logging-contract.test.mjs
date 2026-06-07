import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  helper: "lib/telnyx-ai-logging.mjs",
  insights: "lib/telnyx-insights.js",
  voiceApps: "lib/telnyx-voice-apps.js",
  insightsWebhook: "app/api/webhooks/telnyx/conversation-insights/route.js",
};

async function source(file) {
  return readFile(file, "utf8");
}

const runtimeFiles = [files.insights, files.voiceApps, files.insightsWebhook];
const legacyDiagnostics = /console\.(log|warn|error|info|debug)|const LOG_PREFIX\s*=|[`"]\[[A-Za-z0-9][^`"]*\]/;

function loggerCalls(src) {
  const calls = [];
  const regex = /(?:providerApiLogger|telnyxWebhookLogger|telnyxVoiceAppsLogger)\.(?:debug|info|warn|error)\(([^;]+)\);/gs;
  let match;
  while ((match = regex.exec(src))) calls.push(match[1]);
  return calls;
}

test("Telnyx AI integration logging helper exposes approved topic loggers", async () => {
  const helper = await source(files.helper);
  for (const topic of ["telnyx.provider-api", "telnyx.webhooks"]) {
    assert.match(helper, new RegExp(`createDiagnosticLogger\\(\\s*["']${topic}["']\\s*\\)`));
  }
  for (const exportName of [
    "providerApiLogger",
    "telnyxWebhookLogger",
    "telnyxVoiceAppsLogger",
    "telnyxErrorPayload",
    "telnyxResourcePayload",
    "telnyxRequestPayload",
  ]) {
    assert.match(helper, new RegExp(`export (?:function|const) ${exportName}\\b`));
  }
});

test("Telnyx AI integration runtime files use structured topic loggers", async () => {
  for (const file of runtimeFiles) {
    const src = await source(file);
    assert.doesNotMatch(src, legacyDiagnostics, `${file} should not use console or bracket-prefix diagnostics`);
    assert.match(src, /telnyx-ai-logging\.mjs/, `${file} should import the Telnyx AI logging helper`);
    assert.match(src, /(?:providerApiLogger|telnyxWebhookLogger|telnyxVoiceAppsLogger)\.(?:debug|info|warn|error)\(/, `${file} should emit structured logs`);
  }
});

test("Telnyx AI integration logger calls avoid raw provider payloads and secrets", async () => {
  const forbidden = /\b(apiKey|authorization|headers|rawPayload|responseText|responseBody|payload|updates|body)\b/i;
  for (const file of runtimeFiles) {
    const src = await source(file);
    const calls = loggerCalls(src);
    assert.ok(calls.length > 0, `${file} should have logger calls`);
    for (const call of calls) {
      assert.doesNotMatch(call, forbidden, `${file} logger call should not include raw payloads/secrets: ${call}`);
    }
  }
});
