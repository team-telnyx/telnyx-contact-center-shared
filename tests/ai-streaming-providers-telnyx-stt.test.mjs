import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function providerSource() {
  return readFile(new URL("../config/ai-streaming-providers.js", import.meta.url), "utf8");
}

function extractProviderBlock(source, providerId) {
  const start = source.indexOf(`  "${providerId}": {`);
  assert.ok(start >= 0, `${providerId} should be configured`);

  const next = source.indexOf("\n  \"", start + 1);
  const end = next >= 0 ? next : source.indexOf("\n};", start);
  assert.ok(end > start, `${providerId} block should be parseable`);
  return source.slice(start, end);
}

function assertTelnyxSttPreset(source, providerId, engine, model, language) {
  const block = extractProviderBlock(source, providerId);
  assert.match(block, /type: "telnyx-stt"/);
  assert.match(block, /stream_track: "inbound_track"/);
  assert.match(block, /stream_codec: "L16"/);
  assert.match(block, /stream_bidirectional_mode: "rtp"/);
  assert.match(block, /stream_bidirectional_codec: "L16"/);
  assert.match(block, /stream_bidirectional_sampling_rate: 16000/);
  assert.match(block, /transcription_tracks: "both"/);
  assert.match(block, new RegExp(`transcription_engine: "${engine}"`));
  assert.match(block, new RegExp(`model: "${model.replace("/", "\\/")}"`));
  assert.match(block, new RegExp(`language: "${language}"`));
  assert.match(block, /input_format: "linear16"/);
  assert.match(block, /sample_rate: 16000/);
  assert.match(block, /interim_results: true/);
}

test("Telnyx STT WebSocket presets include Deepgram Nova 2, Nova 3, and Flux", async () => {
  const source = await providerSource();

  assertTelnyxSttPreset(
    source,
    "telnyx-stt-deepgram-nova-2",
    "Deepgram",
    "deepgram/nova-2",
    "en",
  );
  assertTelnyxSttPreset(
    source,
    "telnyx-stt-deepgram-nova-3",
    "Deepgram",
    "deepgram/nova-3",
    "en",
  );
  assertTelnyxSttPreset(
    source,
    "telnyx-stt-deepgram-flux",
    "Deepgram",
    "deepgram/flux",
    "auto",
  );
});

test("StreamingStartNodeEditor exposes one Telnyx STT provider and derives model options from provider config", async () => {
  const source = await readFile(
    new URL("../components/voice-flow/StreamingStartNodeEditor.jsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /TELNYX_STT_PROVIDER_OPTION\s*=\s*\{ value: "telnyx-stt", label: "Telnyx Standalone STT" \}/);
  assert.match(source, /TELNYX_STT_MODEL_OPTIONS[\s\S]*provider\.type === "telnyx-stt"/);
  assert.match(source, /const modelLabel = model/);
  assert.doesNotMatch(source, /\.\.\.TELNYX_STT_PROVIDER_OPTIONS/);
});

test("Telnyx STT runtime overwrites stale bidirectional audio fields before Call Control", async () => {
  const source = await readFile(
    new URL("../lib/voice-flow-engine.js", import.meta.url),
    "utf8",
  );
  const sttBranchStart = source.indexOf('fullProviderConfig?.type === "telnyx-stt"');
  assert.ok(sttBranchStart >= 0, "voice-flow-engine should have a Telnyx STT branch");
  const sttBranchEnd = source.indexOf("  } else {", sttBranchStart);
  assert.ok(sttBranchEnd > sttBranchStart, "Telnyx STT branch should be parseable");
  const sttBranch = source.slice(sttBranchStart, sttBranchEnd);

  assert.match(sttBranch, /Object\.assign\(body, providerConfig\)/);
  assert.match(sttBranch, /stream_bidirectional_mode=rtp/);
  assert.match(sttBranch, /stream_bidirectional_codec=L16/);
  assert.match(sttBranch, /stream_bidirectional_sampling_rate=16000/);
  assert.doesNotMatch(sttBranch, /delete body\.stream_bidirectional_mode/);
  assert.doesNotMatch(sttBranch, /delete body\.stream_bidirectional_codec/);
  assert.doesNotMatch(sttBranch, /delete body\.stream_bidirectional_sampling_rate/);
});
