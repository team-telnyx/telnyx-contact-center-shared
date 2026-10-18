import test from "node:test";
import assert from "node:assert/strict";
import {
  additionalTranscriptionModels,
  inheritedTranscriptionSettings,
  updateTranscriptionFallbacks,
  updateTranscriptionBooster,
  transcriptionRuleAvailable,
  validateAdditionalTranscription,
  transcriptionSettingNames,
} from "../lib/ai/assistant-transcription-ui.mjs";
import {
  assistantForEditor,
  payloadForSave,
} from "../lib/ai/assistant-draft.mjs";
import { validateAssistantDraftChanges } from "../lib/ai/assistant-contract.mjs";
const primary = {
  model: "deepgram/flux",
  language: "auto",
  settings: {
    eot_threshold: 0.8,
    eot_timeout_ms: 5000,
    context: "retained elsewhere",
  },
};
test("removing the final fallback emits null and preserves primary settings", () => {
  const source = {
    ...primary,
    fallback_models: [{ model: "soniox/stt-rt-v5" }],
  };
  assert.deepEqual(updateTranscriptionFallbacks(source, []), {
    ...primary,
    fallback_models: null,
    challenger: null,
  });
  assert.equal(source.fallback_models.length, 1);
});
test("switching transcription modes explicitly clears the competing mode", () => {
  const booster = {
    model: "soniox/stt-rt-v5",
    language: null,
    settings: null,
    rule: "best_turn",
  };
  const next = updateTranscriptionBooster(
    { ...primary, fallback_models: [{ model: "deepgram/nova-3" }] },
    booster,
  );
  assert.equal(next.fallback_models, null);
  assert.deepEqual(next.challenger, booster);
  assert.equal(
    updateTranscriptionFallbacks(next, [{ model: "deepgram/nova-3" }])
      .challenger,
    null,
  );
  assert.equal(updateTranscriptionBooster(next, null).challenger, null);
});
test("fallback choices exclude primary models, used models and legacy aliases", () => {
  const options = additionalTranscriptionModels(primary, "fallback", [
    { model: "deepgram/nova-3" },
    { model: "assemblyai/universal-streaming" },
  ]);
  for (const excluded of [
    "deepgram/flux",
    "deepgram/nova-3",
    "assemblyai/universal-streaming",
    "assemblyai/universal-3-5-pro",
    "azure/fast",
  ])
    assert(!options.includes(excluded));
  assert(options.includes("soniox/stt-rt-v5"));
  assert.deepEqual(
    additionalTranscriptionModels({ model: "azure/fast" }, "fallback"),
    [],
  );
});
test("booster choices match the primary streaming mode", () => {
  assert(
    !additionalTranscriptionModels(primary, "booster").includes("azure/fast"),
  );
  const options = additionalTranscriptionModels(
    { model: "telnyx/basira" },
    "booster",
  );
  assert(options.includes("cohere/ar-stt"));
  assert(!options.includes("deepgram/flux"));
});
test("inherited settings only contain fields applicable to the chosen provider", () => {
  assert.deepEqual(
    inheritedTranscriptionSettings(primary, "soniox/stt-rt-v5"),
    {
      interim_results: false,
      enable_endpoint_detection: false,
      context: "retained elsewhere",
    },
  );
  assert.equal(
    inheritedTranscriptionSettings(primary, "deepgram/flux").eot_threshold,
    0.8,
  );
  assert(
    !transcriptionSettingNames("deepgram/flux").includes("language_hints"),
  );
});
test("saved null provider placeholders retain defaults and do not fail validation", () => {
  assert.equal(
    inheritedTranscriptionSettings(
      { model: "soniox/stt-rt-v5" },
      "deepgram/flux",
    ).eager_eot_threshold,
    0.8,
  );
  const saved = {
    ...primary,
    settings: {
      ...primary.settings,
      max_endpoint_delay_ms: null,
      smart_format: null,
      numerals: null,
    },
  };
  assert.deepEqual(inheritedTranscriptionSettings(saved, "deepgram/nova-3"), {
    smart_format: true,
    numerals: true,
  });
  assert.equal(
    inheritedTranscriptionSettings(saved, "soniox/stt-rt-v5")
      .max_endpoint_delay_ms,
    undefined,
  );
  assert.deepEqual(
    validateAdditionalTranscription({
      ...saved,
      fallback_models: [
        { model: "soniox/stt-rt-v5", language: null, settings: null },
      ],
    }),
    [],
  );
});
test("transcript rules enforce streaming and Arabic pair restrictions", () => {
  assert(
    transcriptionRuleAvailable("best_engine", primary, {
      model: "soniox/stt-rt-v5",
    }),
  );
  assert(
    !transcriptionRuleAvailable(
      "best_engine",
      { model: "azure/fast" },
      { model: "nvidia/parakeet-v3" },
    ),
  );
  assert(
    transcriptionRuleAvailable(
      "merge_words",
      { model: "telnyx/basira", language: "ar" },
      { model: "cohere/ar-stt" },
    ),
  );
  assert(
    !transcriptionRuleAvailable(
      "merge_words",
      { model: "telnyx/basira", language: "en" },
      { model: "cohere/ar-stt" },
    ),
  );
  assert(
    !transcriptionRuleAvailable("merge_words", primary, {
      model: "soniox/stt-rt-v5",
    }),
  );
});
test("invalid model combinations and duplicate aliases fail before saving", () => {
  assert(
    validateAdditionalTranscription({
      ...primary,
      fallback_models: [{ model: "deepgram/flux" }],
    }).length,
  );
  assert(
    validateAdditionalTranscription({
      ...primary,
      fallback_models: [
        { model: "assemblyai/universal-streaming" },
        { model: "assemblyai/universal-3-5-pro" },
      ],
    }).length,
  );
  assert(
    validateAdditionalTranscription({
      ...primary,
      challenger: { model: "deepgram/flux", language: null },
    }).length,
  );
  assert(
    validateAdditionalTranscription({
      ...primary,
      challenger: { model: "azure/fast" },
    }).length,
  );
  assert.deepEqual(
    validateAdditionalTranscription({
      ...primary,
      challenger: { model: "deepgram/flux", language: "fr" },
    }),
    [],
  );
});
test("custom settings validate current Soniox and AssemblyAI names", () => {
  for (const [model, settings] of [
    ["soniox/stt-rt-v5", { max_endpoint_delay_ms: 100 }],
    [
      "assemblyai/universal-3-5-pro",
      { min_turn_silence: 2000, max_turn_silence: 400 },
    ],
  ]) {
    assert(
      validateAdditionalTranscription({
        ...primary,
        fallback_models: [{ model, settings }],
      }).length,
    );
  }
});
test("mode changes and inherited resets survive the application draft serialization", () => {
  const original = {
    name: "controlled",
    transcription: {
      ...primary,
      fallback_models: [
        { model: "soniox/stt-rt-v5", settings: { interim_results: true } },
      ],
    },
  };
  const draft = assistantForEditor(original);
  draft.transcription = updateTranscriptionBooster(draft.transcription, {
    model: "deepgram/nova-3",
    language: null,
    settings: null,
    rule: "best_turn",
  });
  const patch = payloadForSave(draft, { patch: true });
  assert.equal(patch.transcription.fallback_models, null);
  assert.equal(patch.transcription.challenger.settings, null);
  assert.deepEqual(validateAssistantDraftChanges(patch, original), []);
  assert(!("name" in patch));
});
test("reordering a saved list removes response-only null settings without losing custom values", () => {
  const entries = [
    {
      model: "deepgram/nova-3",
      settings: {
        smart_format: true,
        keyterm: "Telnyx",
        max_endpoint_delay_ms: null,
      },
    },
    { model: "soniox/stt-rt-v5", language: null, settings: null },
  ];
  const original = {
    name: "controlled",
    transcription: { ...primary, fallback_models: entries },
  };
  const draft = assistantForEditor(original);
  draft.transcription = updateTranscriptionFallbacks(
    draft.transcription,
    [...entries].reverse(),
  );
  const patch = payloadForSave(draft, { patch: true });
  assert.deepEqual(patch.transcription.fallback_models[1].settings, {
    smart_format: true,
    keyterm: "Telnyx",
  });
  assert.deepEqual(validateAssistantDraftChanges(patch, original), []);
  assert.equal(entries[0].settings.max_endpoint_delay_ms, null);
});
