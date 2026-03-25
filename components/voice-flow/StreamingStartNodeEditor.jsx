"use client";

import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconLock,
  IconInfoCircle,
  IconAlertTriangle,
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

const PROVIDER_OPTIONS = [
  { value: "custom", label: "Custom" },
  { value: "google-gemini", label: "Google Gemini Live" },
  { value: "openai-realtime", label: "OpenAI Realtime" },
  { value: "azure-transcription", label: "Azure Transcription + Translation" },
];

const STREAM_TRACK_OPTIONS = [
  { value: "inbound_track", label: "Inbound Track" },
  { value: "outbound_track", label: "Outbound Track" },
  { value: "both_tracks", label: "Both Tracks" },
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

export default function StreamingStartNodeEditor({ config = {}, onChange }) {
  const [provider, setProvider] = useState(
    config.ai_streaming_provider || "custom"
  );
  const [streamUrlError, setStreamUrlError] = useState(null);

  const isAzure = provider === "azure-transcription";
  const isAIProvider = provider !== "custom";
  const isLocked = isAIProvider; // Non-custom fields are locked

  // Get the base WebSocket URL for AI providers (port 3001)
  const getStreamingWSUrl = (providerPath) => {
    if (typeof window === "undefined") {
      return `wss://yourdomain.com:3001/streaming/${providerPath}`;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const hostname = window.location.hostname;
    const port = 3001; // Streaming WS server runs on main + 1
    return `${protocol}//${hostname}:${port}/streaming/${providerPath}`;
  };

  // Update configuration when provider changes
  useEffect(() => {
    if (provider === "custom") {
      if (config.stream_url) {
        const validation = validateWebSocketUrl(config.stream_url);
        setStreamUrlError(validation.valid ? null : validation.error);
      }
      return;
    }

    const providerConfig = AI_STREAMING_PROVIDERS[provider];
    if (!providerConfig) return;

    if (provider === "azure-transcription") {
      // Azure: point to our port-3001 streaming server
      const streamUrl = getStreamingWSUrl("azure");
      const newConfig = {
        ...config,
        ai_streaming_provider: provider,
        stream_url: streamUrl,
        ...providerConfig.telnyx,
      };
      setStreamUrlError(null);
      onChange?.(newConfig);
    } else {
      // Google / OpenAI: same port-3001 streaming server
      const wsProvider = provider === "google-gemini" ? "google" : "openai";
      const streamUrl = getStreamingWSUrl(wsProvider);
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
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  // Validate stream URL when it changes
  useEffect(() => {
    if (config.stream_url && !isAzure) {
      const validation = validateWebSocketUrl(config.stream_url);
      setStreamUrlError(validation.valid ? null : validation.error);
    } else {
      setStreamUrlError(null);
    }
  }, [config.stream_url, isAzure]);

  // Sync provider from config changes
  useEffect(() => {
    if (
      config.ai_streaming_provider &&
      config.ai_streaming_provider !== provider
    ) {
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
    if (field === "stream_url" && !isAzure) {
      const validation = validateWebSocketUrl(value);
      setStreamUrlError(validation.valid ? null : validation.error);
    }
    onChange?.(newConfig);
  };

  return (
    <div className="space-y-4">
      {/* AI Provider Selection */}
      <div>
        <Label>
          AI Provider <span className="text-red-500">*</span>
        </Label>
        <Select value={provider} onValueChange={handleProviderChange}>
          <SelectTrigger className="w-full mt-1">
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          Select an AI provider or choose Custom for manual configuration
        </p>
      </div>

      {/* Auto-configuration notice for non-Azure providers */}
      {isAIProvider && !isAzure && (
        <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-950 rounded-md border border-blue-200 dark:border-blue-800">
          <IconInfoCircle className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-blue-700 dark:text-blue-300">
            <strong>
              Auto-configured for{" "}
              {PROVIDER_OPTIONS.find((p) => p.value === provider)?.label}
            </strong>
            <p className="mt-1">
              Stream settings are automatically configured for optimal
              performance with this provider. Select &quot;Custom&quot; to modify settings
              manually.
            </p>
          </div>
        </div>
      )}

      {/* ── Azure Transcription + Translation section ── */}
      {isAzure && (
        <div className="space-y-4">
          {/* Azure info banner */}
          <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-950 rounded-md border border-blue-200 dark:border-blue-800">
            <IconMicrophone className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-blue-700 dark:text-blue-300">
              <strong>Azure Cognitive Services Speech</strong>
              <p className="mt-1">
                Real-time transcription and translation for both call legs via Azure Speech SDK.
                Audio is automatically streamed to the port-3001 streaming server.
                Transcription starts when the agent answers the call.
              </p>
            </div>
          </div>

          {/* Stream URL (read-only for Azure) */}
          <div>
            <Label className="flex items-center gap-2">
              Stream URL
              <IconLock className="w-3 h-3 text-muted-foreground" />
            </Label>
            <Input
              type="text"
              value={config.stream_url || getStreamingWSUrl("azure")}
              readOnly
              className="mt-1 bg-muted text-muted-foreground text-xs"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Auto-configured to the Azure streaming endpoint on port 3001
            </p>
          </div>

          {/* Stream Track (locked to both_tracks) */}
          <div>
            <Label className="flex items-center gap-2">
              Stream Track
              <IconLock className="w-3 h-3 text-muted-foreground" />
            </Label>
            <Input
              type="text"
              value="Both Tracks (inbound + outbound)"
              readOnly
              className="mt-1 bg-muted text-muted-foreground text-xs"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Both call legs are streamed — required for full transcription of caller and agent
            </p>
          </div>

          {/* Azure Region */}
          <div>
            <Label>Azure Region</Label>
            <Input
              type="text"
              value={config.azure_region || ""}
              onChange={(e) => handleFieldChange("azure_region", e.target.value)}
              placeholder="eastus"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Azure Cognitive Services region (e.g. eastus, westeurope, eastasia)
            </p>
          </div>

          {/* Azure API Key */}
          <div>
            <Label>Azure API Key</Label>
            <Input
              type="password"
              value={config.azure_api_key || ""}
              onChange={(e) => handleFieldChange("azure_api_key", e.target.value)}
              placeholder="Your Azure Cognitive Services subscription key"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Azure Cognitive Services subscription key for Speech services
            </p>
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

          {/* Target Language (shown when translation enabled) */}
          {config.azure_translation_enabled === true && (
            <div>
              <Label>Target Language</Label>
              <Input
                type="text"
                value={config.azure_target_language || ""}
                onChange={(e) =>
                  handleFieldChange("azure_target_language", e.target.value)
                }
                placeholder="en"
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Target language code for translation (e.g. en, pl, de, fr, es)
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Standard streaming fields (hidden for Azure) ── */}
      {!isAzure && (
        <>
          {/* Stream URL */}
          <div>
            <Label className="flex items-center gap-2">
              Stream URL <span className="text-red-500">*</span>
              {streamUrlError && (
                <IconAlertTriangle className="h-4 w-4 text-destructive" />
              )}
              {isLocked && <IconLock className="w-3 h-3 text-muted-foreground" />}
            </Label>
            <Input
              type="text"
              value={config.stream_url || ""}
              onChange={(e) => handleFieldChange("stream_url", e.target.value)}
              placeholder="wss://www.example.com/websocket"
              className={`mt-1 ${streamUrlError ? "border-destructive" : ""}`}
              readOnly={isLocked}
            />
            {streamUrlError && (
              <p className="text-xs text-destructive mt-1">{streamUrlError}</p>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              The destination WebSocket address
            </p>
          </div>

          {/* Stream Track */}
          <div>
            <Label className="flex items-center gap-2">
              Stream Track
              {isLocked && <IconLock className="w-3 h-3 text-muted-foreground" />}
            </Label>
            <Select
              value={config.stream_track || "inbound_track"}
              onValueChange={(value) => handleFieldChange("stream_track", value)}
              disabled={isLocked}
            >
              <SelectTrigger className="w-full mt-1">
                <SelectValue placeholder="Select track" />
              </SelectTrigger>
              <SelectContent>
                {STREAM_TRACK_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Specifies which track should be streamed
            </p>
          </div>

          {/* Stream Codec */}
          <div>
            <Label className="flex items-center gap-2">
              Stream Codec
              {isLocked && <IconLock className="w-3 h-3 text-muted-foreground" />}
            </Label>
            <Select
              value={config.stream_codec || "default"}
              onValueChange={(value) => handleFieldChange("stream_codec", value)}
              disabled={isLocked}
            >
              <SelectTrigger className="w-full mt-1">
                <SelectValue placeholder="Select codec" />
              </SelectTrigger>
              <SelectContent>
                {CODEC_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Codec to be used for the streamed audio
            </p>
          </div>

          {/* Bidirectional Stream Mode */}
          <div>
            <Label className="flex items-center gap-2">
              Bidirectional Stream Mode
              {isLocked && <IconLock className="w-3 h-3 text-muted-foreground" />}
            </Label>
            <Select
              value={config.stream_bidirectional_mode || "mp3"}
              onValueChange={(value) =>
                handleFieldChange("stream_bidirectional_mode", value)
              }
              disabled={isLocked}
            >
              <SelectTrigger className="w-full mt-1">
                <SelectValue placeholder="Select mode" />
              </SelectTrigger>
              <SelectContent>
                {BIDIRECTIONAL_MODE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Method of bidirectional streaming
            </p>
          </div>

          {/* Bidirectional Stream Codec */}
          <div>
            <Label className="flex items-center gap-2">
              Bidirectional Stream Codec
              {isLocked && <IconLock className="w-3 h-3 text-muted-foreground" />}
            </Label>
            <Select
              value={config.stream_bidirectional_codec || "PCMU"}
              onValueChange={(value) =>
                handleFieldChange("stream_bidirectional_codec", value)
              }
              disabled={isLocked}
            >
              <SelectTrigger className="w-full mt-1">
                <SelectValue placeholder="Select codec" />
              </SelectTrigger>
              <SelectContent>
                {CODEC_OPTIONS.filter((opt) => opt.value !== "default").map(
                  (opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Codec for bidirectional RTP streaming
            </p>
          </div>

          {/* Bidirectional Stream Target Legs */}
          <div>
            <Label className="flex items-center gap-2">
              Bidirectional Stream Target Legs
              {isLocked && <IconLock className="w-3 h-3 text-muted-foreground" />}
            </Label>
            <Select
              value={config.stream_bidirectional_target_legs || "opposite"}
              onValueChange={(value) =>
                handleFieldChange("stream_bidirectional_target_legs", value)
              }
              disabled={isLocked}
            >
              <SelectTrigger className="w-full mt-1">
                <SelectValue placeholder="Select target" />
              </SelectTrigger>
              <SelectContent>
                {TARGET_LEGS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Call legs to receive the bidirectional stream audio
            </p>
          </div>

          {/* Bidirectional Stream Sampling Rate */}
          <div>
            <Label className="flex items-center gap-2">
              Bidirectional Stream Sampling Rate
              {isLocked && <IconLock className="w-3 h-3 text-muted-foreground" />}
            </Label>
            <Select
              value={String(config.stream_bidirectional_sampling_rate || 8000)}
              onValueChange={(value) =>
                handleFieldChange(
                  "stream_bidirectional_sampling_rate",
                  Number(value)
                )
              }
              disabled={isLocked}
            >
              <SelectTrigger className="w-full mt-1">
                <SelectValue placeholder="Select rate" />
              </SelectTrigger>
              <SelectContent>
                {SAMPLING_RATE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={String(opt.value)}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Audio sampling rate in Hz
            </p>
          </div>
        </>
      )}
    </div>
  );
}
