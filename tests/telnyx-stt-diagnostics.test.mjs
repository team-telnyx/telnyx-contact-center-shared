import assert from "node:assert/strict";
import test from "node:test";

import { __telnyxSttTestUtils } from "../lib/telnyx-stt-handler.mjs";

test("Telnyx STT diagnostics redact secret-like fields and media payloads", () => {
  const summary = __telnyxSttTestUtils.summarizeProviderFrame({
    type: "Results",
    authorization: "Bearer verylongsecretvaluethatshouldnotbeprinted",
    api_key: "KEY_secret_value_that_should_not_leak",
    audio: "base64audio",
    payload: "base64payload",
    channel: {
      alternatives: [
        { transcript: "hello world", confidence: 0.91 },
      ],
    },
  });

  assert.match(summary.raw.authorization, /^\[redacted:/);
  assert.match(summary.raw.api_key, /^\[redacted:/);
  assert.match(summary.raw.audio, /^\[redacted:/);
  assert.match(summary.raw.payload, /^\[redacted:/);
  assert.equal(summary.channel.alternatives[0].transcript, "hello world");
});

test("Telnyx STT diagnostics summarize non-standard provider frames", () => {
  const summary = __telnyxSttTestUtils.summarizeProviderFrame({
    message_type: "Metadata",
    request_id: "req_123",
    duration: 3.2,
    channels: 1,
  });

  assert.equal(summary.type, "Metadata");
  assert.deepEqual(summary.keys, ["message_type", "request_id", "duration", "channels"]);
  assert.equal(summary.metadata, "req_123");
});

test("Telnyx STT transcript normalizer still recognizes Deepgram Results frames", () => {
  const normalized = __telnyxSttTestUtils.normalizeTranscriptFrame({
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: {
      alternatives: [
        { transcript: "  test transcript  ", confidence: 0.88 },
      ],
    },
  });

  assert.deepEqual(normalized, {
    transcript: "test transcript",
    isFinal: true,
    speechFinal: true,
    confidence: 0.88,
    rawType: "Results",
  });
});

test("Telnyx STT diagnostics are controlled by runtime topic config, not DEBUG_TELNYX_STT", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../lib/telnyx-stt-handler.mjs", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /envFlagEnabled\("DEBUG_TELNYX_STT"\)/);
  assert.match(source, /function logSttInfo\(message, payload = \{\}\) \{\s*sttLogger\.info\(message, payload\);\s*\}/);
  assert.match(source, /function logSttError\(message, payload = \{\}\) \{\s*sttLogger\.error\(message, payload\);\s*\}/);
});

test("Telnyx STT log identifiers stay full-length for debugging", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../lib/telnyx-stt-handler.mjs", import.meta.url), "utf8"));
  const fullCallControlId = "v3:d7P9yKkdbpNUnshortenedCallControlIdentifierhBveTeRA";
  const fullInteractionId = "7875d47c-31c4-4bbb-8ac1-2e9a22f9e0a1";

  assert.equal(__telnyxSttTestUtils.logIdentifier(fullCallControlId), fullCallControlId);
  assert.equal(__telnyxSttTestUtils.logIdentifier(fullInteractionId), fullInteractionId);
  assert.doesNotMatch(source, /function shortId\(/);
  assert.doesNotMatch(source, /slice\(0, 4\).*slice\(-8\)/);
  assert.doesNotMatch(source, /callControlId:\s*shortId\(/);
  assert.doesNotMatch(source, /interactionId:\s*shortId\(/);
});

test("Telnyx STT transcript logs include the transcript text", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../lib/telnyx-stt-handler.mjs", import.meta.url), "utf8"));
  assert.match(source, /logSttInfo\("provider_socket_transcript", \{[\s\S]*transcript:\s*normalized\.transcript,[\s\S]*transcriptLength:\s*normalized\.transcript\.length/);
});

test("Telnyx STT logger messages use technical snake_case event names", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../lib/telnyx-stt-handler.mjs", import.meta.url), "utf8"));
  assert.match(source, /logSttInfo\("started_telnyx_standalone_stt_sessions",/);
  assert.match(source, /logSttInfo\("starting_telnyx_stt_media_stream",/);
  assert.match(source, /logSttError\("telnyx_stt_media_streaming_start_failed",/);
  assert.doesNotMatch(source, /logStt(?:Info|Warn|Error|Debug)\("[A-Z][^"]*"/);
});
