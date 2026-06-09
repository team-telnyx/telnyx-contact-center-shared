// Transcription models available through Telnyx AI `/v2/ai/audio/transcriptions`.
// Language lists mirror the demo-portal config (config/voice.js) — `auto` means
// no explicit language hint is sent. `multi` is Deepgram Nova-3's multilingual
// code-switching mode (EN/ES/FR/DE/HI/RU/PT/JA/IT/NL).
export const TRANSCRIPTION_MODELS = [
  {
    value: "deepgram/nova-3",
    label: "Deepgram Nova 3",
    description: "Multilingual, speaker diarization, smart formatting",
    recommended: true,
    supportsDiarization: true,
    languages: [
      "auto",
      "multi",
      // Arabic variants
      "ar",
      "ar-AE", "ar-SA", "ar-QA", "ar-KW",
      "ar-SY", "ar-LB", "ar-PS", "ar-JO",
      "ar-EG", "ar-SD", "ar-TD", "ar-MA",
      "ar-DZ", "ar-TN", "ar-IQ", "ar-IR",
      // Other languages A-Z
      "be", "bn", "bg", "bs", "ca",
      "zh", "zh-CN", "zh-Hans", "zh-TW", "zh-Hant", "zh-HK",
      "hr", "cs", "da", "da-DK", "nl", "nl-BE",
      "en", "en-US", "en-AU", "en-GB", "en-IN", "en-NZ",
      "et", "fi", "fr", "fr-CA", "de", "de-CH", "el",
      "gu", "gu-IN", "he", "hi", "hu", "id", "it", "ja",
      "kn", "ko", "ko-KR", "lv", "lt", "mk", "ms", "mr",
      "no", "fa", "pl", "pt", "pt-BR", "pt-PT", "ro", "ru",
      "sr", "sk", "sl", "es", "es-419", "sv", "sv-SE",
      "tl", "ta", "te", "th", "th-TH", "tr", "uk", "ur", "vi",
    ],
  },
  {
    value: "openai/whisper-large-v3-turbo",
    label: "Whisper Large v3 Turbo",
    description: "Broad multilingual coverage",
    supportsDiarization: false,
    languages: [
      "auto",
      "sq", "am", "ar", "hy", "as", "az", "ba", "eu", "be", "bn", "bs", "br",
      "bg", "my", "ca", "zh", "hr", "cs", "da", "nl", "en", "et", "fo", "fa",
      "fi", "fr", "gl", "ka", "de", "el", "gu", "ht", "ha", "he", "hi", "hu",
      "is", "id", "it", "ja", "jv", "kn", "kk", "km", "ko", "ku", "ky", "lo",
      "la", "lv", "lt", "lb", "mk", "mg", "ms", "ml", "mt", "mi", "mr", "mn",
      "ne", "no", "nn", "oc", "or", "ps", "pl", "pt", "pa", "ro", "ru", "sa",
      "gd", "sr", "sn", "sd", "si", "sk", "sl", "so", "st", "es", "su", "sw",
      "sv", "tg", "ta", "tt", "te", "th", "tr", "tk", "tw", "uk", "ur", "ug",
      "uz", "vi", "cy", "fy", "xh", "yi", "yo", "zu",
    ],
  },
  {
    value: "distil-whisper/distil-large-v2",
    label: "Distil-Whisper Large v2",
    description: "Fastest, lower latency",
    supportsDiarization: false,
    languages: [
      "auto",
      "en", "en-US", "en-AU", "en-GB", "en-IN",
      "de", "fr", "es", "pt", "it", "nl", "pl", "ru",
      "ar", "zh", "ja", "ko", "tr", "uk", "sv", "da",
      "no", "fi", "cs", "ro", "hu", "bg", "hr", "sk",
      "sl", "lt", "lv", "et", "hi", "id", "ms", "vi", "th",
    ],
  },
];

export const DEFAULT_TRANSCRIPTION_MODEL = "deepgram/nova-3";

export function getTranscriptionModel(value) {
  return (
    TRANSCRIPTION_MODELS.find((model) => model.value === value) ||
    TRANSCRIPTION_MODELS[0]
  );
}

// Nova-3 model_config flags forwarded to Telnyx as `model_config` JSON.
export const NOVA3_OPTION_DEFAULTS = {
  smart_format: true,
  punctuate: true,
  diarize: true,
  numerals: false,
};

export function buildTranscriptionModelConfig(model, options, language) {
  if (model !== "deepgram/nova-3") return null;
  const config = {};
  for (const key of ["smart_format", "punctuate", "diarize", "numerals"]) {
    if (typeof options?.[key] === "boolean") config[key] = options[key];
  }
  if (language && language !== "auto") config.language = language;
  return Object.keys(config).length ? config : null;
}
