// AI Assistant transcription models and provider-specific defaults from the
// Telnyx OpenAPI schemas `TranscriptionSettings` and
// `TranscriptionSettingsConfig`.
export const ASSISTANT_TRANSCRIPTION_MODELS = [
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

  if (selectedModel === "assemblyai/universal-streaming") {
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

  if (selectedModel === "soniox/stt-rt-v4") {
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
    };
  }

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
    return JSON.parse(JSON.stringify(transcription));
  }
  return createTranscriptionOverride();
}

function isNumberInRange(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function validateTranscriptionOverride(transcription) {
  if (!transcription || typeof transcription !== "object") return [];

  const issues = [];
  const model = String(transcription.model || "");
  const settings = transcription.settings || {};

  if (!model) {
    issues.push("Transcription override requires a model.");
    return issues;
  }

  if (!ASSISTANT_TRANSCRIPTION_MODELS.includes(model)) {
    issues.push(`Unsupported transcription model: ${model}.`);
  }

  if (model === "deepgram/flux") {
    const eot = settings.eot_threshold;
    const timeout = settings.eot_timeout_ms;
    const eager = settings.eager_eot_threshold;

    if (eot !== undefined && !isNumberInRange(eot, 0.5, 0.9)) {
      issues.push("Flux end-of-turn threshold must be between 0.5 and 0.9.");
    }
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 500 || timeout > 10000)) {
      issues.push("Flux end-of-turn timeout must be an integer between 500 and 10000 ms.");
    }
    if (eager !== undefined && !isNumberInRange(eager, 0.3, 0.9)) {
      issues.push("Flux eager end-of-turn threshold must be between 0.3 and 0.9.");
    }
    if (
      eager !== undefined &&
      eot !== undefined &&
      Number.isFinite(eager) &&
      Number.isFinite(eot) &&
      eager > eot
    ) {
      issues.push("Flux eager end-of-turn threshold must be less than or equal to the end-of-turn threshold.");
    }
  }

  if (model === "assemblyai/universal-streaming") {
    const confidence = settings.end_of_turn_confidence_threshold;
    const minSilence = settings.min_turn_silence;
    const maxSilence = settings.max_turn_silence;

    if (confidence !== undefined && !isNumberInRange(confidence, 0, 1)) {
      issues.push("AssemblyAI end-of-turn confidence must be between 0 and 1.");
    }
    if (
      minSilence !== undefined &&
      (!Number.isInteger(minSilence) || minSilence < 100 || minSilence > 5000)
    ) {
      issues.push("AssemblyAI minimum turn silence must be an integer between 100 and 5000 ms.");
    }
    if (
      maxSilence !== undefined &&
      (!Number.isInteger(maxSilence) || maxSilence < 100 || maxSilence > 5000)
    ) {
      issues.push("AssemblyAI maximum turn silence must be an integer between 100 and 5000 ms.");
    }
    if (
      minSilence !== undefined &&
      maxSilence !== undefined &&
      Number.isFinite(minSilence) &&
      Number.isFinite(maxSilence) &&
      minSilence > maxSilence
    ) {
      issues.push("AssemblyAI minimum turn silence must be less than or equal to maximum turn silence.");
    }
  }

  if (model === "soniox/stt-rt-v4" && settings.max_endpoint_delay_ms !== undefined) {
    const delay = settings.max_endpoint_delay_ms;
    if (!Number.isInteger(delay) || delay < 500 || delay > 3000) {
      issues.push("Soniox maximum endpoint delay must be an integer between 500 and 3000 ms.");
    }
  }

  return issues;
}
