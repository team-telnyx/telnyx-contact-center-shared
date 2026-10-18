import contract from "./assistant-contract.json" with { type: "json" };
import { TRANSCRIPTION_PROVIDERS } from "../../config/voice.js";
import {
  createTranscriptionOverride,
  validateTranscriptionOverride,
} from "./assistant-transcription.mjs";
const schemas = contract.components.schemas;
export const TRANSCRIPTION_MODELS =
  schemas.TranscriptionSettings.properties.model.enum;
export const STREAMING_TRANSCRIPTION_MODELS =
  schemas.TranscriptionFallbackModel.properties.model.enum;
export const canonicalTranscriptionModel = (model) =>
  model === "assemblyai/universal-streaming"
    ? "assemblyai/universal-3-5-pro"
    : model;
export const isStreamingTranscription = (model) =>
  STREAMING_TRANSCRIPTION_MODELS.includes(model);
export function transcriptionSettingNames(model = "") {
  if (model === "deepgram/flux")
    return [
      "eot_threshold",
      "eot_timeout_ms",
      "eager_eot_threshold",
      "keyterm",
    ];
  if (model.startsWith("deepgram/nova-"))
    return [
      "smart_format",
      "numerals",
      ...(model.endsWith("nova-3") ? ["keyterm"] : []),
    ];
  if (model.startsWith("assemblyai/"))
    return [
      "end_of_turn_confidence_threshold",
      "min_turn_silence",
      "max_turn_silence",
    ];
  if (model.startsWith("soniox/"))
    return [
      "interim_results",
      "enable_endpoint_detection",
      "max_endpoint_delay_ms",
      "context",
      "language_hints",
    ];
  return [];
}
export function inheritedTranscriptionSettings(primary, model) {
  const allowed = transcriptionSettingNames(model);
  const inherited = Object.fromEntries(
    Object.entries(primary?.settings || {}).filter(
      ([, value]) => value != null,
    ),
  );
  return Object.fromEntries(
    Object.entries({
      ...createTranscriptionOverride(model).settings,
      ...Object.fromEntries(
        allowed
          .filter(
            (key) =>
              schemas.TranscriptionSettingsConfig.properties[key].default !==
              undefined,
          )
          .map((key) => [
            key,
            schemas.TranscriptionSettingsConfig.properties[key].default,
          ]),
      ),
      ...inherited,
    }).filter(([key, value]) => allowed.includes(key) && value != null),
  );
}
export function transcriptionLanguages(model) {
  const fixed = {
    "deepgram/flux": [
      "auto",
      "multi",
      "en",
      "es",
      "fr",
      "de",
      "hi",
      "ru",
      "pt",
      "ja",
      "it",
      "nl",
    ],
    "reson8/turns": [
      "auto",
      "nl",
      "en",
      "fr",
      "fy",
      "de",
      "it",
      "pl",
      "pt",
      "es",
      "sv",
    ],
    "humain/realtime": ["auto", "ar", "en", "codeswitch"],
    "omi-health/omi-med-stt-v1": ["en"],
    "cohere/ar-stt": ["ar", "en"],
    "telnyx/basira": ["ar", "auto", "multi"],
  };
  if (fixed[model]) return fixed[model];
  const alias = {
    "soniox/stt-rt-v5": "soniox/stt-rt-v4",
    "assemblyai/universal-3-5-pro": "assemblyai/universal-streaming",
  };
  const languages =
    TRANSCRIPTION_PROVIDERS.find(
      (p) => p.model_name === (alias[model] || model),
    )?.languages || [];
  // Empty catalogues retain an explicit language-code input in the UI.
  return [...new Set(["auto", ...languages])];
}
export function additionalTranscriptionModels(
  primary,
  mode,
  entries = [],
  index = -1,
) {
  const used = new Set(
    [
      primary.model,
      ...entries.filter((_, i) => i !== index).map((entry) => entry.model),
    ].map(canonicalTranscriptionModel),
  );
  return TRANSCRIPTION_MODELS.filter((model) => {
    if (model === "assemblyai/universal-streaming") return false; // Show the current name once; preserve imported aliases.
    if (mode === "fallback")
      return (
        isStreamingTranscription(primary.model) &&
        isStreamingTranscription(model) &&
        !used.has(canonicalTranscriptionModel(model))
      );
    return (
      isStreamingTranscription(model) ===
      isStreamingTranscription(primary.model)
    );
  });
}
export function updateTranscriptionFallbacks(value, entries) {
  return {
    ...value,
    fallback_models: entries.length ? entries.map(writableEntry) : null,
    challenger: null,
  };
}
export function updateTranscriptionBooster(value, challenger) {
  return {
    ...value,
    fallback_models: null,
    challenger: challenger ? writableEntry(challenger) : null,
  };
}
function writableEntry(entry) {
  // API responses fill unused settings with null; these are not writable
  // settings values. Remove them before editing or reordering saved entries.
  return {
    ...entry,
    settings:
      entry.settings == null
        ? null
        : Object.fromEntries(
            Object.entries(entry.settings).filter(([, value]) => value != null),
          ),
  };
}
export function transcriptionRuleAvailable(rule, primary, booster) {
  if (rule === "best_engine")
    return (
      isStreamingTranscription(primary.model) &&
      isStreamingTranscription(booster?.model)
    );
  if (rule === "merge_words") {
    const pair = [primary.model, booster?.model];
    const language =
      primary.model === "telnyx/basira"
        ? primary.language || "ar"
        : booster?.language || primary.language || "ar";
    return (
      pair.includes("telnyx/basira") &&
      pair.includes("cohere/ar-stt") &&
      /^(ar(?:-|$)|auto$|multi$)/.test(language)
    );
  }
  return true;
}
export function validateAdditionalTranscription(value = {}) {
  const errors = [];
  const fallbacks = value.fallback_models || [];
  if (fallbacks.length && value.challenger)
    errors.push("Choose either fallback models or a language booster.");
  if (fallbacks.length > 3) errors.push("Use at most three fallback models.");
  if (fallbacks.length && !isStreamingTranscription(value.model))
    errors.push("Fallbacks require a streaming primary transcription model.");
  const used = new Set([canonicalTranscriptionModel(value.model)]);
  for (const entry of fallbacks) {
    if (!isStreamingTranscription(entry.model))
      errors.push("Each fallback must be a streaming transcription model.");
    if (used.has(canonicalTranscriptionModel(entry.model)))
      errors.push("Each fallback must use a different transcription model.");
    used.add(canonicalTranscriptionModel(entry.model));
  }
  const booster = value.challenger;
  if (booster) {
    if (
      isStreamingTranscription(value.model) !==
      isStreamingTranscription(booster.model)
    )
      errors.push(
        "The primary model and language booster must both use streaming or both use non-streaming transcription.",
      );
    if (
      canonicalTranscriptionModel(value.model) ===
        canonicalTranscriptionModel(booster.model) &&
      (booster.language || value.language || "auto") ===
        (value.language || "auto")
    )
      errors.push(
        "Choose a different language when the booster uses the primary model.",
      );
    if (
      !transcriptionRuleAvailable(booster.rule || "best_turn", value, booster)
    )
      errors.push(
        "Choose a transcript selection rule supported by this model pair.",
      );
  }
  for (const entry of [...fallbacks, ...(booster ? [booster] : [])]) {
    const model = entry.model;
    errors.push(
      ...validateTranscriptionOverride({
        ...entry,
        settings:
          entry.settings || inheritedTranscriptionSettings(value, model),
      }),
    );
    const language = entry.language || value.language || "auto";
    const known = transcriptionLanguages(model);
    if (
      known.length > 1 &&
      !known.includes(language) &&
      !known.includes(language.split("-")[0])
    )
      errors.push(
        `${model}: choose a supported language instead of ${language}.`,
      );
  }
  return [...new Set(errors)];
}
