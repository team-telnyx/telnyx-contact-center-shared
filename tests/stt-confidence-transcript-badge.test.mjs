import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routerSource = readFileSync("lib/agent-assist-transcription-router.mjs", "utf8");
const streamProviderSource = readFileSync(
  "components/contact-center/ContactCenterStreamProvider.jsx",
  "utf8"
);
const historySource = readFileSync(
  "components/contact-center/TranscriptionHistory.jsx",
  "utf8"
);
const webhookHandlerSource = readFileSync(
  "lib/contact-center/webhook-handler.js",
  "utf8"
);
const workflowSource = readFileSync(
  "components/contact-center/AgentAssistWorkflow.jsx",
  "utf8"
);

test("Agent Assist transcription SSE preserves Telnyx STT confidence metadata", () => {
  assert.match(routerSource, /confidence: transcriptionData\.confidence/);
  assert.match(routerSource, /source: transcriptionData\.source/);
  assert.match(routerSource, /provider: transcriptionData\.provider/);
  assert.match(routerSource, /model: transcriptionData\.model/);
});

test("Voice API transcription webhooks preserve Telnyx STT confidence metadata", () => {
  assert.match(webhookHandlerSource, /confidence: transcriptionData\.confidence/);
  assert.match(webhookHandlerSource, /source: transcriptionData\.source/);
  assert.match(webhookHandlerSource, /provider: transcriptionData\.provider/);
  assert.match(webhookHandlerSource, /model: transcriptionData\.model/);
  assert.match(webhookHandlerSource, /transcriptionData\.language_code/);
});

test("ContactCenterStreamProvider passes transcript confidence into active-call store", () => {
  assert.match(streamProviderSource, /confidence: data\.transcription\.confidence/);
  assert.match(streamProviderSource, /source: data\.transcription\.source/);
  assert.match(streamProviderSource, /provider: data\.transcription\.provider/);
  assert.match(streamProviderSource, /model: data\.transcription\.model/);
});

test("workflow live transcription bubbles render compact STT percentage badge", () => {
  assert.match(workflowSource, /function formatSttConfidencePercent/);
  assert.match(workflowSource, /const sttConfidencePercent = formatSttConfidencePercent\(transcription\.confidence\)/);
  assert.match(workflowSource, /Intent, sentiment, and STT confidence badges/);
  assert.match(workflowSource, /STT \{sttConfidencePercent\}%/);
  assert.doesNotMatch(workflowSource, /STT Confidence \{sttConfidencePercent\}%/);
  assert.match(workflowSource, /Speech-to-text recognition confidence from Telnyx Standalone STT/);
  assert.match(workflowSource, /confidence: t\.confidence/);
});

test("agent assist workflow config can hide STT confidence presentation without dropping confidence data", () => {
  assert.match(workflowSource, /showSttConfidence=\{showSttConfidence\}/);
  assert.match(workflowSource, /showSttConfidence = true/);
  assert.match(workflowSource, /showSttConfidence && sttConfidencePercent !== null/);
  assert.match(workflowSource, /confidence: t\.confidence/);
});

test("historical transcription bubbles still render compact STT percentage badge", () => {
  assert.match(historySource, /function formatSttConfidencePercent/);
  assert.match(historySource, /STT \{sttConfidencePercent\}%/);
  assert.doesNotMatch(historySource, /STT Confidence \{sttConfidencePercent\}%/);
  assert.match(historySource, /Speech-to-text recognition confidence from Telnyx Standalone STT/);
});
