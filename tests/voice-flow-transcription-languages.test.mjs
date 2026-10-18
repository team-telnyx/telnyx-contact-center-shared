import assert from "node:assert/strict";
import { readFile } from "./helpers/ui-source.mjs";
import test from "node:test";
import { TRANSCRIPTION_PROVIDERS } from "../config/voice.js";

function providerLanguages(modelName) {
  const provider = TRANSCRIPTION_PROVIDERS.find(
    (item) => item.model_name === modelName,
  );
  assert.ok(provider, `${modelName} should be configured`);
  return provider.languages || [];
}

test("Voice API providers without a documented language list do not persist language", () => {
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
