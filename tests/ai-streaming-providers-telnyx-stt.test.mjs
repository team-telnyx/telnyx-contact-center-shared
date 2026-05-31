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
  assert.match(block, /stream_track: "both_tracks"/);
  assert.match(block, /stream_codec: "PCMU"/);
  assert.match(block, new RegExp(`transcription_engine: "${engine}"`));
  assert.match(block, new RegExp(`model: "${model.replace("/", "\\/")}"`));
  assert.match(block, new RegExp(`language: "${language}"`));
  assert.match(block, /input_format: "mulaw"/);
  assert.match(block, /sample_rate: 8000/);
  assert.match(block, /interim_results: true/);
}

test("Telnyx STT WebSocket presets include Deepgram Nova 2 and Nova 3", async () => {
  const source = await providerSource();

  assertTelnyxSttPreset(
    source,
    "telnyx-stt-deepgram-nova-2",
    "Deepgram",
    "deepgram/nova-2",
    "en-US",
  );
  assertTelnyxSttPreset(
    source,
    "telnyx-stt-deepgram-nova-3",
    "Deepgram",
    "deepgram/nova-3",
    "en-US",
  );
});

test("StreamingStartNodeEditor derives Telnyx STT options from provider config", async () => {
  const source = await readFile(
    new URL("../components/voice-flow/StreamingStartNodeEditor.jsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /Object\.values\(AI_STREAMING_PROVIDERS\)[\s\S]*provider\.type === "telnyx-stt"/);
  assert.match(source, /\.map\(\(provider\) => \(\{ value: provider\.id, label: provider\.label \}\)\)/);
  assert.doesNotMatch(source, /telnyx-stt-deepgram-nova-[23]/);
});
