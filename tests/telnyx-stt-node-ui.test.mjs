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
});

test("voice-flow engine resolves virtual Telnyx STT provider model for answer and streaming_start", async () => {
  const engineSource = await source("../lib/voice-flow-engine.js");
  assert.match(engineSource, /resolveStreamingProviderConfig\(body\)/);
  assert.match(engineSource, /body\.ai_streaming_provider === "telnyx-stt"[\s\S]*body\.telnyx_stt_model/);
  assert.match(engineSource, /case "answer":[\s\S]*applyStreamingProviderConfiguration\([\s\S]*action[\s\S]*\)[\s\S]*break;/);
  assert.match(engineSource, /case "streaming_start":[\s\S]*applyStreamingProviderConfiguration\([\s\S]*action[\s\S]*\)[\s\S]*break;/);
  assert.match(engineSource, /interim_results:\s*body\.telnyx_stt_interim_results !== false/);
  assert.match(engineSource, /delete body\.telnyx_stt_interim_results/);
  assert.match(engineSource, /delete body\.telnyx_stt_model/);
});
