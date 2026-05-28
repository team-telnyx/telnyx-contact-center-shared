import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TRANSCRIPTION_PROVIDERS } from "../config/voice.js";

async function telnyxSchemas() {
  const spec = JSON.parse(
    await readFile(new URL("../openapi/telnyx.json", import.meta.url), "utf8"),
  );
  return spec.components.schemas;
}

function providerLanguages(modelName) {
  const provider = TRANSCRIPTION_PROVIDERS.find(
    (item) => item.model_name === modelName,
  );
  assert.ok(provider, `${modelName} should be configured`);
  return provider.languages || [];
}

function extractGoogleLanguages(source) {
  const start = source.indexOf("const GOOGLE_LANGUAGES = [");
  assert.ok(start > -1, "GOOGLE_LANGUAGES should exist");
  const open = source.indexOf("[", start);
  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "[") depth += 1;
    if (source[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        return [...source.slice(open, index + 1).matchAll(/"([^"]+)"/g)].map(
          (match) => match[1],
        );
      }
    }
  }

  throw new Error("Could not parse GOOGLE_LANGUAGES");
}

function assertSameList(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label} should match Telnyx OpenAPI`);
}

test("Voice API transcription language lists match Telnyx OpenAPI enums", async () => {
  const schemas = await telnyxSchemas();
  const editorSource = await readFile(
    new URL("../components/voice-flow/TranscriptionNodeEditor.jsx", import.meta.url),
    "utf8",
  );

  assertSameList(
    extractGoogleLanguages(editorSource),
    schemas.GoogleTranscriptionLanguage.enum,
    "Google picker languages",
  );
  assertSameList(
    providerLanguages("openai/whisper-tiny"),
    schemas.TelnyxTranscriptionLanguage.enum,
    "OpenAI Whisper Tiny languages",
  );
  assertSameList(
    providerLanguages("openai/whisper-large-v3-turbo"),
    schemas.TelnyxTranscriptionLanguage.enum,
    "OpenAI Whisper Large v3 Turbo languages",
  );
  assertSameList(
    providerLanguages("deepgram/nova-2"),
    schemas.DeepgramNova2TranscriptionLanguage.enum,
    "Deepgram Nova 2 languages",
  );
  assertSameList(
    providerLanguages("deepgram/nova-3"),
    schemas.DeepgramNova3TranscriptionLanguage.enum,
    "Deepgram Nova 3 languages",
  );
  assertSameList(
    providerLanguages("azure/fast"),
    schemas.AzureTranscriptionLanguage.enum,
    "Azure Fast languages",
  );
  assertSameList(
    providerLanguages("speechmatics/standard"),
    schemas.SpeechmaticsTranscriptionLanguage.enum,
    "Speechmatics languages",
  );
  assertSameList(
    providerLanguages("xai/grok-stt"),
    schemas.XaiTranscriptionLanguage.enum,
    "xAI Grok STT languages",
  );
});

test("Voice API providers without OpenAPI language enums do not persist language", () => {
  assert.deepEqual(providerLanguages("assemblyai/universal-streaming"), []);
});

test("interim results UI is enabled only for Voice API configs that support it", async () => {
  const source = await readFile(
    new URL("../components/voice-flow/TranscriptionNodeEditor.jsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const INTERIM_RESULTS_MODELS = new Set\(\[[\s\S]*"deepgram\/nova-2"[\s\S]*"deepgram\/nova-3"[\s\S]*"assemblyai\/universal-streaming"[\s\S]*"speechmatics\/standard"[\s\S]*"soniox\/stt-rt-v4"[\s\S]*"xai\/grok-stt"/,
  );
  assert.match(source, /provider === "Google" \|\| INTERIM_RESULTS_MODELS\.has\(model\)/);
  assert.match(source, /\{interimResultsSupported && \(/);
  assert.match(source, /handleAdvancedParamChange\("interim_results", checked\)/);
  assert.match(source, />\s*Interim Results\s*<\/Label>/);
});
