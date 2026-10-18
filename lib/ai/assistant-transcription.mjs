import { sourceText } from "../i18n/source-text.mjs";
import { cloneAssistantOverride } from "./assistant-overrides.mjs";
// AI Assistant transcription models and provider-specific defaults from the
// Telnyx OpenAPI schemas `TranscriptionSettings` and
// `TranscriptionSettingsConfig`.
export const ASSISTANT_TRANSCRIPTION_MODELS = [
  "assemblyai/universal-3-5-pro",
  "soniox/stt-rt-v5",
  "omi-health/omi-med-stt-v1",
  "reson8/turns",
  "cohere/ar-stt",
  "telnyx/basira",
  "deepgram/flux",
  "deepgram/nova-3",
  "deepgram/nova-2",
  "speechmatics/standard",
  "azure/fast",
  "assemblyai/universal-streaming",
  "xai/grok-stt",
  "soniox/stt-rt-v4",
  "nvidia/parakeet-v3",
  "humain/realtime",
  "distil-whisper/distil-large-v2",
  "openai/whisper-large-v3-turbo",
];

export const AZURE_TRANSCRIPTION_REGIONS = [
  "latency",
  "australiaeast",
  "centralindia",
  "eastus",
  "northcentralus",
  "westeurope",
  "westus2",
];

export function createTranscriptionOverride(model = "deepgram/flux") {
  const selectedModel = ASSISTANT_TRANSCRIPTION_MODELS.includes(model)
    ? model
    : "deepgram/flux";
  const transcription = { model: selectedModel };

  if (selectedModel === "deepgram/flux") {
    return {
      ...transcription,
      language: "auto",
      settings: {
        eot_threshold: 0.8,
        eot_timeout_ms: 5000,
        eager_eot_threshold: 0.4,
      },
    };
  }

  if (selectedModel === "deepgram/nova-2" || selectedModel === "deepgram/nova-3") {
    return {
      ...transcription,
      language: "auto",
      settings: {
        smart_format: true,
        numerals: true,
      },
    };
  }

  if (["assemblyai/universal-streaming", "assemblyai/universal-3-5-pro"].includes(selectedModel)) {
    return {
      ...transcription,
      language: "auto",
      settings: {
        end_of_turn_confidence_threshold: 0.4,
        min_turn_silence: 400,
        max_turn_silence: 1280,
      },
    };
  }

  if (["soniox/stt-rt-v4", "soniox/stt-rt-v5"].includes(selectedModel)) {
    return {
      ...transcription,
      language: "auto",
      settings: {
        interim_results: false,
        enable_endpoint_detection: false,
      },
    };
  }

  if (selectedModel === "azure/fast") {
    return {
      ...transcription,
      region: "latency",
      language: "auto",
    };
  }

  if (selectedModel === "omi-health/omi-med-stt-v1") return {...transcription, language:"en"};
  if (selectedModel === "cohere/ar-stt") return {...transcription, language:"ar"};
  if (selectedModel === "telnyx/basira") return {...transcription, language:"ar"};

  if (selectedModel === "humain/realtime") {
    return {
      ...transcription,
      language: "auto",
    };
  }

  return {
    ...transcription,
    language: "auto",
  };
}

export function cloneAssistantTranscriptionOverride(transcription) {
  if (
    transcription &&
    typeof transcription === "object" &&
    !Array.isArray(transcription) &&
    Object.keys(transcription).length > 0
  ) {
    return cloneAssistantOverride(transcription, "TranscriptionSettings");
  }
  return createTranscriptionOverride();
}

function isNumberInRange(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function validateTranscriptionOverride(transcription, tUi = sourceText) {
  if (!transcription || typeof transcription !== "object") return [];

  const issues = [];
  const model = String(transcription.model || "");
  // GET responses include null placeholders for unused provider settings.
  const settings = Object.fromEntries(
    Object.entries(transcription.settings || {}).filter(([, value]) => value != null),
  );

  if (!model) {
    issues.push(tUi("Transcription override requires a model."));
    return issues;
  }

  if (!ASSISTANT_TRANSCRIPTION_MODELS.includes(model)) {
    issues.push(tUi("Unsupported transcription model: {value0}.", {value0: model}));
  }

  if (model === "deepgram/flux") {
    const eot = settings.eot_threshold;
    const timeout = settings.eot_timeout_ms;
    const eager = settings.eager_eot_threshold;

    if (eot !== undefined && !isNumberInRange(eot, 0.5, 0.9)) {
      issues.push(tUi("Flux end-of-turn threshold must be between 0.5 and 0.9."));
    }
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 500 || timeout > 10000)) {
      issues.push(tUi("Flux end-of-turn timeout must be an integer between 500 and 10000 ms."));
    }
    if (eager !== undefined && !isNumberInRange(eager, 0.3, 0.9)) {
      issues.push(tUi("Flux eager end-of-turn threshold must be between 0.3 and 0.9."));
    }
    if (
      eager !== undefined &&
      eot !== undefined &&
      Number.isFinite(eager) &&
      Number.isFinite(eot) &&
      eager > eot
    ) {
      issues.push(tUi("Flux eager end-of-turn threshold must be less than or equal to the end-of-turn threshold."));
    }
  }

  if (["assemblyai/universal-streaming", "assemblyai/universal-3-5-pro"].includes(model)) {
    const confidence = settings.end_of_turn_confidence_threshold;
    const minSilence = settings.min_turn_silence;
    const maxSilence = settings.max_turn_silence;

    if (confidence !== undefined && !isNumberInRange(confidence, 0, 1)) {
      issues.push(tUi("AssemblyAI end-of-turn confidence must be between 0 and 1."));
    }
    if (
      minSilence !== undefined &&
      (!Number.isInteger(minSilence) || minSilence < 100 || minSilence > 5000)
    ) {
      issues.push(tUi("AssemblyAI minimum turn silence must be an integer between 100 and 5000 ms."));
    }
    if (
      maxSilence !== undefined &&
      (!Number.isInteger(maxSilence) || maxSilence < 100 || maxSilence > 5000)
    ) {
      issues.push(tUi("AssemblyAI maximum turn silence must be an integer between 100 and 5000 ms."));
    }
    if (
      minSilence !== undefined &&
      maxSilence !== undefined &&
      Number.isFinite(minSilence) &&
      Number.isFinite(maxSilence) &&
      minSilence > maxSilence
    ) {
      issues.push(tUi("AssemblyAI minimum turn silence must be less than or equal to maximum turn silence."));
    }
  }

  if (["soniox/stt-rt-v4", "soniox/stt-rt-v5"].includes(model) && settings.max_endpoint_delay_ms !== undefined) {
    const delay = settings.max_endpoint_delay_ms;
    if (!Number.isInteger(delay) || delay < 500 || delay > 3000) {
      issues.push(tUi("Soniox maximum endpoint delay must be an integer between 500 and 3000 ms."));
    }
  }

  return issues;
}
