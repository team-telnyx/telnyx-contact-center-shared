"use client";

import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  IconLock,
  IconInfoCircle,
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconBrain,
  IconSettings,
  IconMicrophone,
} from "@tabler/icons-react";
import { AI_STREAMING_PROVIDERS } from "@/config/ai-streaming-providers";

// Validate WebSocket URL format (ws:// or wss://)
function validateWebSocketUrl(url) {
  if (!url || url.trim() === "") {
    return { valid: false, error: "Stream URL is required" };
  }
  if (url.includes("{{")) {
    return { valid: true, error: null };
  }
  const wsUrlPattern =
    /^(ws|wss):\/\/(([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?(\/.*)?$/i;
  if (!wsUrlPattern.test(url)) {
    return {
      valid: false,
      error:
        "Stream URL must be in format ws://domain.com/path or wss://domain.com/path",
    };
  }
  return { valid: true, error: null };
}

const TELNYX_STT_PROVIDER_OPTIONS = Object.values(AI_STREAMING_PROVIDERS)
  .filter((provider) => provider.type === "telnyx-stt")
  .map((provider) => ({ value: provider.id, label: provider.label }));

const PROVIDER_OPTIONS = [
  { value: "custom", label: "Custom" },
  { value: "google-gemini", label: "Google Gemini Live" },
  { value: "openai-realtime", label: "OpenAI Realtime" },
  { value: "azure-transcription", label: "Azure Transcription + Translation" },
  ...TELNYX_STT_PROVIDER_OPTIONS,
];

const STREAM_TRACK_OPTIONS = [
  { value: "inbound_track", label: "Inbound Track" },
  { value: "outbound_track", label: "Outbound Track" },
  { value: "both_tracks", label: "Both Tracks" },
];

const TELNYX_STT_TRACK_OPTIONS = [
  { value: "inbound", label: "Inbound — customer leg only" },
  { value: "outbound", label: "Outbound — agent leg only" },
  { value: "both", label: "Both — customer + agent legs" },
];

const CODEC_OPTIONS = [
  { value: "PCMU", label: "PCMU (G.711 μ-law)" },
  { value: "PCMA", label: "PCMA (G.711 A-law)" },
  { value: "G722", label: "G722" },
  { value: "OPUS", label: "OPUS" },
  { value: "AMR-WB", label: "AMR-WB" },
  { value: "L16", label: "L16 (Linear PCM)" },
  { value: "default", label: "Default (from call)" },
];

const BIDIRECTIONAL_MODE_OPTIONS = [
  { value: "mp3", label: "MP3" },
  { value: "rtp", label: "RTP" },
];

const SAMPLING_RATE_OPTIONS = [
  { value: 8000, label: "8000 Hz" },
  { value: 16000, label: "16000 Hz" },
  { value: 22050, label: "22050 Hz" },
  { value: 24000, label: "24000 Hz" },
  { value: 48000, label: "48000 Hz" },
];

const TARGET_LEGS_OPTIONS = [
  { value: "both", label: "Both" },
  { value: "self", label: "Self" },
  { value: "opposite", label: "Opposite" },
];

// OpenAI voice options
const OPENAI_VOICE_OPTIONS = [
  { value: "alloy", label: "Alloy" },
  { value: "ash", label: "Ash" },
  { value: "ballad", label: "Ballad" },
  { value: "coral", label: "Coral" },
  { value: "echo", label: "Echo" },
  { value: "fable", label: "Fable" },
  { value: "nova", label: "Nova" },
  { value: "onyx", label: "Onyx" },
  { value: "sage", label: "Sage" },
  { value: "shimmer", label: "Shimmer" },
  { value: "verse", label: "Verse" },
];

const OPENAI_TRANSCRIPTION_OPTIONS = [
  { value: "gpt-4o-transcribe", label: "GPT-4o Transcribe" },
  { value: "gpt-4o-mini-transcribe", label: "GPT-4o Mini Transcribe" },
  { value: "whisper-1", label: "Whisper-1" },
];

const OPENAI_TURN_DETECTION_OPTIONS = [
  { value: "server_vad", label: "Server VAD" },
  { value: "semantic_vad", label: "Semantic VAD" },
  { value: "none", label: "None" },
];

// Gemini voice options
const GEMINI_VOICE_OPTIONS = [
  { value: "Puck", label: "Puck" },
  { value: "Charon", label: "Charon" },
  { value: "Kore", label: "Kore" },
  { value: "Fenrir", label: "Fenrir" },
  { value: "Aoede", label: "Aoede" },
];

const GEMINI_MODEL_OPTIONS = [
  { value: "gemini-2.5-flash-native-audio-latest", label: "Gemini 2.5 Flash Native Audio" },
  { value: "gemini-2.5-flash-native-audio-preview-12-2025", label: "Gemini 2.5 Flash Native Audio (Dec 2025)" },
  { value: "gemini-2.5-flash-native-audio-preview-09-2025", label: "Gemini 2.5 Flash Native Audio (Sep 2025)" },
];

const EXPERIMENTAL_USER = "leszek@telnyx.com";
const EXPERIMENTAL_PROVIDERS = ["azure-transcription"];

export default function StreamingStartNodeEditor({ config = {}, onChange, currentUserEmail }) {
  const isExperimentalUser = currentUserEmail === EXPERIMENTAL_USER;
  const [provider, setProvider] = useState(
    config.ai_streaming_provider || "custom"
  );
  const [streamUrlError, setStreamUrlError] = useState(null);
  const [wsBaseUrl, setWsBaseUrl] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const isCustom = provider === "custom";
  const isOpenAI = provider === "openai-realtime";
  const isGemini = provider === "google-gemini";
  const isAzure = provider === "azure-transcription";
  const providerConfig = AI_STREAMING_PROVIDERS[provider];
  const isTelnyxStt = providerConfig?.type === "telnyx-stt";
  const isAI = isOpenAI || isGemini; // AI providers with session config
  const isLocked = !isCustom;

  // Fetch WS base URL from streaming capabilities endpoint
  useEffect(() => {
    fetch("/api/voice/streaming/capabilities")
      .then((r) => r.json())
      .then((data) => {
        if (data.wsUrl) {
          setWsBaseUrl(data.wsUrl.replace(/\/$/, ""));
        } else if (data.wsPort) {
          const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
          setWsBaseUrl(`${protocol}//${window.location.hostname}:${data.wsPort}`);
        }
      })
      .catch(() => {
        // Fallback: build from NEXT_PUBLIC_STREAMING_PORT or port+1
        if (typeof window !== "undefined") {
          const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
          const mainPort = parseInt(
            window.location.port || (window.location.protocol === "https:" ? "443" : "80"),
            10
          );
          const wsPort = process.env.NEXT_PUBLIC_STREAMING_PORT || String(mainPort + 1);
          setWsBaseUrl(`${protocol}//${window.location.hostname}:${wsPort}`);
        }
      });
  }, []);

  const getWebSocketUrl = (providerPath) => {
    if (wsBaseUrl) return `${wsBaseUrl}/streaming/${providerPath}`;
    if (typeof window === "undefined") {
      const port = process.env.NEXT_PUBLIC_STREAMING_PORT || "3001";
      return `wss://yourdomain.com:${port}/streaming/${providerPath}`;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const mainPort = parseInt(
      window.location.port || (window.location.protocol === "https:" ? "443" : "80"),
      10
    );
    const wsPort = process.env.NEXT_PUBLIC_STREAMING_PORT || String(mainPort + 1);
    return `${protocol}//${window.location.hostname}:${wsPort}/streaming/${providerPath}`;
  };

  // Update configuration when provider changes
  useEffect(() => {
    if (isCustom) {
      if (config.stream_url) {
        const validation = validateWebSocketUrl(config.stream_url);
        setStreamUrlError(validation.valid ? null : validation.error);
      }
      return;
    }

    const providerConfig = AI_STREAMING_PROVIDERS[provider];
    if (!providerConfig) return;

    if (isAzure) {
      const streamUrl = getWebSocketUrl("azure");
      const newConfig = {
        ...config,
        ai_streaming_provider: provider,
        stream_url: streamUrl,
        ...providerConfig.telnyx,
      };
      setStreamUrlError(null);
      onChange?.(newConfig);
    } else if (isTelnyxStt) {
      const streamUrl = getWebSocketUrl("telnyx-stt");
      const validation = validateWebSocketUrl(streamUrl);
      const newConfig = {
        ...config,
        ai_streaming_provider: provider,
        stream_url: streamUrl,
        ...providerConfig.telnyx,
      };
      setStreamUrlError(validation.valid ? null : validation.error);
      onChange?.(newConfig);
    } else {
      const wsProvider = isGemini ? "google" : "openai";
      const streamUrl = getWebSocketUrl(wsProvider);
      const validation = validateWebSocketUrl(streamUrl);
      setStreamUrlError(validation.valid ? null : validation.error);
      const newConfig = {
        ...config,
        ai_streaming_provider: provider,
        stream_url: streamUrl,
        ...providerConfig.telnyx,
      };
      onChange?.(newConfig);
    }
  }, [provider, wsBaseUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Validate stream URL
  useEffect(() => {
    if (config.stream_url && isCustom) {
      const validation = validateWebSocketUrl(config.stream_url);
      setStreamUrlError(validation.valid ? null : validation.error);
    } else {
      setStreamUrlError(null);
    }
  }, [config.stream_url, isCustom]);

  // Sync provider from config
  useEffect(() => {
    if (config.ai_streaming_provider && config.ai_streaming_provider !== provider) {
      setProvider(config.ai_streaming_provider);
    }
  }, [config.ai_streaming_provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleProviderChange = (newProvider) => {
    setProvider(newProvider);
    if (newProvider === "custom") {
      onChange?.({ ...config, ai_streaming_provider: "custom" });
    }
  };

  const handleFieldChange = (field, value) => {
    const newConfig = { ...config, [field]: value };
    if (field === "stream_url" && isCustom) {
      const validation = validateWebSocketUrl(value);
      setStreamUrlError(validation.valid ? null : validation.error);
    }
    onChange?.(newConfig);
  };

  // Helper for select fields
  const renderSelect = (field, label, options, defaultValue, opts = {}) => (
    <div>
      <Label className="flex items-center gap-2">
        {label}
        {opts.locked && <IconLock className="w-3 h-3 text-muted-foreground" />}
      </Label>
      <Select
        value={String(config[field] ?? defaultValue)}
        onValueChange={(value) => handleFieldChange(field, value)}
        disabled={opts.disabled}
      >
        <SelectTrigger className="w-full mt-1">
          <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={String(opt.value)}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {opts.description && (
        <p className="text-xs text-muted-foreground mt-1">{opts.description}</p>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Provider Selection */}
      <div>
        <Label>
          Provider <span className="text-red-500">*</span>
        </Label>
        <Select value={provider} onValueChange={handleProviderChange}>
          <SelectTrigger className="w-full mt-1">
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_OPTIONS.filter(
              (opt) =>
                !EXPERIMENTAL_PROVIDERS.includes(opt.value) || isExperimentalUser
            ).map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          Select a provider or choose Custom for manual configuration
        </p>
      </div>

      {/* Auto-configuration notice for AI providers */}
      {isLocked && !isAzure && !isTelnyxStt && (
        <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-950 rounded-md border border-blue-200 dark:border-blue-800">
          <IconInfoCircle className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-blue-700 dark:text-blue-300">
            <strong>
              Auto-configured for{" "}
              {PROVIDER_OPTIONS.find((p) => p.value === provider)?.label}
            </strong>
            <p className="mt-1">
              Stream settings are automatically configured. AI session parameters
              can be customized below.
            </p>
          </div>
        </div>
      )}

      {/* ====== AI Session Configuration (Google / OpenAI) ====== */}
      {isAI && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 pt-2 border-t">
            <IconBrain className="w-4 h-4 text-purple-500" />
            <span className="text-sm font-medium">AI Session Configuration</span>
          </div>

          {/* Common: Instructions */}
          <div>
            <Label>AI Instructions</Label>
            <Textarea
              value={config.ai_instructions || ""}
              onChange={(e) => handleFieldChange("ai_instructions", e.target.value)}
              placeholder="System instructions for the AI assistant..."
              rows={4}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              System instructions for the AI assistant. Leave empty for default.
            </p>
          </div>

          {/* Common: Greeting Prompt */}
          <div>
            <Label>Greeting Prompt</Label>
            <Textarea
              value={config.ai_greeting_prompt || ""}
              onChange={(e) => handleFieldChange("ai_greeting_prompt", e.target.value)}
              placeholder="Please greet the caller and ask how you can help..."
              rows={2}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              What the AI should say when greeting the caller
            </p>
          </div>

          {/* Common: Temperature */}
          <div>
            <Label>Temperature</Label>
            <Input
              type="number"
              value={config.ai_temperature ?? 0.8}
              onChange={(e) =>
                handleFieldChange("ai_temperature", parseFloat(e.target.value) || 0)
              }
              min={0}
              max={2}
              step={0.1}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Controls randomness (0.0–2.0)
            </p>
          </div>

          {/* === OpenAI-specific === */}
          {isOpenAI && (
            <div className="space-y-4">
              {renderSelect("ai_voice_openai", "Voice", OPENAI_VOICE_OPTIONS, "alloy", {
                description: "OpenAI voice for audio output",
              })}

              {renderSelect(
                "ai_transcription_model",
                "Transcription Model",
                OPENAI_TRANSCRIPTION_OPTIONS,
                "gpt-4o-transcribe",
                { description: "Model used for input audio transcription" }
              )}

              {renderSelect(
                "ai_turn_detection_type",
                "Turn Detection",
                OPENAI_TURN_DETECTION_OPTIONS,
                "server_vad",
                { description: "Voice activity detection mode" }
              )}

              <div>
                <Label>Language Code</Label>
                <Input
                  type="text"
                  value={config.ai_language_code || ""}
                  onChange={(e) => handleFieldChange("ai_language_code", e.target.value)}
                  placeholder="e.g. en-US, pl-PL"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  BCP-47 language code — forces response language and transcription (leave empty for auto-detect)
                </p>
              </div>

              {/* Advanced OpenAI Settings */}
              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                  {advancedOpen ? (
                    <IconChevronDown className="w-4 h-4" />
                  ) : (
                    <IconChevronRight className="w-4 h-4" />
                  )}
                  <IconSettings className="w-4 h-4" />
                  Advanced Settings
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-4 mt-3">
                  <div>
                    <Label>VAD Threshold</Label>
                    <Input
                      type="number"
                      value={config.ai_vad_threshold ?? 0.5}
                      onChange={(e) =>
                        handleFieldChange("ai_vad_threshold", parseFloat(e.target.value) || 0)
                      }
                      min={0}
                      max={1}
                      step={0.05}
                      className="mt-1"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Voice activity detection threshold (0.0–1.0)
                    </p>
                  </div>

                  <div>
                    <Label>Silence Duration (ms)</Label>
                    <Input
                      type="number"
                      value={config.ai_vad_silence_ms ?? 500}
                      onChange={(e) =>
                        handleFieldChange("ai_vad_silence_ms", parseInt(e.target.value) || 0)
                      }
                      min={0}
                      step={50}
                      className="mt-1"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Silence duration before end of speech
                    </p>
                  </div>

                  <div>
                    <Label>Prefix Padding (ms)</Label>
                    <Input
                      type="number"
                      value={config.ai_vad_prefix_padding_ms ?? 300}
                      onChange={(e) =>
                        handleFieldChange(
                          "ai_vad_prefix_padding_ms",
                          parseInt(e.target.value) || 0
                        )
                      }
                      min={0}
                      step={50}
                      className="mt-1"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Audio padding before speech start
                    </p>
                  </div>

                  <div>
                    <Label>Max Output Tokens</Label>
                    <Input
                      type="text"
                      value={config.ai_max_output_tokens ?? "inf"}
                      onChange={(e) =>
                        handleFieldChange("ai_max_output_tokens", e.target.value)
                      }
                      placeholder="inf"
                      className="mt-1"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Maximum output tokens (or &quot;inf&quot; for unlimited)
                    </p>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}

          {/* === Gemini-specific === */}
          {isGemini && (
            <div className="space-y-4">
              {renderSelect(
                "ai_gemini_model",
                "Model",
                GEMINI_MODEL_OPTIONS,
                "gemini-2.5-flash-native-audio-latest",
                { description: "Gemini model to use" }
              )}

              {renderSelect("ai_voice_gemini", "Voice", GEMINI_VOICE_OPTIONS, "Puck", {
                description: "Gemini voice for audio output",
              })}

              <div>
                <Label>Language Code</Label>
                <Input
                  type="text"
                  value={config.ai_language_code || ""}
                  onChange={(e) => handleFieldChange("ai_language_code", e.target.value)}
                  placeholder="e.g. en-US, pl-PL"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  BCP-47 language code (leave empty for auto-detect)
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ====== Azure Transcription + Translation ====== */}
      {isAzure && (
        <div className="space-y-4">
          <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-950 rounded-md border border-blue-200 dark:border-blue-800">
            <IconMicrophone className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-blue-700 dark:text-blue-300">
              <strong>Azure Cognitive Services Speech</strong>
              <p className="mt-1">
                Real-time transcription for both call legs (caller + agent).
                Transcription starts when the agent answers the call.
              </p>
            </div>
          </div>

          {/* Enable Translation toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Enable Translation</Label>
              <p className="text-xs text-muted-foreground">
                Translate transcriptions in real-time using Azure Speech Translation
              </p>
            </div>
            <Switch
              checked={config.azure_translation_enabled === true}
              onCheckedChange={(checked) =>
                handleFieldChange("azure_translation_enabled", checked)
              }
            />
          </div>

          {/* Source Language */}
          <div>
            <Label>
              Source Language{" "}
              <span className="text-muted-foreground font-normal">(required for transcription)</span>
            </Label>
            <Input
              type="text"
              value={config.azure_source_language || ""}
              onChange={(e) =>
                handleFieldChange("azure_source_language", e.target.value)
              }
              placeholder="e.g. en-US, pl-PL, de-DE, fr-FR"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Language spoken by the caller. Use BCP-47 format (e.g. en-US, pl-PL). Default: en-US.
            </p>
          </div>

          {/* Target Language (shown when translation enabled) */}
          {config.azure_translation_enabled === true && (
            <div>
              <Label>
                Target Language{" "}
                <span className="text-muted-foreground font-normal">(translation target)</span>
              </Label>
              <Input
                type="text"
                value={config.azure_target_language || ""}
                onChange={(e) =>
                  handleFieldChange("azure_target_language", e.target.value)
                }
                placeholder="e.g. en, pl, de, fr"
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Language to translate into.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ====== Telnyx Standalone STT WebSocket ====== */}
      {isTelnyxStt && (
        <div className="space-y-4">
          <div className="flex items-start gap-2 p-3 bg-emerald-50 dark:bg-emerald-950 rounded-md border border-emerald-200 dark:border-emerald-800">
            <IconMicrophone className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-emerald-700 dark:text-emerald-300">
              <strong>{providerConfig?.label}</strong>
              <p className="mt-1">
                Native telco transcription via Telnyx Speech-to-Text WebSocket.
                Each selected call leg gets its own Telnyx media stream and STT WebSocket using raw PCMU/mulaw @ 8 kHz.
              </p>
              <p className="mt-1 font-mono">
                {providerConfig?.telnyxStt?.transcription_engine} / {providerConfig?.telnyxStt?.model}
              </p>
            </div>
          </div>

          {renderSelect(
            "telnyx_stt_tracks",
            "Transcription Channels",
            TELNYX_STT_TRACK_OPTIONS,
            providerConfig?.telnyxStt?.transcription_tracks || "both",
            {
              description:
                "Inbound starts the customer-leg stream. Outbound starts the agent-leg stream after the agent answers. Both starts one stream per leg.",
            }
          )}
        </div>
      )}

      {/* ====== Custom: Telnyx Streaming Parameters ====== */}
      {isCustom && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 pt-2 border-t">
            <IconSettings className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">Telnyx Streaming Parameters</span>
          </div>

          {/* Stream URL */}
          <div>
            <Label className="flex items-center gap-2">
              Stream URL <span className="text-red-500">*</span>
              {streamUrlError && (
                <IconAlertTriangle className="h-4 w-4 text-destructive" />
              )}
            </Label>
            <Input
              type="text"
              value={config.stream_url || ""}
              onChange={(e) => handleFieldChange("stream_url", e.target.value)}
              placeholder="wss://www.example.com/websocket"
              className={`mt-1 ${streamUrlError ? "border-destructive" : ""}`}
            />
            {streamUrlError && (
              <p className="text-xs text-destructive mt-1">{streamUrlError}</p>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              The destination WebSocket address
            </p>
          </div>

          {renderSelect("stream_track", "Stream Track", STREAM_TRACK_OPTIONS, "inbound_track", {
            description: "Specifies which track should be streamed",
          })}

          {renderSelect("stream_codec", "Stream Codec", CODEC_OPTIONS, "default", {
            description: "Codec to be used for the streamed audio",
          })}

          {renderSelect(
            "stream_bidirectional_mode",
            "Bidirectional Stream Mode",
            BIDIRECTIONAL_MODE_OPTIONS,
            "mp3",
            { description: "Method of bidirectional streaming" }
          )}

          {renderSelect(
            "stream_bidirectional_codec",
            "Bidirectional Stream Codec",
            CODEC_OPTIONS.filter((opt) => opt.value !== "default"),
            "PCMU",
            { description: "Codec for bidirectional RTP streaming" }
          )}

          {renderSelect(
            "stream_bidirectional_target_legs",
            "Bidirectional Stream Target Legs",
            TARGET_LEGS_OPTIONS,
            "opposite",
            { description: "Call legs to receive the bidirectional stream audio" }
          )}

          {renderSelect(
            "stream_bidirectional_sampling_rate",
            "Bidirectional Stream Sampling Rate",
            SAMPLING_RATE_OPTIONS.map((o) => ({ ...o, value: String(o.value) })),
            "8000",
            { description: "Audio sampling rate in Hz" }
          )}
        </div>
      )}

      {/* Show stream URL (read-only) for AI + Azure + Telnyx STT providers */}
      {(isAI || isAzure || isTelnyxStt) && (
        <div className="space-y-4 pt-2 border-t">
          <div>
            <Label className="flex items-center gap-2">
              Stream URL
              <IconLock className="w-3 h-3 text-muted-foreground" />
            </Label>
            <Input
              type="text"
              value={config.stream_url || ""}
              className="mt-1"
              readOnly
            />
            <p className="text-xs text-muted-foreground mt-1">
              Auto-configured WebSocket URL for{" "}
              {isOpenAI ? "OpenAI" : isGemini ? "Gemini" : isAzure ? "Azure" : "Telnyx STT"} streaming
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
