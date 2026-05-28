import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadTranscriptionHelpers() {
  const source = await readFile(
    new URL("../lib/voice-flow-engine.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const TRANSCRIPTION_MODEL_DEFAULTS");
  const end = source.indexOf("/**\n * Clean up empty string values", start);
  assert.ok(start > -1, "transcription helpers should exist");
  assert.ok(end > start, "transcription helper block should be bounded");

  const helperSource = source
    .slice(start, end)
    .replace(
      "export function transformTranscriptionOptions",
      "function transformTranscriptionOptions",
    );

  return vm.runInNewContext(
    `${helperSource}; ({ transformTranscriptionOptions, normalizeTranscriptionStartConfig });`,
  );
}

test("answer transcription keeps nested Deepgram model and language", async () => {
  const { transformTranscriptionOptions } = await loadTranscriptionHelpers();

  const body = transformTranscriptionOptions({
    transcription_engine: "Deepgram",
    transcription_tracks: "both",
    transcription_engine_config: {
      transcription_engine: "Deepgram",
      transcription_model: "deepgram/nova-3",
      language: "en",
    },
  });

  assert.equal(body.transcription, true);
  assert.deepEqual(plain(body.transcription_config), {
    transcription_engine: "Deepgram",
    transcription_engine_config: {
      transcription_engine: "Deepgram",
      transcription_model: "deepgram/nova-3",
      language: "en",
    },
    transcription_tracks: "both",
  });
  assert.equal("transcription_model" in body, false);
  assert.equal("language" in body, false);
});

test("answer transcription strips Azure model fields and preserves Voice API language", async () => {
  const { transformTranscriptionOptions } = await loadTranscriptionHelpers();

  const body = transformTranscriptionOptions({
    transcription_engine: "Azure",
    transcription_tracks: "both",
    transcription_model: "azure/fast",
    transcription_engine_config: {
      transcription_engine: "Azure",
      transcription_model: "azure/fast",
      region: "westus2",
      language: "en",
    },
  });

  assert.deepEqual(plain(body.transcription_config), {
    transcription_engine: "Azure",
    transcription_engine_config: {
      transcription_engine: "Azure",
      region: "westus2",
      language: "en",
    },
    transcription_tracks: "both",
  });
  assert.equal("transcription_model" in body, false);
});

test("answer transcription drops invalid Azure locale values", async () => {
  const { transformTranscriptionOptions } = await loadTranscriptionHelpers();

  const body = transformTranscriptionOptions({
    transcription_engine: "Azure",
    transcription_tracks: "both",
    transcription_engine_config: {
      transcription_engine: "Azure",
      region: "eastus",
      language: "en-US",
    },
  });

  assert.deepEqual(plain(body.transcription_config), {
    transcription_engine: "Azure",
    transcription_engine_config: {
      transcription_engine: "Azure",
      region: "eastus",
    },
    transcription_tracks: "both",
  });
});

test("answer transcription replaces Deepgram Flux with a Voice API model", async () => {
  const { transformTranscriptionOptions } = await loadTranscriptionHelpers();

  const body = transformTranscriptionOptions({
    transcription_engine: "Deepgram",
    transcription_tracks: "both",
    transcription_engine_config: {
      transcription_engine: "Deepgram",
      transcription_model: "deepgram/flux",
      language: "multi",
    },
  });

  assert.deepEqual(plain(body.transcription_config), {
    transcription_engine: "Deepgram",
    transcription_engine_config: {
      transcription_engine: "Deepgram",
      transcription_model: "deepgram/nova-3",
    },
    transcription_tracks: "both",
  });
});

test("answer transcription keeps interim results for Deepgram Voice API models", async () => {
  const { transformTranscriptionOptions } = await loadTranscriptionHelpers();

  const body = transformTranscriptionOptions({
    transcription_engine: "Deepgram",
    transcription_engine_config: {
      transcription_engine: "Deepgram",
      transcription_model: "deepgram/nova-3",
      interim_results: true,
      language: "en",
    },
  });

  assert.deepEqual(plain(body.transcription_config), {
    transcription_engine: "Deepgram",
    transcription_engine_config: {
      transcription_engine: "Deepgram",
      transcription_model: "deepgram/nova-3",
      interim_results: true,
      language: "en",
    },
  });
});

test("answer transcription keeps Google transcription inline", async () => {
  const { transformTranscriptionOptions } = await loadTranscriptionHelpers();

  const body = transformTranscriptionOptions({
    client_state: "encoded-state",
    record: "record-from-answer",
    transcription_engine: "Google",
    transcription_tracks: "both",
    transcription_engine_config: {
      transcription_engine: "Google",
      model: "phone_call",
      interim_results: true,
      language: "en",
    },
  });

  assert.deepEqual(plain(body), {
    client_state: "encoded-state",
    record: "record-from-answer",
    transcription: true,
    transcription_config: {
      transcription_engine: "Google",
      transcription_engine_config: {
        transcription_engine: "Google",
        model: "phone_call",
        interim_results: true,
        language: "en",
      },
      transcription_tracks: "both",
    },
  });
});

test("answer keeps Azure transcription inline", async () => {
  const { transformTranscriptionOptions } = await loadTranscriptionHelpers();

  const body = transformTranscriptionOptions({
    transcription_engine: "Azure",
    transcription_tracks: "both",
    transcription_engine_config: {
      transcription_engine: "Azure",
      region: "eastus",
      language: "en",
    },
  });

  assert.deepEqual(plain(body), {
    transcription: true,
    transcription_config: {
      transcription_engine: "Azure",
      transcription_engine_config: {
        transcription_engine: "Azure",
        region: "eastus",
        language: "en",
      },
      transcription_tracks: "both",
    },
  });
});

test("answer transcription replaces unsupported Telnyx models", async () => {
  const { transformTranscriptionOptions } = await loadTranscriptionHelpers();

  const body = transformTranscriptionOptions({
    transcription_engine: "Telnyx",
    transcription_engine_config: {
      transcription_engine: "Telnyx",
      transcription_model: "distil-whisper/distil-large-v2",
      language: "auto",
    },
  });

  assert.deepEqual(plain(body.transcription_config), {
    transcription_engine: "Telnyx",
    transcription_engine_config: {
      transcription_engine: "Telnyx",
      transcription_model: "openai/whisper-tiny",
    },
  });
});

test("answer transcription omits language for AssemblyAI", async () => {
  const { transformTranscriptionOptions } = await loadTranscriptionHelpers();

  const body = transformTranscriptionOptions({
    transcription_engine: "AssemblyAI",
    transcription_engine_config: {
      transcription_engine: "AssemblyAI",
      transcription_model: "assemblyai/universal-streaming",
      language: "en",
    },
  });

  assert.deepEqual(plain(body.transcription_config), {
    transcription_engine: "AssemblyAI",
    transcription_engine_config: {
      transcription_engine: "AssemblyAI",
      transcription_model: "assemblyai/universal-streaming",
    },
  });
});

test("answer transcription fills minimal Google config", async () => {
  const { transformTranscriptionOptions } = await loadTranscriptionHelpers();

  const body = transformTranscriptionOptions({
    transcription_engine: "Google",
    transcription_tracks: "both",
  });

  assert.deepEqual(plain(body.transcription_config), {
    transcription_engine: "Google",
    transcription_engine_config: {
      transcription_engine: "Google",
      language: "en",
      model: "phone_call",
      interim_results: true,
    },
    transcription_tracks: "both",
  });
});

test("answer transcription fills minimal Deepgram config without forcing interim results", async () => {
  const { transformTranscriptionOptions } = await loadTranscriptionHelpers();

  const body = transformTranscriptionOptions({
    transcription_engine: "Deepgram",
    transcription_tracks: "both",
  });

  assert.deepEqual(plain(body.transcription_config), {
    transcription_engine: "Deepgram",
    transcription_engine_config: {
      transcription_engine: "Deepgram",
      transcription_model: "deepgram/nova-3",
      language: "en",
    },
    transcription_tracks: "both",
  });
});

test("start transcription fills minimal Google config", async () => {
  const { normalizeTranscriptionStartConfig } = await loadTranscriptionHelpers();

  const body = normalizeTranscriptionStartConfig({
    transcription_engine: "Google",
    transcription_tracks: "both",
  });

  assert.deepEqual(plain(body), {
    transcription_engine: "Google",
    transcription_tracks: "both",
    transcription_engine_config: {
      transcription_engine: "Google",
      language: "en",
      model: "phone_call",
      interim_results: true,
    },
  });
});

test("start transcription fills minimal Deepgram config without forcing interim results", async () => {
  const { normalizeTranscriptionStartConfig } = await loadTranscriptionHelpers();

  const body = normalizeTranscriptionStartConfig({
    transcription_engine: "Deepgram",
    transcription_tracks: "both",
  });

  assert.deepEqual(plain(body), {
    transcription_engine: "Deepgram",
    transcription_tracks: "both",
    transcription_engine_config: {
      transcription_engine: "Deepgram",
      transcription_model: "deepgram/nova-3",
      language: "en",
    },
  });
});

test("start transcription preserves explicit Deepgram interim results", async () => {
  const { normalizeTranscriptionStartConfig } = await loadTranscriptionHelpers();

  const body = normalizeTranscriptionStartConfig({
    transcription_engine: "Deepgram",
    transcription_tracks: "both",
    transcription_engine_config: {
      transcription_engine: "Deepgram",
      transcription_model: "deepgram/nova-3",
      language: "en",
      interim_results: false,
    },
  });

  assert.deepEqual(plain(body), {
    transcription_engine: "Deepgram",
    transcription_tracks: "both",
    transcription_engine_config: {
      transcription_engine: "Deepgram",
      transcription_model: "deepgram/nova-3",
      language: "en",
      interim_results: false,
    },
  });
});

test("start transcription normalizes legacy flat model fields", async () => {
  const { normalizeTranscriptionStartConfig } = await loadTranscriptionHelpers();

  const body = normalizeTranscriptionStartConfig({
    transcription_engine: "Telnyx",
    transcription_model: "openai/whisper-large-v3-turbo",
    language: "en",
    transcription_tracks: "inbound",
  });

  assert.deepEqual(plain(body), {
    transcription_engine: "Telnyx",
    transcription_tracks: "inbound",
    transcription_engine_config: {
      transcription_engine: "Telnyx",
      transcription_model: "openai/whisper-large-v3-turbo",
      language: "en",
    },
  });
});
