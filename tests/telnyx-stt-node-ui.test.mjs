import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

function assertTelnyxSttUi(editorSource, editorName) {
  assert.match(
    editorSource,
    /TELNYX_STT_PROVIDER_OPTION\s*=\s*\{\s*value:\s*"telnyx-stt",\s*label:\s*"Telnyx Standalone STT"\s*\}/,
    `${editorName} should expose one top-level Telnyx Standalone STT provider option`,
  );
  assert.match(
    editorSource,
    /TELNYX_STT_MODEL_OPTIONS[\s\S]*const modelLabel = `\$\{engine\}\/\$\{model\}`/,
    `${editorName} should derive model labels like google/phone_call and deepgram/nova-2`,
  );
  assert.match(
    editorSource,
    /<Label>Model<\/Label>[\s\S]*TELNYX_STT_MODEL_OPTIONS\.map/,
    `${editorName} should render a separate Telnyx STT model selector`,
  );
  assert.match(
    editorSource,
    /telnyx_stt_interim_results[\s\S]*<Switch[\s\S]*checked=\{(?:config\.telnyx_stt_interim_results !== false|telnyxSttInterimResults)\}/,
    `${editorName} should expose an interim results toggle that defaults on`,
  );
  for (const field of [
    "telnyx_stt_endpointing",
    "telnyx_stt_eot_threshold",
    "telnyx_stt_eager_eot_threshold",
    "telnyx_stt_eot_timeout_ms",
  ]) {
    assert.match(
      editorSource,
      new RegExp(field),
      `${editorName} should expose Deepgram ${field} configuration`,
    );
  }
  assert.match(
    editorSource,
    /Deepgram End-of-Turn Detection/,
    `${editorName} should group Deepgram end-of-turn settings`,
  );
}

test("Streaming Start UI has provider/model split and interim results toggle for Telnyx STT", async () => {
  assertTelnyxSttUi(
    await source("../components/voice-flow/StreamingStartNodeEditor.jsx"),
    "StreamingStartNodeEditor",
  );
});

test("Answer UI has the same Telnyx STT streaming implementation as Streaming Start", async () => {
  const answerSource = await source("../components/voice-flow/AnswerNodeEditor.jsx");
  assertTelnyxSttUi(answerSource, "AnswerNodeEditor");
  assert.match(answerSource, /ai_streaming_provider:\s*streamUrl \? streamingProvider : undefined/);
  assert.match(answerSource, /stream_url:\s*streamUrl \|\| undefined/);
  assert.match(answerSource, /<Label>Bidirectional Stream Mode<\/Label>/);
  assert.match(answerSource, /<Label>Bidirectional RTP Codec<\/Label>/);
  assert.match(answerSource, /<Label>Bidirectional RTP Sampling Rate<\/Label>/);
  assert.match(answerSource, /<Label>Bidirectional Stream Target Legs<\/Label>/);
  assert.match(answerSource, /<Label>Establish Before Call Originate<\/Label>/);
});

test("Answer streaming provider selector matches Streaming Start providers", async () => {
  const answerSource = await source("../components/voice-flow/AnswerNodeEditor.jsx");
  const pageSource = await source("../app/(portal)/admin/call-flows/[id]/page.jsx");
  for (const [value, label] of [
    ["custom", "Custom"],
    ["google-gemini", "Google Gemini Live"],
    ["openai-realtime", "OpenAI Realtime"],
    ["azure-transcription", "Azure Transcription + Translation"],
    ["telnyx-stt", "Telnyx Standalone STT"],
  ]) {
    assert.ok(
      answerSource.includes(`value: "${value}", label: "${label}"`) ||
        (value === "telnyx-stt" &&
          answerSource.includes('value: "telnyx-stt", label: "Telnyx Standalone STT"')),
      `Answer node should include ${label} in streaming provider options`,
    );
  }
  assert.match(
    answerSource,
    /config\.ai_streaming_provider \|\| "custom"/,
    "Answer node should preserve existing non-Telnyx streaming providers from config",
  );
  assert.match(
    answerSource,
    /getStreamingProviderPath\(value\)/,
    "Answer node should auto-configure stream URLs for Google, OpenAI, and Azure providers",
  );
  assert.match(answerSource, /EXPERIMENTAL_PROVIDERS = \["azure-transcription"\]/);
  assert.match(answerSource, /!EXPERIMENTAL_PROVIDERS\.includes\(option\.value\) \|\|[\s\S]*isExperimentalUser/);
  assert.match(pageSource, /<AnswerNodeEditor[\s\S]*currentUserEmail=\{userEmail\}/);
});

test("voice-flow engine resolves virtual Telnyx STT provider model for answer and streaming_start", async () => {
  const engineSource = await source("../lib/voice-flow-engine.js");
  assert.match(engineSource, /resolveStreamingProviderConfig\(body\)/);
  assert.match(engineSource, /body\.ai_streaming_provider === "telnyx-stt"[\s\S]*body\.telnyx_stt_model/);
  assert.match(engineSource, /case "answer":[\s\S]*applyStreamingProviderConfiguration\([\s\S]*action[\s\S]*\)[\s\S]*break;/);
  assert.match(engineSource, /case "streaming_start":[\s\S]*applyStreamingProviderConfiguration\([\s\S]*action[\s\S]*\)[\s\S]*break;/);
  assert.match(engineSource, /interim_results:\s*body\.telnyx_stt_interim_results !== false/);
  assert.match(engineSource, /endpointing:\s*body\.telnyx_stt_endpointing \|\| undefined/);
  assert.match(engineSource, /eot_threshold:\s*body\.telnyx_stt_eot_threshold \|\| undefined/);
  assert.match(engineSource, /eager_eot_threshold:\s*body\.telnyx_stt_eager_eot_threshold \|\| undefined/);
  assert.match(engineSource, /eot_timeout_ms:\s*body\.telnyx_stt_eot_timeout_ms \|\| undefined/);
  assert.match(engineSource, /delete body\.telnyx_stt_endpointing/);
  assert.match(engineSource, /delete body\.telnyx_stt_eot_threshold/);
  assert.match(engineSource, /delete body\.telnyx_stt_eager_eot_threshold/);
  assert.match(engineSource, /delete body\.telnyx_stt_eot_timeout_ms/);
  assert.match(engineSource, /delete body\.telnyx_stt_interim_results/);
  assert.match(engineSource, /delete body\.telnyx_stt_model/);
});

test("streaming capabilities endpoint exposes the same WS_BASE_URL used by runtime commands", async () => {
  const capabilitiesSource = await source("../app/api/voice/streaming/capabilities/route.js");
  const engineSource = await source("../lib/voice-flow-engine.js");

  assert.match(engineSource, /process\.env\.WS_BASE_URL \|\| process\.env\.STREAMING_WS_URL/);
  assert.match(
    capabilitiesSource,
    /process\.env\.WS_BASE_URL \|\| process\.env\.STREAMING_WS_URL/,
    "UI capabilities endpoint should prefer WS_BASE_URL before falling back to STREAMING_WS_URL",
  );
  assert.match(capabilitiesSource, /wsUrl:\s*configuredWsUrl/);
});

test("Telnyx STT websocket handler forwards Deepgram EOT query parameters", async () => {
  const handlerSource = await source("../lib/telnyx-stt-handler.mjs");
  for (const param of ["endpointing", "eot_threshold", "eager_eot_threshold", "eot_timeout_ms"]) {
    assert.match(
      handlerSource,
      new RegExp(`params\\.set\\("${param}"`),
      `STT handler should add ${param} to the provider websocket URL`,
    );
  }
});

test("workflow edit dialog exposes persisted STT confidence threshold under LLM model", async () => {
  const workflowSource = await source("../app/(portal)/admin/workflows/[id]/page.jsx");
  assert.match(workflowSource, /stt_confidence_threshold:\s*"0\.95"/);
  assert.match(workflowSource, /data\.workflow\.stt_confidence_threshold \?\? 0\.95/);
  assert.match(
    workflowSource,
    /<Label htmlFor="edit-llm-model">LLM Model<\/Label>[\s\S]*<Label htmlFor="edit-stt-confidence-threshold">[\s\S]*STT Confidence Threshold/,
    "threshold field should render directly after LLM model in the edit dialog",
  );
  assert.match(workflowSource, /min="0"[\s\S]*max="1"[\s\S]*step="0\.01"/);
});
