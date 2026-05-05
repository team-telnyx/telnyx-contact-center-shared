export const TRANSCRIPTION_PROVIDERS = [
  {
    model_name: "distil-whisper/distil-large-v2",
    languages: [
      "auto",
      "en","en-US","en-AU","en-GB","en-IN",
      "de","fr","es","pt","it","nl","pl","ru",
      "ar","zh","ja","ko","tr","uk","sv","da",
      "no","fi","cs","ro","hu","bg","hr","sk",
      "sl","lt","lv","et","hi","id","ms","vi","th",
    ],
  },
  {
    model_name: "openai/whisper-large-v3-turbo",
    languages: [
      "auto",
      "sq",
      "am",
      "ar",
      "hy",
      "as",
      "az",
      "ba",
      "eu",
      "be",
      "bn",
      "bs",
      "br",
      "bg",
      "my",
      "ca",
      "zh",
      "hr",
      "cs",
      "da",
      "nl",
      "en",
      "et",
      "fo",
      "fa",
      "fi",
      "fr",
      "gl",
      "ka",
      "de",
      "el",
      "gu",
      "ht",
      "ha",
      "he",
      "hi",
      "hu",
      "is",
      "id",
      "it",
      "ja",
      "jv",
      "kn",
      "kk",
      "km",
      "ko",
      "ku",
      "ky",
      "lo",
      "la",
      "lv",
      "lt",
      "lb",
      "mk",
      "mg",
      "ms",
      "ml",
      "mt",
      "mi",
      "mr",
      "mn",
      "ne",
      "no",
      "nn",
      "oc",
      "or",
      "ps",
      "fa",
      "pl",
      "pt",
      "pa",
      "ro",
      "ru",
      "sa",
      "gd",
      "sr",
      "sn",
      "sd",
      "si",
      "sk",
      "sl",
      "so",
      "st",
      "es",
      "su",
      "sw",
      "sv",
      "tg",
      "ta",
      "tt",
      "te",
      "th",
      "tr",
      "tk",
      "tw",
      "uk",
      "ur",
      "ug",
      "uz",
      "vi",
      "cy",
      "fy",
      "xh",
      "yi",
      "yo",
      "zu",
    ],
  },
  {
    model_name: "deepgram/nova-2",
    languages: [
      "auto",
      "bg",
      "ca",
      "zh-CN",
      "zh-Hans",
      "zh-TW",
      "zh-Hant",
      "zh-HK",
      "cs",
      "da",
      "da-DK",
      "nl",
      "nl-BE",
      "en",
      "en-US",
      "en-AU",
      "en-GB",
      "en-NZ",
      "en-IN",
      "et",
      "fi",
      "nl-BE",
      "fr",
      "fr-CA",
      "de",
      "de-CH",
      "el",
      "hi",
      "hu",
      "id",
      "it",
      "ja",
      "ko",
      "ko-KR",
      "lv",
      "lt",
      "ms",
      "no",
      "pl",
      "pt",
      "pt-BR",
      "pt-PT",
      "ro",
      "ru",
      "sk",
      "es",
      "es-419",
      "sv",
      "sv-SE",
      "th",
      "th-TH",
      "tr",
      "uk",
      "vi",
    ],
  },
  {
    model_name: "deepgram/nova-3",
    // Full language list per Deepgram docs: https://developers.deepgram.com/docs/models-languages-overview#nova-3
    languages: [
      "auto",         // multi (multilingual auto-detect)
      // Arabic variants
      "ar",
      "ar-AE", "ar-SA", "ar-QA", "ar-KW",
      "ar-SY", "ar-LB", "ar-PS", "ar-JO",
      "ar-EG", "ar-SD", "ar-TD", "ar-MA",
      "ar-DZ", "ar-TN", "ar-IQ", "ar-IR",
      // Other languages A-Z
      "be",           // Belarusian
      "bn",           // Bengali
      "bg",           // Bulgarian
      "bs",           // Bosnian
      "ca",           // Catalan
      "zh", "zh-CN", "zh-Hans",  // Chinese Mandarin Simplified
      "zh-TW", "zh-Hant",        // Chinese Mandarin Traditional
      "zh-HK",        // Chinese Cantonese Traditional
      "hr",           // Croatian
      "cs",           // Czech
      "da", "da-DK",  // Danish
      "nl",           // Dutch
      "nl-BE",        // Flemish
      "en", "en-US", "en-AU", "en-GB", "en-IN", "en-NZ",  // English
      "et",           // Estonian
      "fi",           // Finnish
      "fr", "fr-CA",  // French
      "de",           // German
      "de-CH",        // German Switzerland
      "el",           // Greek
      "gu", "gu-IN",  // Gujarati
      "he",           // Hebrew
      "hi",           // Hindi
      "hr",           // Croatian
      "hu",           // Hungarian
      "id",           // Indonesian
      "it",           // Italian
      "ja",           // Japanese
      "kn",           // Kannada
      "ko", "ko-KR",  // Korean
      "lv",           // Latvian
      "lt",           // Lithuanian
      "mk",           // Macedonian
      "ms",           // Malay
      "mr",           // Marathi
      "no",           // Norwegian
      "fa",           // Persian
      "pl",           // Polish
      "pt", "pt-BR", "pt-PT",  // Portuguese
      "ro",           // Romanian
      "ru",           // Russian
      "sr",           // Serbian
      "sk",           // Slovak
      "sl",           // Slovenian
      "es", "es-419", // Spanish
      "sv", "sv-SE",  // Swedish
      "tl",           // Tagalog
      "ta",           // Tamil
      "te",           // Telugu
      "th", "th-TH",  // Thai
      "tr",           // Turkish
      "uk",           // Ukrainian
      "ur",           // Urdu
      "vi",           // Vietnamese
    ],
  },
  {
    model_name: "deepgram/flux",
    // Per Telnyx OpenAPI TranscriptionSettings.language for deepgram/flux:
    // auto = Telnyx language detection controls the language hint
    // multi = no language hint / multilingual
    languages: [
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
  },
  {
    model_name: "azure/fast",
    languages: [
      "ar-SA",
      "da-DK",
      "de-AT",
      "de-CH",
      "de-DE",
      "en-GB",
      "en-IN",
      "en-US",
      "es-ES",
      "es-MX",
      "fi-FI",
      "fr-FR",
      "he-IL",
      "hi-IN",
      "id-ID",
      "it-IT",
      "ja-JP",
      "ko-KR",
      "nl-NL",
      "pl-PL",
      "pt-BR",
      "pt-PT",
      "ru-RU",
      "sv-SE",
      "th-TH",
      "zh-CN",
    ],
  },
  {
    // AssemblyAI Universal Streaming — only Auto (Multilingual) and English per Telnyx portal
    model_name: "assemblyai/universal-streaming",
    languages: [
      "auto",
      "en",
    ],
  },
  {
    // xAI Grok STT — exact language list per Telnyx portal
    model_name: "xai/grok-stt",
    languages: [
      "auto",
      "ar",   // Arabic
      "cs",   // Czech
      "da",   // Danish
      "nl",   // Dutch
      "en",   // English
      "fil",  // Filipino
      "fr",   // French
      "de",   // German
      "hi",   // Hindi
      "id",   // Indonesian
      "it",   // Italian
      "ja",   // Japanese
      "ko",   // Korean
      "mk",   // Macedonian
      "ms",   // Malay
      "fa",   // Persian
      "pl",   // Polish
      "pt",   // Portuguese
      "ro",   // Romanian
      "ru",   // Russian
      "es",   // Spanish
      "sv",   // Swedish
      "th",   // Thai
      "tr",   // Turkish
      "vi",   // Vietnamese
    ],
  },
];

export const AZURE_REGIONS = [
  { value: "australiaeast", label: "Australia East" },
  { value: "centralindia", label: "Central India" },
  { value: "eastus", label: "East US" },
  { value: "northcentralus", label: "North Central US" },
  { value: "westeurope", label: "West Europe" },
  { value: "westus2", label: "West US 2" },
];

const TRANSCRIPTION_PROVIDER_META = {
  "distil-whisper/distil-large-v2": {
    label: "Distil-Whisper Large v2",
    provider: "distil-whisper",
  },
  "openai/whisper-large-v3-turbo": {
    label: "OpenAI Whisper Large v3 Turbo",
    provider: "openai",
  },
  "deepgram/nova-2": { label: "Deepgram Nova 2", provider: "deepgram" },
  "deepgram/nova-3": { label: "Deepgram Nova 3", provider: "deepgram" },
  "deepgram/flux": { label: "Deepgram Flux", provider: "deepgram" },
  "azure/fast": { label: "Azure Fast", provider: "azure", requiresRegion: true },
  "assemblyai/universal-streaming": {
    label: "AssemblyAI Universal Streaming",
    provider: "assemblyai",
  },
  "xai/grok-stt": { label: "xAI Grok STT", provider: "xai" },
};

for (const provider of TRANSCRIPTION_PROVIDERS) {
  Object.assign(provider, TRANSCRIPTION_PROVIDER_META[provider.model_name] || {});
}

export const NOISE_SUPPRESSION_PROVIDERS = [
  {
    value: "krisp",
    label: "Krisp",
    recommended: false,
  },
  {
    value: "deepfilternet",
    label: "DeepFilterNet",
    configDefaults: { attenuation_limit: 100, mode: "advanced" },
  },
  {
    value: "aicoustics",
    label: "AiCoustics",
    recommended: true,
    configDefaults: { model: "voice_focus_2.0", enhancement_level: 0.8 },
  },
];

export const CALL_FLOW_NOISE_SUPPRESSION_ENGINES = [
  { value: "Denoiser", label: "Denoiser" },
  { value: "DeepFilterNet", label: "DeepFilterNet" },
  { value: "Krisp", label: "Krisp" },
  { value: "AiCoustics", label: "AiCoustics" },
];

export function getTranscriptionProvider(modelName) {
  return TRANSCRIPTION_PROVIDERS.find((p) => p.model_name === modelName) || null;
}

export function getDefaultTranscriptionLanguage(modelName, fallback = "auto") {
  const provider = getTranscriptionProvider(modelName);
  const languages = provider?.languages || [];
  if (languages.includes("auto")) return "auto";
  if (languages.includes("auto_detect")) return "auto_detect";
  if (languages.includes(fallback)) return fallback;
  if (languages.includes("en")) return "en";
  return languages[0] || fallback;
}

export function getNoiseSuppressionConfigDefaults(providerValue) {
  return (
    NOISE_SUPPRESSION_PROVIDERS.find((p) => p.value === providerValue)
      ?.configDefaults || undefined
  );
}
