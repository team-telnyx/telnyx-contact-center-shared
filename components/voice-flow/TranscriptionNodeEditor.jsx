"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { IconKey } from "@tabler/icons-react";

import {
  TRANSCRIPTION_PROVIDERS as VOICE_TRANSCRIPTION_PROVIDERS,
  AZURE_REGIONS,
  getDefaultTranscriptionLanguage,
} from "@/config/voice";

// Language code to language name mapping for common labels. Unknown codes fall back to the raw code.
const LANGUAGE_NAMES = {
  auto: "Auto (experimental)",
  auto_detect: "Auto Detect",
  multi: "Multilingual (no language hint)",
  en: "English",
  "en-US": "English (United States)",
  "en-GB": "English (United Kingdom)",
  "en-AU": "English (Australia)",
  "en-IN": "English (India)",
  "en-NZ": "English (New Zealand)",
  es: "Spanish",
  "es-419": "Spanish (Latin America)",
  fr: "French",
  "fr-CA": "French (Canada)",
  de: "German",
  "de-CH": "German (Switzerland)",
  it: "Italian",
  pt: "Portuguese",
  "pt-BR": "Portuguese (Brazil)",
  "pt-PT": "Portuguese (Portugal)",
  zh: "Chinese",
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
  "zh-Hans": "Chinese (Simplified Han)",
  "zh-Hant": "Chinese (Traditional Han)",
  "zh-HK": "Chinese (Hong Kong)",
  ja: "Japanese",
  ko: "Korean",
  "ko-KR": "Korean (South Korea)",
  ru: "Russian",
  ar: "Arabic",
  hi: "Hindi",
  nl: "Dutch",
  "nl-BE": "Dutch (Belgium)",
  sv: "Swedish",
  "sv-SE": "Swedish (Sweden)",
  pl: "Polish",
  tr: "Turkish",
  th: "Thai",
  "th-TH": "Thai (Thailand)",
  vi: "Vietnamese",
  id: "Indonesian",
  ms: "Malay",
  cs: "Czech",
  da: "Danish",
  "da-DK": "Danish (Denmark)",
  fi: "Finnish",
  no: "Norwegian",
  hu: "Hungarian",
  ro: "Romanian",
  sk: "Slovak",
  bg: "Bulgarian",
  hr: "Croatian",
  lt: "Lithuanian",
  lv: "Latvian",
  et: "Estonian",
  sl: "Slovenian",
  sr: "Serbian",
  uk: "Ukrainian",
  ca: "Catalan",
  yue: "Cantonese",
  fil: "Filipino",
  fa: "Persian",
  he: "Hebrew",
};

const TRANSCRIPTION_PROVIDERS = [
  { value: "Telnyx", label: "Telnyx / OpenAI / Distil-Whisper" },
  { value: "Deepgram", label: "Deepgram" },
  { value: "Azure", label: "Azure" },
  { value: "AssemblyAI", label: "AssemblyAI" },
  { value: "xAI", label: "xAI" },
  { value: "Google", label: "Google (legacy)" },
];

const GOOGLE_MODELS = [
  { value: "latest_long", label: "Latest Long" },
  { value: "latest_short", label: "Latest Short" },
  { value: "command_and_search", label: "Command and Search" },
  { value: "phone_call", label: "Phone Call" },
  { value: "video", label: "Video" },
  { value: "default", label: "Default" },
  { value: "medical_conversation", label: "Medical Conversation" },
  { value: "medical_dictation", label: "Medical Dictation" },
];

const GOOGLE_LANGUAGES = ["auto", "en", "es", "fr", "de", "it", "pt", "pl"];

function getEngineForModel(modelName) {
  const provider = VOICE_TRANSCRIPTION_PROVIDERS.find((p) => p.model_name === modelName);
  switch (provider?.provider) {
    case "deepgram":
      return "Deepgram";
    case "azure":
      return "Azure";
    case "assemblyai":
      return "AssemblyAI";
    case "xai":
      return "xAI";
    case "openai":
    case "distil-whisper":
    case "telnyx":
      return "Telnyx";
    default:
      return "Telnyx";
  }
}

function getModelsForProvider(provider) {
  if (provider === "Google") return GOOGLE_MODELS;
  return VOICE_TRANSCRIPTION_PROVIDERS
    .filter((p) => getEngineForModel(p.model_name) === provider)
    .map((p) => ({ value: p.model_name, label: p.label || p.model_name }));
}

function getLanguagesForProviderModel(provider, model) {
  if (provider === "Google") return GOOGLE_LANGUAGES;
  const found = VOICE_TRANSCRIPTION_PROVIDERS.find((p) => p.model_name === model);
  return found?.languages || [];
}

function coerceCurrentModelIntoOptions(provider, model, models) {
  if (!model || models.some((m) => m.value === model)) return models;
  return [{ value: model, label: `${model} (saved value)` }, ...models];
}

export default function TranscriptionNodeEditor({ config = {}, onChange }) {
  // Read from transcription_engine_config first (new structure), then fall back to flat structure (backward compatibility)
  const engineConfig = config.transcription_engine_config || {};
  const savedModel = engineConfig.transcription_model || config.transcription_model || "";
  const initialProvider = config.transcription_engine || (savedModel ? getEngineForModel(savedModel) : "Deepgram");

  // Determine initial model based on provider
  let initialModel = "";
  if (initialProvider === "Google") {
    initialModel = engineConfig.model || config.model || "";
  } else if (initialProvider === "Deepgram") {
    initialModel = savedModel || "deepgram/flux";
  } else {
    initialModel = savedModel;
  }

  // Determine initial language
  const initialLanguage =
    engineConfig.language ||
    config.language ||
    getDefaultTranscriptionLanguage(initialModel || (initialProvider === "Deepgram" ? "deepgram/flux" : ""), "en");

  const [provider, setProvider] = useState(initialProvider);
  const [model, setModel] = useState(initialModel);
  const [language, setLanguage] = useState(initialLanguage);
  const [transcriptionTracks, setTranscriptionTracks] = useState(
    config.transcription_tracks || "inbound"
  );

  // Google-specific parameters
  const [interimResults, setInterimResults] = useState(
    config.interim_results ?? false
  );
  const [enableSpeakerDiarization, setEnableSpeakerDiarization] = useState(
    config.enable_speaker_diarization ?? false
  );
  const [minSpeakerCount, setMinSpeakerCount] = useState(
    config.min_speaker_count ?? 2
  );
  const [maxSpeakerCount, setMaxSpeakerCount] = useState(
    config.max_speaker_count ?? 6
  );
  const [profanityFilter, setProfanityFilter] = useState(
    config.profanity_filter ?? false
  );
  const [useEnhanced, setUseEnhanced] = useState(config.use_enhanced ?? false);

  // Azure-specific parameters
  const [azureRegion, setAzureRegion] = useState(
    engineConfig.region || config.region || "eastus"
  );
  const [azureApiKeyRef, setAzureApiKeyRef] = useState(
    engineConfig.api_key_ref || config.api_key_ref || ""
  );
  const [azureSecrets, setAzureSecrets] = useState([]);
  const [loadingAzureSecrets, setLoadingAzureSecrets] = useState(false);

  // Ref to track the last config we processed to avoid unnecessary updates
  const lastConfigRef = useRef(JSON.stringify(config));

  // Load secrets for Azure
  useEffect(() => {
    if (provider === "Azure") {
      async function loadSecrets() {
        try {
          setLoadingAzureSecrets(true);
          const res = await fetch("/api/integration-secrets", {
            cache: "no-store",
          });
          const data = await res.json();
          if (res.ok && data?.ok) {
            const secretsList = (data.secrets || []).map((s) => ({
              id: s.identifier,
              name: s.identifier,
            }));
            setAzureSecrets(secretsList);
          }
        } catch (err) {
          console.error("Failed to load secrets:", err);
        } finally {
          setLoadingAzureSecrets(false);
        }
      }
      loadSecrets();
    } else {
      setAzureSecrets([]);
    }
  }, [provider]);

  // Get available models for current provider
  const availableModels = useMemo(() => {
    return coerceCurrentModelIntoOptions(
      provider,
      model,
      getModelsForProvider(provider)
    );
  }, [provider, model]);

  // Get available languages for current provider/model
  const availableLanguages = useMemo(() => {
    const langs = getLanguagesForProviderModel(provider, model);
    return langs.map((code) => ({
      value: code,
      label: LANGUAGE_NAMES[code] || code,
    }));
  }, [provider, model]);

  // Sync state from config on mount or when config changes externally
  useEffect(() => {
    // Only sync if config actually changed (not from our own updates)
    const currentConfigStr = JSON.stringify(config);
    if (currentConfigStr === lastConfigRef.current) {
      return;
    }
    lastConfigRef.current = currentConfigStr;

    // Check if config has transcription_engine_config (new structure) or flat structure (old)
    const engineConfig = config.transcription_engine_config || {};
    const currentProvider = config.transcription_engine;
    const isGoogle = currentProvider === "Google";
    const isAzure = currentProvider === "Azure";

    if (currentProvider && currentProvider !== provider) {
      setProvider(currentProvider);
    }

    // Read model from transcription_engine_config (all providers) or flat structure (backward compatibility)
    if (isGoogle) {
      const newModel = engineConfig.model || config.model || "";
      setModel(newModel);
    } else {
      const newModel =
        engineConfig.transcription_model || config.transcription_model || "";
      setModel(newModel);
    }

    // Read language from transcription_engine_config (all providers) or flat structure (backward compatibility)
    const newLanguage = engineConfig.language || config.language || "en";
    setLanguage(newLanguage);

    if (config.transcription_tracks) {
      setTranscriptionTracks(config.transcription_tracks);
    }

    // Google-specific parameters - read from transcription_engine_config first, then flat structure
    if (isGoogle) {
      if (engineConfig.interim_results !== undefined) {
        setInterimResults(engineConfig.interim_results);
      } else if (config.interim_results !== undefined) {
        setInterimResults(config.interim_results);
      }

      if (engineConfig.enable_speaker_diarization !== undefined) {
        setEnableSpeakerDiarization(engineConfig.enable_speaker_diarization);
      } else if (config.enable_speaker_diarization !== undefined) {
        setEnableSpeakerDiarization(config.enable_speaker_diarization);
      }

      if (engineConfig.min_speaker_count !== undefined) {
        setMinSpeakerCount(engineConfig.min_speaker_count);
      } else if (config.min_speaker_count !== undefined) {
        setMinSpeakerCount(config.min_speaker_count);
      }

      if (engineConfig.max_speaker_count !== undefined) {
        setMaxSpeakerCount(engineConfig.max_speaker_count);
      } else if (config.max_speaker_count !== undefined) {
        setMaxSpeakerCount(config.max_speaker_count);
      }

      if (engineConfig.profanity_filter !== undefined) {
        setProfanityFilter(engineConfig.profanity_filter);
      } else if (config.profanity_filter !== undefined) {
        setProfanityFilter(config.profanity_filter);
      }

      if (engineConfig.use_enhanced !== undefined) {
        setUseEnhanced(engineConfig.use_enhanced);
      } else if (config.use_enhanced !== undefined) {
        setUseEnhanced(config.use_enhanced);
      }
    }

    // Azure-specific parameters
    if (isAzure) {
      const newRegion = engineConfig.region || config.region || "eastus";
      setAzureRegion(newRegion);
      const newApiKeyRef = engineConfig.api_key_ref || config.api_key_ref || "";
      setAzureApiKeyRef(newApiKeyRef);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // Build the final config structure for the API
  // Accepts optional overrides to use instead of current state
  const buildConfig = (overrides = {}) => {
    const newConfig = { ...config };

    // Use override values or fall back to current state
    const currentProvider = overrides.provider ?? provider;
    const currentModel = overrides.model ?? model;
    const currentLanguage = overrides.language ?? language;
    const currentTracks = overrides.transcription_tracks ?? transcriptionTracks;
    const currentInterimResults = overrides.interim_results ?? interimResults;
    const currentEnableSpeakerDiarization =
      overrides.enable_speaker_diarization ?? enableSpeakerDiarization;
    const currentMinSpeakerCount =
      overrides.min_speaker_count ?? minSpeakerCount;
    const currentMaxSpeakerCount =
      overrides.max_speaker_count ?? maxSpeakerCount;
    const currentProfanityFilter =
      overrides.profanity_filter ?? profanityFilter;
    const currentUseEnhanced = overrides.use_enhanced ?? useEnhanced;
    const currentAzureRegion = overrides.azureRegion ?? azureRegion;
    const currentAzureApiKeyRef = overrides.azureApiKeyRef ?? azureApiKeyRef;

    // Always include transcription_engine and transcription_tracks at top level
    newConfig.transcription_engine = currentProvider;
    newConfig.transcription_tracks = currentTracks;

    // Build transcription_engine_config based on provider according to OpenAPI spec
    if (currentProvider === "Google") {
      newConfig.transcription_engine_config = {
        transcription_engine: "Google",
        ...(currentLanguage && { language: currentLanguage }),
        ...(currentModel && { model: currentModel }),
        interim_results: currentInterimResults,
        enable_speaker_diarization: currentEnableSpeakerDiarization,
        min_speaker_count: currentMinSpeakerCount,
        max_speaker_count: currentMaxSpeakerCount,
        profanity_filter: currentProfanityFilter,
        use_enhanced: currentUseEnhanced,
      };
      // Remove flat Google params from top level
      delete newConfig.model;
      delete newConfig.language;
      delete newConfig.interim_results;
      delete newConfig.enable_speaker_diarization;
      delete newConfig.min_speaker_count;
      delete newConfig.max_speaker_count;
      delete newConfig.profanity_filter;
      delete newConfig.use_enhanced;
    } else if (currentProvider === "Azure") {
      newConfig.transcription_engine_config = {
        transcription_engine: "Azure",
        region: currentAzureRegion,
        ...(currentLanguage && { language: currentLanguage }),
        ...(currentAzureApiKeyRef && { api_key_ref: currentAzureApiKeyRef }),
      };
      // Remove flat params from top level
      delete newConfig.language;
      delete newConfig.region;
      delete newConfig.api_key_ref;
    } else {
      // Telnyx, Deepgram, AssemblyAI and xAI share the transcription_model shape.
      newConfig.transcription_engine_config = {
        transcription_engine: currentProvider,
        ...(currentModel && { transcription_model: currentModel }),
        ...(currentLanguage && { language: currentLanguage }),
      };
      // Remove flat params from top level
      delete newConfig.transcription_model;
      delete newConfig.language;
    }

    // Update the ref to prevent useEffect from overriding our changes
    lastConfigRef.current = JSON.stringify(newConfig);

    return newConfig;
  };

  // Update config when provider changes
  const handleProviderChangeInternal = (newProvider) => {
    // Set default model for the provider (if provider has models)
    const models = getModelsForProvider(newProvider);
    const newModel = models.length > 0 ? models[0].value : "";

    // Reset Azure region to default when switching to Azure
    const newAzureRegion =
      newProvider === "Azure" && azureRegion === "" ? "eastus" : azureRegion;

    // Reset language to default if not available in new provider
    const langs = getLanguagesForProviderModel(newProvider, newModel);
    const newLanguage = langs.includes(language)
      ? language
      : getDefaultTranscriptionLanguage(newModel, "en");

    // Update state
    setProvider(newProvider);
    setModel(newModel);
    if (newProvider === "Azure" && azureRegion === "") {
      setAzureRegion("eastus");
    }
    setLanguage(newLanguage);

    // Build config with new values directly
    onChange?.(
      buildConfig({
        provider: newProvider,
        model: newModel,
        language: newLanguage,
        azureRegion: newAzureRegion,
      })
    );
  };

  // Update config when model changes
  const handleModelChangeInternal = (newModel) => {
    // Reset language if not available in new model
    const langs = getLanguagesForProviderModel(provider, newModel);
    const newLanguage = langs.includes(language)
      ? language
      : getDefaultTranscriptionLanguage(newModel, "en");

    // Update state
    setModel(newModel);
    setLanguage(newLanguage);

    // Build config with new values directly
    onChange?.(
      buildConfig({
        model: newModel,
        language: newLanguage,
      })
    );
  };

  // Update config when language changes
  const handleLanguageChangeInternal = (newLanguage) => {
    setLanguage(newLanguage);
    onChange?.(buildConfig({ language: newLanguage }));
  };

  // Update config when transcription_tracks changes
  const handleTranscriptionTracksChange = (newTracks) => {
    setTranscriptionTracks(newTracks);
    onChange?.(buildConfig({ transcription_tracks: newTracks }));
  };

  // Update config when Google-specific parameters change
  const handleGoogleParamChange = (paramName, value) => {
    const updates = {};
    switch (paramName) {
      case "interim_results":
        setInterimResults(value);
        updates.interim_results = value;
        break;
      case "enable_speaker_diarization":
        setEnableSpeakerDiarization(value);
        updates.enable_speaker_diarization = value;
        break;
      case "min_speaker_count":
        setMinSpeakerCount(value);
        updates.min_speaker_count = value;
        break;
      case "max_speaker_count":
        setMaxSpeakerCount(value);
        updates.max_speaker_count = value;
        break;
      case "profanity_filter":
        setProfanityFilter(value);
        updates.profanity_filter = value;
        break;
      case "use_enhanced":
        setUseEnhanced(value);
        updates.use_enhanced = value;
        break;
    }
    onChange?.(buildConfig(updates));
  };

  return (
    <div className="space-y-4">
      {/* Provider Selection */}
      <div>
        <Label>
          Provider <span className="text-red-500">*</span>
        </Label>
        <Select value={provider} onValueChange={handleProviderChangeInternal}>
          <SelectTrigger className="w-full mt-1">
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            {TRANSCRIPTION_PROVIDERS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          The transcription service provider
        </p>
      </div>

      {/* Model Selection (if provider has models) */}
      {availableModels.length > 0 && (
        <div>
          <Label>
            Model{" "}
            {provider !== "Google" && <span className="text-red-500">*</span>}
          </Label>
          <Select value={model} onValueChange={handleModelChangeInternal}>
            <SelectTrigger className="w-full mt-1">
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent>
              {availableModels.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            The model to use for transcription
          </p>
        </div>
      )}

      {/* Language Selection with Filter */}
      <div>
        <Label>Language</Label>
        <div className="mt-1">
          <Combobox
            options={availableLanguages}
            value={language}
            onChange={handleLanguageChangeInternal}
            placeholder="Select language"
            emptyLabel="No language found"
            searchable={true}
            triggerClassName="w-full"
          />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Language for speech recognition ({availableLanguages.length}{" "}
          available)
        </p>
      </div>

      {/* Transcription Tracks (for all providers) */}
      <div>
        <Label>Transcription Tracks</Label>
        <Select
          value={transcriptionTracks}
          onValueChange={handleTranscriptionTracksChange}
        >
          <SelectTrigger className="w-full mt-1">
            <SelectValue placeholder="Select tracks" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inbound">Inbound</SelectItem>
            <SelectItem value="outbound">Outbound</SelectItem>
            <SelectItem value="both">Both</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          Indicates which leg of the call will be transcribed
        </p>
      </div>

      {/* Google-specific parameters */}
      {provider === "Google" && (
        <>
          <div className="space-y-4 pt-2 border-t">
            <h4 className="text-sm font-medium">Google Advanced Settings</h4>

            {/* Interim Results */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="interim_results"
                checked={interimResults}
                onCheckedChange={(checked) =>
                  handleGoogleParamChange("interim_results", checked)
                }
              />
              <Label
                htmlFor="interim_results"
                className="text-sm font-normal cursor-pointer"
              >
                Interim Results
              </Label>
            </div>
            <p className="text-xs text-muted-foreground -mt-2 ml-6">
              Whether to send also interim results. If set to false, only final
              results will be sent.
            </p>

            {/* Enable Speaker Diarization */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="enable_speaker_diarization"
                checked={enableSpeakerDiarization}
                onCheckedChange={(checked) =>
                  handleGoogleParamChange("enable_speaker_diarization", checked)
                }
              />
              <Label
                htmlFor="enable_speaker_diarization"
                className="text-sm font-normal cursor-pointer"
              >
                Enable Speaker Diarization
              </Label>
            </div>
            <p className="text-xs text-muted-foreground -mt-2 ml-6">
              Enables speaker diarization.
            </p>

            {/* Min Speaker Count */}
            {enableSpeakerDiarization && (
              <div>
                <Label htmlFor="min_speaker_count">Min Speaker Count</Label>
                <Input
                  id="min_speaker_count"
                  type="number"
                  min="1"
                  value={minSpeakerCount}
                  onChange={(e) =>
                    handleGoogleParamChange(
                      "min_speaker_count",
                      parseInt(e.target.value, 10) || 2
                    )
                  }
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Defines minimum number of speakers in the conversation.
                </p>
              </div>
            )}

            {/* Max Speaker Count */}
            {enableSpeakerDiarization && (
              <div>
                <Label htmlFor="max_speaker_count">Max Speaker Count</Label>
                <Input
                  id="max_speaker_count"
                  type="number"
                  min="1"
                  value={maxSpeakerCount}
                  onChange={(e) =>
                    handleGoogleParamChange(
                      "max_speaker_count",
                      parseInt(e.target.value, 10) || 6
                    )
                  }
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Defines maximum number of speakers in the conversation.
                </p>
              </div>
            )}

            {/* Profanity Filter */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="profanity_filter"
                checked={profanityFilter}
                onCheckedChange={(checked) =>
                  handleGoogleParamChange("profanity_filter", checked)
                }
              />
              <Label
                htmlFor="profanity_filter"
                className="text-sm font-normal cursor-pointer"
              >
                Profanity Filter
              </Label>
            </div>
            <p className="text-xs text-muted-foreground -mt-2 ml-6">
              Enables profanity filter.
            </p>

            {/* Use Enhanced */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="use_enhanced"
                checked={useEnhanced}
                onCheckedChange={(checked) =>
                  handleGoogleParamChange("use_enhanced", checked)
                }
              />
              <Label
                htmlFor="use_enhanced"
                className="text-sm font-normal cursor-pointer"
              >
                Use Enhanced
              </Label>
            </div>
            <p className="text-xs text-muted-foreground -mt-2 ml-6">
              Enables enhanced transcription, this works for models phone_call
              and video.
            </p>
          </div>
        </>
      )}

      {/* Azure-specific parameters */}
      {provider === "Azure" && (
        <>
          <div className="space-y-4 pt-2 border-t">
            <h4 className="text-sm font-medium">Azure Settings</h4>

            {/* Region Selection */}
            <div>
              <Label>
                Region <span className="text-red-500">*</span>
              </Label>
              <Select
                value={azureRegion}
                onValueChange={(value) => {
                  setAzureRegion(value);
                  onChange?.(buildConfig({ azureRegion: value }));
                }}
              >
                <SelectTrigger className="w-full mt-1">
                  <SelectValue placeholder="Select region" />
                </SelectTrigger>
                <SelectContent>
                  {AZURE_REGIONS.map((region) => (
                    <SelectItem key={region.value} value={region.value}>
                      {region.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Azure region to use for speech recognition
              </p>
            </div>

            {/* API Key Reference */}
            <div>
              <Label>API Key Reference</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  value={azureApiKeyRef}
                  onChange={(e) => {
                    const newValue = e.target.value;
                    setAzureApiKeyRef(newValue);
                    onChange?.(buildConfig({ azureApiKeyRef: newValue }));
                  }}
                  placeholder="Optional: Reference to API key for authentication"
                  className="flex-1"
                />
                {azureSecrets.length > 0 && (
                  <Select
                    onValueChange={(secretName) => {
                      setAzureApiKeyRef(secretName);
                      onChange?.(buildConfig({ azureApiKeyRef: secretName }));
                    }}
                  >
                    <SelectTrigger className="h-10 w-10 p-0 border-0 bg-transparent [&>svg]:hidden">
                      <div className="h-10 w-10 p-0 flex items-center justify-center">
                        <IconKey className="h-4 w-4 text-telnyx-green" />
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      {azureSecrets.map((secret) => (
                        <SelectItem key={secret.id} value={secret.name}>
                          <div className="flex flex-col">
                            <span className="font-mono text-sm">
                              {secret.name}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Reference to the API key for authentication. See integration
                secrets documentation for details. Optional as defaults are
                available for some regions.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
