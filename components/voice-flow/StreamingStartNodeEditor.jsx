"use client";

import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  IconLock,
  IconInfoCircle,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { AI_STREAMING_PROVIDERS } from "@/config/ai-streaming-providers";

// Validate WebSocket URL format (ws:// or wss://)
function validateWebSocketUrl(url) {
  if (!url || url.trim() === "") {
    return { valid: false, error: "Stream URL is required" };
  }

  // Check if URL contains variables (allow those)
  if (url.includes("{{")) {
    return { valid: true, error: null };
  }

  // Validate WebSocket URL format: ws://domain.com/path or wss://domain.com/path
  // Must have a proper domain (with TLD) or IP address
  const wsUrlPattern =
    /^(ws|wss):\/\/(([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?(\/.*)?$/i;

  if (!wsUrlPattern.test(url)) {
    return {
      valid: false,
      error:
        "Stream URL must be in format ws://domain.com/path or wss://domain.com/path (must include a valid domain or IP address)",
    };
  }

  return { valid: true, error: null };
}

const PROVIDER_OPTIONS = [
  { value: "custom", label: "Custom" },
  { value: "google-gemini", label: "Google Gemini Live" },
  { value: "openai-realtime", label: "OpenAI Realtime" },
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

  // Get the base URL for WebSocket connections
  const getWebSocketUrl = (providerId) => {
    if (typeof window === "undefined") {
      return `wss://yourdomain.com/api/voice/streaming/ws/${providerId}`;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    return `${protocol}//${host}/api/voice/streaming/ws/${providerId}`;
  };

  // Update configuration when provider changes
  useEffect(() => {
    if (provider === "custom") {
      // Don't override existing custom config
      // Validate existing URL if present
      if (config.stream_url) {
        const validation = validateWebSocketUrl(config.stream_url);
        setStreamUrlError(validation.valid ? null : validation.error);
      }
      return;
    }

    // Get provider configuration
    const providerConfig = AI_STREAMING_PROVIDERS[provider];
    if (!providerConfig) {
      console.error(`Provider config not found: ${provider}`);
      return;
    }

    // Build WebSocket URL based on provider
    const wsProvider = provider === "google-gemini" ? "google" : "openai";
    const streamUrl = getWebSocketUrl(wsProvider);

    // Validate the auto-generated URL
    const validation = validateWebSocketUrl(streamUrl);
    setStreamUrlError(validation.valid ? null : validation.error);

    // Apply provider-specific Telnyx configuration
    const newConfig = {
      ...config,
      ai_streaming_provider: provider,
      stream_url: streamUrl,
      ...providerConfig.telnyx,
    };

    onChange?.(newConfig);
  }, [provider]);

  // Validate stream URL when it changes
  useEffect(() => {
    if (config.stream_url) {
      const validation = validateWebSocketUrl(config.stream_url);
      setStreamUrlError(validation.valid ? null : validation.error);
    } else {
      setStreamUrlError(null);
    }
  }, [config.stream_url]);

  // Sync provider from config changes
  useEffect(() => {
    if (
      config.ai_streaming_provider &&
      config.ai_streaming_provider !== provider
    ) {
      setProvider(config.ai_streaming_provider);
    }
  }, [config.ai_streaming_provider]);

  const handleProviderChange = (newProvider) => {
    setProvider(newProvider);

    if (newProvider === "custom") {
      // Just update the provider field, keep other settings
      onChange?.({
        ...config,
        ai_streaming_provider: "custom",
      });
    }
  };

  const handleFieldChange = (field, value) => {
    const newConfig = {
      ...config,
      [field]: value,
    };

    // Validate stream URL when it changes
    if (field === "stream_url") {
      const validation = validateWebSocketUrl(value);
      setStreamUrlError(validation.valid ? null : validation.error);
    }

    onChange?.(newConfig);
  };

  const isLocked = provider !== "custom";

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

      {/* Auto-configuration notice */}
      {isLocked && (
        <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-950 rounded-md border border-blue-200 dark:border-blue-800">
          <IconInfoCircle className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-blue-700 dark:text-blue-300">
            <strong>
              Auto-configured for{" "}
              {PROVIDER_OPTIONS.find((p) => p.value === provider)?.label}
            </strong>
            <p className="mt-1">
              Stream settings are automatically configured for optimal
              performance with this provider. Select "Custom" to modify settings
              manually.
            </p>
          </div>
        </div>
      )}

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
    </div>
  );
}
