import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { convertTelnyxL16PayloadForLinear16 } from "../lib/telnyx-stt-handler.mjs";

const providerSource = await readFile(new URL("../config/ai-streaming-providers.js", import.meta.url), "utf8");
const handlerSource = await readFile(new URL("../lib/telnyx-stt-handler.mjs", import.meta.url), "utf8");
const engineSource = await readFile(new URL("../lib/voice-flow-engine.js", import.meta.url), "utf8");

const STANDALONE_STT_PROVIDER_IDS = [
  "telnyx-stt-google-phone-call",
  "telnyx-stt-google-latest-long",
  "telnyx-stt-google-default",
  "telnyx-stt-xai-grok",
  "telnyx-stt-deepgram-nova-2",
  "telnyx-stt-deepgram-nova-3",
  "telnyx-stt-deepgram-flux",
  "telnyx-stt-speechmatics-standard",
];

function providerBlock(providerId) {
  const escapedProviderId = providerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = providerSource.match(new RegExp(`"${escapedProviderId}": \\{[\\s\\S]*?\\n  \\},(?=\\n\\n  "|\\n};)`));
  assert.ok(match, `Expected to find provider block for ${providerId}`);
  return match[0];
}

test("Telnyx standalone STT provider presets request Telnyx L16 media streams", () => {
  for (const providerId of STANDALONE_STT_PROVIDER_IDS) {
    const block = providerBlock(providerId);
    assert.match(block, /telnyx:\s*\{[\s\S]*stream_codec:\s*"L16"/, `${providerId} should request stream_codec=L16`);
    assert.match(block, /telnyx:\s*\{[\s\S]*stream_bidirectional_mode:\s*"rtp"/, `${providerId} should force RTP bidirectional streaming mode`);
    assert.match(block, /telnyx:\s*\{[\s\S]*stream_bidirectional_codec:\s*"L16"/, `${providerId} should force L16 RTP payloads`);
    assert.match(block, /telnyx:\s*\{[\s\S]*stream_bidirectional_sampling_rate:\s*16000/, `${providerId} should force 16 kHz RTP payloads`);
    assert.match(block, /telnyxStt:\s*\{[\s\S]*input_format:\s*"linear16"/, `${providerId} should connect STT WS with input_format=linear16`);
    assert.match(block, /telnyxStt:\s*\{[\s\S]*sample_rate:\s*16000/, `${providerId} should connect STT WS with sample_rate=16000`);
  }
});

test("Agent-leg Telnyx standalone STT prewarm also requests RTP L16 media", () => {
  assert.match(
    handlerSource,
    /const body = \{[\s\S]*stream_track:\s*"inbound_track",[\s\S]*stream_codec:\s*"L16",[\s\S]*stream_bidirectional_mode:\s*"rtp",[\s\S]*stream_bidirectional_codec:\s*"L16",[\s\S]*stream_bidirectional_sampling_rate:\s*16000,[\s\S]*client_state:/,
  );
});

test("Standalone STT streaming comments describe the RTP L16 linear16 contract", () => {
  assert.match(engineSource, /stream_codec=L16/);
  assert.match(engineSource, /stream_bidirectional_mode=rtp/);
  assert.match(engineSource, /stream_bidirectional_codec=L16/);
  assert.match(engineSource, /stream_bidirectional_sampling_rate=16000/);
  assert.match(engineSource, /input_format=linear16/);
  assert.doesNotMatch(engineSource, /delete body\.stream_bidirectional_mode/);
});

test("Answer requests strip StartStreaming-only sampling rate after provider presets apply", () => {
  assert.match(
    engineSource,
    /case "answer":[\s\S]*body = await applyStreamingProviderConfiguration\(body, action\);[\s\S]*delete body\.stream_bidirectional_sampling_rate;[\s\S]*body = cleanupStreamingProviderFields\(body\);/,
  );
});

test("Telnyx RTP L16 payloads are byte-swapped before linear16 STT forwarding", () => {
  const telnyxRtpL16Payload = Buffer.from([0x12, 0x34, 0xab, 0xcd, 0xef]);
  const linear16Payload = convertTelnyxL16PayloadForLinear16(telnyxRtpL16Payload);

  assert.deepEqual([...linear16Payload], [0x34, 0x12, 0xcd, 0xab, 0xef]);
  assert.deepEqual([...telnyxRtpL16Payload], [0x12, 0x34, 0xab, 0xcd, 0xef]);
});
