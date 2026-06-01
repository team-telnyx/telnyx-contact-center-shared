"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  IconTrash,
  IconPlus,
  IconChevronRight,
  IconAlertTriangle,
  IconMicrophone,
} from "@tabler/icons-react";
import { VariableInput } from "./VariableInput";
import TranscriptionNodeEditor from "./TranscriptionNodeEditor";
import { AI_STREAMING_PROVIDERS } from "@/config/ai-streaming-providers";

const SIP_HEADER_NAMES = ["User-to-User", "Diversion"];
const TELNYX_STT_PROVIDER_OPTION = { value: "telnyx-stt", label: "Telnyx Standalone STT" };
const EXPERIMENTAL_USER = "leszek@telnyx.com";
const EXPERIMENTAL_PROVIDERS = ["azure-transcription"];

const TELNYX_STT_MODEL_OPTIONS = Object.values(AI_STREAMING_PROVIDERS)
  .filter((provider) => provider.type === "telnyx-stt")
  .map((provider) => {
    const engine = String(provider.telnyxStt?.transcription_engine || "").toLowerCase();
    const model = provider.telnyxStt?.model || provider.id;
    const modelLabel = `${engine}/${model}`;
    return { value: provider.id, label: modelLabel, provider };
  });

const DEFAULT_TELNYX_STT_MODEL =
  TELNYX_STT_MODEL_OPTIONS[0]?.value || "telnyx-stt-google-phone-call";

const STREAMING_PROVIDER_OPTIONS = [
  { value: "custom", label: "Custom" },
  { value: "google-gemini", label: "Google Gemini Live" },
  { value: "openai-realtime", label: "OpenAI Realtime" },
  { value: "azure-transcription", label: "Azure Transcription + Translation" },
  TELNYX_STT_PROVIDER_OPTION,
];

function getStreamingProviderPath(provider) {
  if (provider === "google-gemini") return "google";
  if (provider === "openai-realtime") return "openai";
  if (provider === "azure-transcription") return "azure";
  if (provider === "telnyx-stt") return "telnyx-stt";
  return null;
}

const TELNYX_STT_TRACK_OPTIONS = [
  { value: "inbound", label: "Inbound — customer leg only" },
  { value: "outbound", label: "Outbound — agent leg only" },
  { value: "both", label: "Both — customer + agent legs" },
];


// Validate WebSocket URL format (ws:// or wss://)
function validateWebSocketUrl(url) {
  if (!url || url.trim() === "") {
    return { valid: true, error: null }; // Empty is valid (optional field)
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

export default function AnswerNodeEditor({
  config = {},
  onChange,
  availableVariables = [],
  onOutputsChange,
  currentUserEmail,
}) {
  const isExperimentalUser = currentUserEmail === EXPERIMENTAL_USER;
  // Basic fields
  const [billingGroupId, setBillingGroupId] = useState(
    config.billing_group_id || ""
  );
  const [clientState, setClientState] = useState(config.client_state || "");
  const [commandId, setCommandId] = useState(config.command_id || "");
  const [webhookUrl, setWebhookUrl] = useState(config.webhook_url || "");
  const [sendSilenceWhenIdle, setSendSilenceWhenIdle] = useState(
    config.send_silence_when_idle || false
  );

  // Recording
  const [record, setRecord] = useState(config.record || false);
  const [recordChannels, setRecordChannels] = useState(
    config.record_channels || ""
  );
  const [recordFormat, setRecordFormat] = useState(config.record_format || "");
  const [recordMaxLength, setRecordMaxLength] = useState(
    config.record_max_length || ""
  );
  const [recordTimeoutSecs, setRecordTimeoutSecs] = useState(
    config.record_timeout_secs || ""
  );
  const [recordTrack, setRecordTrack] = useState(config.record_track || "");
  const [recordTrim, setRecordTrim] = useState(config.record_trim || "");
  const [recordCustomFileName, setRecordCustomFileName] = useState(
    config.record_custom_file_name || ""
  );

  // SIP Headers
  const [sipHeaders, setSipHeaders] = useState(
    Array.isArray(config.sip_headers) ? config.sip_headers : []
  );

  // Custom Headers
  const [customHeaders, setCustomHeaders] = useState(
    Array.isArray(config.custom_headers) ? config.custom_headers : []
  );

  // Streaming
  const [streamUrl, setStreamUrl] = useState(config.stream_url || "");
  const [streamUrlError, setStreamUrlError] = useState(null);
  const [streamTrack, setStreamTrack] = useState(
    config.stream_track || "inbound_track"
  );
  const [streamCodec, setStreamCodec] = useState(config.stream_codec || "");
  const [streamBidirectionalMode, setStreamBidirectionalMode] = useState(
    config.stream_bidirectional_mode || "mp3"
  );
  const [streamBidirectionalCodec, setStreamBidirectionalCodec] = useState(
    config.stream_bidirectional_codec || "PCMU"
  );
  const [streamBidirectionalTargetLegs, setStreamBidirectionalTargetLegs] =
    useState(config.stream_bidirectional_target_legs || "opposite");
  const [streamBidirectionalSamplingRate, setStreamBidirectionalSamplingRate] =
    useState(config.stream_bidirectional_sampling_rate || 8000);
  const [
    streamEstablishBeforeCallOriginate,
    setStreamEstablishBeforeCallOriginate,
  ] = useState(config.stream_establish_before_call_originate || false);

  const initialStreamingProvider =
    config.ai_streaming_provider === "telnyx-stt" ||
    AI_STREAMING_PROVIDERS[config.ai_streaming_provider]?.type === "telnyx-stt"
      ? "telnyx-stt"
      : config.ai_streaming_provider || "custom";
  const initialTelnyxSttModel =
    config.telnyx_stt_model ||
    (AI_STREAMING_PROVIDERS[config.ai_streaming_provider]?.type === "telnyx-stt"
      ? config.ai_streaming_provider
      : DEFAULT_TELNYX_STT_MODEL);
  const [streamingProvider, setStreamingProvider] = useState(initialStreamingProvider);
  const [telnyxSttModel, setTelnyxSttModel] = useState(initialTelnyxSttModel);
  const [telnyxSttTracks, setTelnyxSttTracks] = useState(
    config.telnyx_stt_tracks || "both"
  );
  const [telnyxSttInterimResults, setTelnyxSttInterimResults] = useState(
    config.telnyx_stt_interim_results !== false
  );
  const [wsBaseUrl, setWsBaseUrl] = useState(null);
  const selectedTelnyxSttProvider = AI_STREAMING_PROVIDERS[telnyxSttModel];
  const selectedStreamingProvider =
    streamingProvider === "telnyx-stt"
      ? selectedTelnyxSttProvider
      : AI_STREAMING_PROVIDERS[streamingProvider];
  const isTelnyxSttStreaming = streamingProvider === "telnyx-stt";

  // Transcription
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(
    config.transcription_engine ? true : false
  );
  const [transcriptionEngine, setTranscriptionEngine] = useState(
    config.transcription_engine || "Google"
  );
  const [transcriptionEngineConfig, setTranscriptionEngineConfig] = useState(
    config.transcription_engine_config || {}
  );
  const [transcriptionTracks, setTranscriptionTracks] = useState(
    config.transcription_tracks || "inbound"
  );

  // Collapsible states
  const [recordingExpanded, setRecordingExpanded] = useState(false);
  const [headersExpanded, setHeadersExpanded] = useState(false);
  const [streamingExpanded, setStreamingExpanded] = useState(false);
  const [transcriptionExpanded, setTranscriptionExpanded] = useState(false);


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

  useEffect(() => {
    if (streamingProvider === "custom") return;
    const providerPath = getStreamingProviderPath(streamingProvider);
    if (!providerPath) return;
    const nextStreamUrl = getWebSocketUrl(providerPath);
    setStreamUrl(nextStreamUrl);
    setStreamTrack(selectedStreamingProvider?.telnyx?.stream_track || "inbound_track");
    setStreamCodec(
      selectedStreamingProvider?.telnyx?.stream_codec ||
        (isTelnyxSttStreaming ? "PCMU" : "")
    );
    const validation = validateWebSocketUrl(nextStreamUrl);
    setStreamUrlError(validation.valid ? null : validation.error);
  }, [streamingProvider, telnyxSttModel, wsBaseUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync state from config changes
  useEffect(() => {
    if (config.billing_group_id !== undefined)
      setBillingGroupId(config.billing_group_id);
    if (config.client_state !== undefined) setClientState(config.client_state);
    if (config.command_id !== undefined) setCommandId(config.command_id);
    if (config.webhook_url !== undefined) setWebhookUrl(config.webhook_url);
    if (config.send_silence_when_idle !== undefined)
      setSendSilenceWhenIdle(config.send_silence_when_idle);
    if (config.record !== undefined) {
      // Handle both boolean and string values for backward compatibility
      setRecord(
        config.record === true || config.record === "record-from-answer"
      );
    }
    if (config.record_channels !== undefined)
      setRecordChannels(config.record_channels);
    if (config.record_format !== undefined)
      setRecordFormat(config.record_format);
    if (config.record_max_length !== undefined)
      setRecordMaxLength(config.record_max_length);
    if (config.record_timeout_secs !== undefined)
      setRecordTimeoutSecs(config.record_timeout_secs);
    if (config.record_track !== undefined) setRecordTrack(config.record_track);
    if (config.record_trim !== undefined) setRecordTrim(config.record_trim);
    if (config.record_custom_file_name !== undefined)
      setRecordCustomFileName(config.record_custom_file_name);
    if (config.sip_headers !== undefined)
      setSipHeaders(
        Array.isArray(config.sip_headers) ? config.sip_headers : []
      );
    if (config.custom_headers !== undefined)
      setCustomHeaders(
        Array.isArray(config.custom_headers) ? config.custom_headers : []
      );
    if (config.stream_url !== undefined) {
      setStreamUrl(config.stream_url);
      const validation = validateWebSocketUrl(config.stream_url);
      setStreamUrlError(validation.valid ? null : validation.error);
    }
    if (config.stream_track !== undefined) setStreamTrack(config.stream_track);
    if (config.stream_codec !== undefined) setStreamCodec(config.stream_codec);
    if (config.stream_bidirectional_mode !== undefined)
      setStreamBidirectionalMode(config.stream_bidirectional_mode);
    if (config.stream_bidirectional_codec !== undefined)
      setStreamBidirectionalCodec(config.stream_bidirectional_codec);
    if (config.stream_bidirectional_target_legs !== undefined)
      setStreamBidirectionalTargetLegs(config.stream_bidirectional_target_legs);
    if (config.stream_bidirectional_sampling_rate !== undefined)
      setStreamBidirectionalSamplingRate(
        config.stream_bidirectional_sampling_rate
      );
    if (config.stream_establish_before_call_originate !== undefined)
      setStreamEstablishBeforeCallOriginate(
        config.stream_establish_before_call_originate
      );
    if (config.ai_streaming_provider !== undefined) {
      setStreamingProvider(
        config.ai_streaming_provider === "telnyx-stt" ||
        AI_STREAMING_PROVIDERS[config.ai_streaming_provider]?.type === "telnyx-stt"
          ? "telnyx-stt"
          : config.ai_streaming_provider || "custom"
      );
    }
    if (config.telnyx_stt_model !== undefined) setTelnyxSttModel(config.telnyx_stt_model);
    if (config.telnyx_stt_tracks !== undefined) setTelnyxSttTracks(config.telnyx_stt_tracks);
    if (config.telnyx_stt_interim_results !== undefined)
      setTelnyxSttInterimResults(config.telnyx_stt_interim_results !== false);
    if (config.transcription_engine !== undefined) {
      setTranscriptionEnabled(!!config.transcription_engine);
      setTranscriptionEngine(config.transcription_engine);
    }
    if (config.transcription_engine_config !== undefined)
      setTranscriptionEngineConfig(config.transcription_engine_config);
    if (config.transcription_tracks !== undefined)
      setTranscriptionTracks(config.transcription_tracks);
  }, [config]);

  const buildConfig = (
    currentSipHeaders = null,
    currentCustomHeaders = null
  ) => {
    const finalSipHeaders =
      currentSipHeaders !== null ? currentSipHeaders : sipHeaders;
    const finalCustomHeaders =
      currentCustomHeaders !== null ? currentCustomHeaders : customHeaders;

    return {
      billing_group_id: billingGroupId || undefined,
      client_state: clientState || undefined,
      command_id: commandId || undefined,
      webhook_url: webhookUrl || undefined,
      send_silence_when_idle: sendSilenceWhenIdle || undefined,
      record: record ? "record-from-answer" : undefined,
      record_channels: record ? recordChannels : undefined,
      record_format: record ? recordFormat : undefined,
      record_max_length: record
        ? recordMaxLength
          ? Number(recordMaxLength)
          : undefined
        : undefined,
      record_timeout_secs: record
        ? recordTimeoutSecs
          ? Number(recordTimeoutSecs)
          : undefined
        : undefined,
      record_track: record ? recordTrack : undefined,
      record_trim: record ? recordTrim : undefined,
      record_custom_file_name: record ? recordCustomFileName : undefined,
      // Keep all headers in config (don't filter incomplete ones)
      // The engine will filter them when sending to API
      sip_headers: finalSipHeaders.length > 0 ? finalSipHeaders : undefined,
      custom_headers:
        finalCustomHeaders.length > 0 ? finalCustomHeaders : undefined,
      // Streaming parameters
      stream_url: streamUrl || undefined,
      ai_streaming_provider: streamUrl ? streamingProvider : undefined,
      telnyx_stt_model: isTelnyxSttStreaming ? telnyxSttModel : undefined,
      telnyx_stt_tracks: isTelnyxSttStreaming ? telnyxSttTracks : undefined,
      telnyx_stt_interim_results: isTelnyxSttStreaming
        ? telnyxSttInterimResults
        : undefined,
      stream_track: streamUrl ? streamTrack : undefined,
      stream_codec: streamUrl && streamCodec ? streamCodec : undefined,
      stream_bidirectional_mode: streamUrl
        ? streamBidirectionalMode
        : undefined,
      stream_bidirectional_codec:
        streamUrl && streamBidirectionalMode === "rtp"
          ? streamBidirectionalCodec
          : undefined,
      stream_bidirectional_target_legs:
        streamUrl && streamBidirectionalMode
          ? streamBidirectionalTargetLegs
          : undefined,
      stream_bidirectional_sampling_rate:
        streamUrl && streamBidirectionalMode === "rtp"
          ? streamBidirectionalSamplingRate
          : undefined,
      stream_establish_before_call_originate: streamUrl
        ? streamEstablishBeforeCallOriginate
        : undefined,
      // Transcription parameters
      transcription_engine: transcriptionEnabled
        ? transcriptionEngine
        : undefined,
      transcription_engine_config:
        transcriptionEnabled &&
        Object.keys(transcriptionEngineConfig).length > 0
          ? transcriptionEngineConfig
          : undefined,
      transcription_tracks: transcriptionEnabled
        ? transcriptionTracks
        : undefined,
    };
  };

  const updateConfig = () => {
    const newConfig = buildConfig();
    onChange?.(newConfig);
  };

  const buildConfigWithTranscription = (nextTranscriptionConfig) => ({
    ...buildConfig(),
    transcription_engine: nextTranscriptionConfig.transcription_engine,
    transcription_engine_config:
      nextTranscriptionConfig.transcription_engine_config,
    transcription_tracks: nextTranscriptionConfig.transcription_tracks,
  });

  const handleSipHeaderChange = (index, field, value) => {
    if (field === "name") {
      // Check if this header type is already used by another header
      const isAlreadyUsed = sipHeaders.some(
        (h, i) => i !== index && h.name === value
      );
      if (isAlreadyUsed) {
        // Don't allow changing to a header type that's already in use
        return;
      }
    }
    const newHeaders = sipHeaders.map((h, i) =>
      i === index ? { ...h, [field]: value } : h
    );
    setSipHeaders(newHeaders);
    onChange?.(buildConfig(newHeaders, null));
  };

  const addSipHeader = () => {
    // Check which header types are already present
    const existingNames = sipHeaders.map((h) => h.name);
    const hasUserToUser = existingNames.includes("User-to-User");
    const hasDiversion = existingNames.includes("Diversion");

    // Don't add if both types are already present
    if (hasUserToUser && hasDiversion) {
      return;
    }

    // Add the missing type, or default to User-to-User if neither exists
    const newHeaderName = hasUserToUser ? "Diversion" : "User-to-User";
    const newHeaders = [...sipHeaders, { name: newHeaderName, value: "" }];
    setSipHeaders(newHeaders);
    onChange?.(buildConfig(newHeaders, null));
  };

  // Get available header types (not already in use)
  const getAvailableHeaderTypes = (currentIndex) => {
    const existingNames = sipHeaders
      .map((h, i) => (i !== currentIndex ? h.name : null))
      .filter(Boolean);
    return SIP_HEADER_NAMES.filter((name) => !existingNames.includes(name));
  };

  const removeSipHeader = (index) => {
    const newHeaders = sipHeaders.filter((_, i) => i !== index);
    setSipHeaders(newHeaders);
    onChange?.(buildConfig(newHeaders, null));
  };

  const handleCustomHeaderChange = (index, field, value) => {
    const newHeaders = customHeaders.map((h, i) =>
      i === index ? { ...h, [field]: value } : h
    );
    setCustomHeaders(newHeaders);
    onChange?.(buildConfig(null, newHeaders));
  };

  const addCustomHeader = () => {
    const newHeaders = [...customHeaders, { name: "", value: "" }];
    setCustomHeaders(newHeaders);
    onChange?.(buildConfig(null, newHeaders));
  };

  const removeCustomHeader = (index) => {
    const newHeaders = customHeaders.filter((_, i) => i !== index);
    setCustomHeaders(newHeaders);
    onChange?.(buildConfig(null, newHeaders));
  };

  // Calculate dynamic outputs based on recording, streaming, and transcription settings
  const calculateDynamicOutputs = useCallback(() => {
    const baseOutputs = ["Answered"];
    const baseEvents = ["call.answered"];
    const baseDescriptions = [
      "Triggered when call is answered (call.answered event)",
    ];

    // Recording exits (only if recording is enabled)
    const recordingOutputs = [];
    const recordingEvents = [];
    const recordingDescriptions = [];

    if (record) {
      recordingOutputs.push("Recording Saved");
      recordingEvents.push("call.recording.saved");
      recordingDescriptions.push(
        "Triggered when recording is saved (call.recording.saved event)"
      );
    }

    // Streaming exits (only if streaming is enabled)
    const streamingOutputs = [];
    const streamingEvents = [];
    const streamingDescriptions = [];

    if (streamUrl) {
      streamingOutputs.push(
        "Streaming Started",
        "Streaming Stopped",
        "Streaming Failed"
      );
      streamingEvents.push(
        "streaming.started",
        "streaming.stopped",
        "streaming.failed"
      );
      streamingDescriptions.push(
        "Triggered when streaming starts (streaming.started event)",
        "Triggered when streaming stops (streaming.stopped event)",
        "Triggered when streaming fails (streaming.failed event)"
      );
    }

    // Transcription exits (only if transcription is enabled)
    const transcriptionOutputs = [];
    const transcriptionEvents = [];
    const transcriptionDescriptions = [];

    if (transcriptionEnabled) {
      transcriptionOutputs.push("Transcription");
      transcriptionEvents.push("call.transcription");
      transcriptionDescriptions.push(
        "Triggered when transcription events occur (call.transcription event)"
      );
    }

    const allOutputs = [
      ...baseOutputs,
      ...recordingOutputs,
      ...streamingOutputs,
      ...transcriptionOutputs,
    ];
    const allEvents = [
      ...baseEvents,
      ...recordingEvents,
      ...streamingEvents,
      ...transcriptionEvents,
    ];
    const allDescriptions = [
      ...baseDescriptions,
      ...recordingDescriptions,
      ...streamingDescriptions,
      ...transcriptionDescriptions,
    ];

    return {
      outputs: allOutputs.length,
      outputLabels: allOutputs,
      outputEvents: allEvents,
      outputDescriptions: allDescriptions,
    };
  }, [record, streamUrl, transcriptionEnabled]);

  // Update dynamic outputs when recording, streaming, or transcription settings change
  const prevRecordRef = useRef(record);
  const prevStreamUrlRef = useRef(streamUrl);
  const prevTranscriptionEnabledRef = useRef(transcriptionEnabled);
  const isInitialMount = useRef(true);
  const onOutputsChangeRef = useRef(onOutputsChange);

  // Keep ref updated with latest callback
  useEffect(() => {
    onOutputsChangeRef.current = onOutputsChange;
  }, [onOutputsChange]);

  useEffect(() => {
    // On initial mount, always calculate outputs
    // On subsequent updates, only update if values actually changed
    if (
      isInitialMount.current ||
      prevRecordRef.current !== record ||
      prevStreamUrlRef.current !== streamUrl ||
      prevTranscriptionEnabledRef.current !== transcriptionEnabled
    ) {
      isInitialMount.current = false;
      prevRecordRef.current = record;
      prevStreamUrlRef.current = streamUrl;
      prevTranscriptionEnabledRef.current = transcriptionEnabled;

      // Use ref to avoid dependency on callback
      if (onOutputsChangeRef.current) {
        const dynamicOutputs = calculateDynamicOutputs();
        onOutputsChangeRef.current(
          dynamicOutputs.outputLabels,
          dynamicOutputs.outputEvents,
          dynamicOutputs.outputDescriptions
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, streamUrl, transcriptionEnabled]);

  // Update config when any field changes
  useEffect(() => {
    updateConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    billingGroupId,
    clientState,
    commandId,
    webhookUrl,
    sendSilenceWhenIdle,
    record,
    recordChannels,
    recordFormat,
    recordMaxLength,
    recordTimeoutSecs,
    recordTrack,
    recordTrim,
    recordCustomFileName,
    sipHeaders,
    customHeaders,
    streamUrl,
    streamTrack,
    streamCodec,
    streamBidirectionalMode,
    streamBidirectionalCodec,
    streamBidirectionalTargetLegs,
    streamBidirectionalSamplingRate,
    streamEstablishBeforeCallOriginate,
    streamingProvider,
    telnyxSttModel,
    telnyxSttTracks,
    telnyxSttInterimResults,
    transcriptionEnabled,
    transcriptionEngine,
    transcriptionEngineConfig,
    transcriptionTracks,
  ]);

  return (
    <div className="space-y-4">
      {/* Basic Settings */}
      <div className="space-y-3">
        <div>
          <Label>Billing Group ID</Label>
          <Input
            type="text"
            value={billingGroupId}
            onChange={(e) => {
              setBillingGroupId(e.target.value);
            }}
            placeholder="f5586561-8ff0-4291-a0ac-84fe544797bd"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Use this field to set the Billing Group ID for the call. Must be a
            valid and existing Billing Group ID.
          </p>
        </div>

        <div>
          <Label>Client State</Label>
          <Input
            type="text"
            value={clientState}
            onChange={(e) => {
              setClientState(e.target.value);
            }}
            placeholder="aGF2ZSBhIG5pY2UgZGF5ID1d"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Base-64 encoded string to add state to every subsequent webhook
          </p>
        </div>

        <div>
          <Label>Command ID</Label>
          <Input
            type="text"
            value={commandId}
            onChange={(e) => {
              setCommandId(e.target.value);
            }}
            placeholder="891510ac-f3e4-11e8-af5b-de00688a4901"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Use this field to avoid duplicate commands. Telnyx will ignore any
            command with the same command_id for the same call_control_id.
          </p>
        </div>

        <div>
          <Label>Webhook URL</Label>
          <Input
            type="text"
            value={webhookUrl}
            onChange={(e) => {
              setWebhookUrl(e.target.value);
            }}
            placeholder="https://www.example.com/server-b/"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Use this field to override the URL for which Telnyx will send
            subsequent webhooks to for this call.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="send_silence_when_idle"
            checked={sendSilenceWhenIdle}
            onCheckedChange={(checked) => {
              setSendSilenceWhenIdle(checked);
            }}
          />
          <Label
            htmlFor="send_silence_when_idle"
            className="text-sm font-normal cursor-pointer"
          >
            Send Silence When Idle
          </Label>
        </div>
        <p className="text-xs text-muted-foreground -mt-2">
          Generate silence RTP packets when no transmission available
        </p>
      </div>

      {/* Recording - Collapsible */}
      <Collapsible
        open={recordingExpanded}
        onOpenChange={setRecordingExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                recordingExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Recording
            </Label>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-3">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="record"
              checked={record}
              onCheckedChange={(checked) => {
                setRecord(checked);
              }}
            />
            <Label
              htmlFor="record"
              className="text-sm font-normal cursor-pointer"
            >
              Record Call
            </Label>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            Whether to record the call
          </p>

          {record && (
            <>
              <div>
                <Label>Record Channels</Label>
                <Select
                  value={recordChannels}
                  onValueChange={(value) => {
                    setRecordChannels(value);
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select channels" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">Single</SelectItem>
                    <SelectItem value="dual">Dual</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  The recording channels
                </p>
              </div>

              <div>
                <Label>Record Format</Label>
                <Select
                  value={recordFormat}
                  onValueChange={(value) => {
                    setRecordFormat(value);
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select format" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mp3">MP3</SelectItem>
                    <SelectItem value="wav">WAV</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  The recording format
                </p>
              </div>

              <div>
                <Label>Record Max Length (seconds)</Label>
                <Input
                  type="number"
                  value={recordMaxLength}
                  onChange={(e) => {
                    setRecordMaxLength(e.target.value);
                  }}
                  placeholder="3600"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The maximum length of the recording in seconds
                </p>
              </div>

              <div>
                <Label>Record Timeout (seconds)</Label>
                <Input
                  type="number"
                  value={recordTimeoutSecs}
                  onChange={(e) => {
                    setRecordTimeoutSecs(e.target.value);
                  }}
                  placeholder="30"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The timeout for recording in seconds
                </p>
              </div>

              <div>
                <Label>Record Track</Label>
                <Select
                  value={recordTrack}
                  onValueChange={(value) => {
                    setRecordTrack(value);
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select track" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inbound">Inbound</SelectItem>
                    <SelectItem value="outbound">Outbound</SelectItem>
                    <SelectItem value="both">Both</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Which track(s) to record
                </p>
              </div>

              <div>
                <Label>Record Trim</Label>
                <Select
                  value={recordTrim}
                  onValueChange={(value) => {
                    setRecordTrim(value);
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select option" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="trim-silence">Trim Silence</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  When set to 'trim-silence', silence will be removed from the
                  beginning and end of the recording.
                </p>
              </div>

              <div>
                <Label>Record Custom File Name</Label>
                <Input
                  type="text"
                  value={recordCustomFileName}
                  onChange={(e) => {
                    setRecordCustomFileName(e.target.value);
                  }}
                  placeholder="my_recording_file_name"
                  maxLength={40}
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The custom recording file name to be used instead of the
                  default call_leg_id. Telnyx will still add a Unix timestamp
                  suffix. Maximum 40 characters.
                </p>
              </div>
            </>
          )}
        </CollapsibleContent>
      </Collapsible>

      {/* Headers - Collapsible */}
      <Collapsible
        open={headersExpanded}
        onOpenChange={setHeadersExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                headersExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Headers
            </Label>
            {(sipHeaders.length > 0 || customHeaders.length > 0) && (
              <span className="text-xs text-muted-foreground">
                ({sipHeaders.length + customHeaders.length})
              </span>
            )}
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-3">
          <div>
            <Label>SIP Headers</Label>
            <div className="space-y-2 mt-1">
              {sipHeaders.map((header, index) => (
                <div
                  key={`sip-header-${index}`}
                  className="flex gap-2 items-center"
                >
                  <div className="flex-shrink-0 w-32">
                    <Select
                      value={header?.name || "User-to-User"}
                      onValueChange={(value) =>
                        handleSipHeaderChange(index, "name", value)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select header name" />
                      </SelectTrigger>
                      <SelectContent>
                        {SIP_HEADER_NAMES.map((name) => {
                          const availableTypes = getAvailableHeaderTypes(index);
                          const isAvailable = availableTypes.includes(name);
                          return (
                            <SelectItem
                              key={name}
                              value={name}
                              disabled={!isAvailable}
                            >
                              {name}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                  <Input
                    className="flex-1 min-w-0 max-w-[calc(100%-12rem)]"
                    placeholder="Header value"
                    value={header?.value || ""}
                    onChange={(e) =>
                      handleSipHeaderChange(index, "value", e.target.value)
                    }
                  />
                  <div className="flex-shrink-0 w-10">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => removeSipHeader(index)}
                      aria-label="Remove header"
                    >
                      <IconTrash className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addSipHeader}
                disabled={
                  sipHeaders.length >= 2 ||
                  (sipHeaders.some((h) => h.name === "User-to-User") &&
                    sipHeaders.some((h) => h.name === "Diversion"))
                }
                className="w-full"
              >
                <IconPlus className="w-4 h-4 mr-2" />
                Add SIP Header
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              SIP headers to be added to the SIP INVITE response. Currently only
              User-to-User and Diversion headers are supported.
            </p>
          </div>

          <div>
            <Label>Custom Headers</Label>
            <div className="space-y-2 mt-1">
              {customHeaders.map((header, index) => (
                <div
                  key={`custom-header-${index}`}
                  className="flex gap-2 items-center"
                >
                  <Input
                    className="flex-shrink-0 w-32"
                    placeholder="Header name"
                    value={header?.name || ""}
                    onChange={(e) =>
                      handleCustomHeaderChange(index, "name", e.target.value)
                    }
                  />
                  <Input
                    className="flex-1 min-w-0 max-w-[calc(100%-12rem)]"
                    placeholder="Header value"
                    value={header?.value || ""}
                    onChange={(e) =>
                      handleCustomHeaderChange(index, "value", e.target.value)
                    }
                  />
                  <div className="flex-shrink-0 w-10">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => removeCustomHeader(index)}
                      aria-label="Remove header"
                    >
                      <IconTrash className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addCustomHeader}
                className="w-full"
              >
                <IconPlus className="w-4 h-4 mr-2" />
                Add Custom Header
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Custom headers to be added to the SIP INVITE response.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Streaming - Collapsible */}
      <Collapsible
        open={streamingExpanded}
        onOpenChange={setStreamingExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                streamingExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Streaming
            </Label>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-3">
          <div>
            <Label>Provider</Label>
            <Select
              value={streamingProvider}
              onValueChange={(value) => {
                setStreamingProvider(value);
                if (value === "custom") {
                  setStreamUrl("");
                  setStreamCodec("");
                  return;
                }

                const providerPath = getStreamingProviderPath(value);
                const nextProvider =
                  value === "telnyx-stt"
                    ? selectedTelnyxSttProvider
                    : AI_STREAMING_PROVIDERS[value];
                if (!providerPath) return;

                const nextUrl = getWebSocketUrl(providerPath);
                setStreamUrl(nextUrl);
                setStreamTrack(nextProvider?.telnyx?.stream_track || "inbound_track");
                setStreamCodec(
                  nextProvider?.telnyx?.stream_codec ||
                    (value === "telnyx-stt" ? "PCMU" : "")
                );
              }}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {STREAMING_PROVIDER_OPTIONS.filter(
                  (option) =>
                    !EXPERIMENTAL_PROVIDERS.includes(option.value) ||
                    isExperimentalUser,
                ).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isTelnyxSttStreaming ? (
            <>
              <div className="flex items-start gap-2 p-3 bg-emerald-50 dark:bg-emerald-950 rounded-md border border-emerald-200 dark:border-emerald-800">
                <IconMicrophone className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
                <div className="text-xs text-emerald-700 dark:text-emerald-300">
                  <strong>Telnyx Standalone STT</strong>
                  <p className="mt-1">
                    Native Telnyx Speech-to-Text WebSocket using PCMU/mulaw @ 8 kHz.
                  </p>
                </div>
              </div>

              <div>
                <Label>Model</Label>
                <Select value={telnyxSttModel} onValueChange={setTelnyxSttModel}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    {TELNYX_STT_MODEL_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Telnyx STT model in provider/model format.
                </p>
              </div>

              <div>
                <Label>Transcription Channels</Label>
                <Select value={telnyxSttTracks} onValueChange={setTelnyxSttTracks}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select channels" />
                  </SelectTrigger>
                  <SelectContent>
                    {TELNYX_STT_TRACK_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Both starts one media stream per call leg after the agent answers.
                </p>
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Interim Results</Label>
                  <p className="text-xs text-muted-foreground">
                    Stream partial transcript deltas to Agent Desktop. Turn off to wait for final transcripts only.
                  </p>
                </div>
                <Switch
                  checked={telnyxSttInterimResults}
                  onCheckedChange={(checked) => {
                    setTelnyxSttInterimResults(checked);
                  }}
                />
              </div>

              <div>
                <Label className="flex items-center gap-2">
                  Stream URL
                  {streamUrlError && (
                    <IconAlertTriangle className="h-4 w-4 text-destructive" />
                  )}
                </Label>
                <Input value={streamUrl} readOnly className="mt-1" />
                <p className="text-xs text-muted-foreground mt-1">
                  Auto-configured WebSocket URL for Telnyx STT streaming.
                </p>
              </div>
            </>
          ) : (
            <>
              <div>
                <Label className="flex items-center gap-2">
                  Stream URL
                  {streamUrlError && (
                    <IconAlertTriangle className="h-4 w-4 text-destructive" />
                  )}
                </Label>
                <VariableInput
                  value={streamUrl}
                  onChange={(value) => {
                    setStreamUrl(value);
                    const validation = validateWebSocketUrl(value);
                    setStreamUrlError(validation.valid ? null : validation.error);
                  }}
                  availableVariables={availableVariables}
                  placeholder="wss://www.example.com/websocket"
                  className={`mt-1 ${streamUrlError ? "border-destructive" : ""}`}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The destination WebSocket address where the stream is going to be delivered
                </p>
              </div>

              {streamUrl && (
                <>
                  <div>
                    <Label>Stream Track</Label>
                    <Select value={streamTrack} onValueChange={setStreamTrack}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select track" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inbound_track">Inbound Track</SelectItem>
                        <SelectItem value="outbound_track">Outbound Track</SelectItem>
                        <SelectItem value="both_tracks">Both Tracks</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label>Stream Codec</Label>
                    <Select
                      value={streamCodec || "default"}
                      onValueChange={(value) => setStreamCodec(value === "default" ? "" : value)}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select codec (optional)" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default (from call)</SelectItem>
                        <SelectItem value="PCMU">PCMU</SelectItem>
                        <SelectItem value="PCMA">PCMA</SelectItem>
                        <SelectItem value="G722">G722</SelectItem>
                        <SelectItem value="OPUS">OPUS</SelectItem>
                        <SelectItem value="AMR-WB">AMR-WB</SelectItem>
                        <SelectItem value="L16">L16</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label>Bidirectional Stream Mode</Label>
                    <Select
                      value={streamBidirectionalMode}
                      onValueChange={setStreamBidirectionalMode}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select bidirectional mode" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="mp3">MP3</SelectItem>
                        <SelectItem value="rtp">RTP</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1">
                      Method used when sending audio back over the bidirectional stream.
                    </p>
                  </div>

                  {streamBidirectionalMode === "rtp" && (
                    <>
                      <div>
                        <Label>Bidirectional RTP Codec</Label>
                        <Select
                          value={streamBidirectionalCodec}
                          onValueChange={setStreamBidirectionalCodec}
                        >
                          <SelectTrigger className="mt-1">
                            <SelectValue placeholder="Select RTP codec" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="PCMU">PCMU</SelectItem>
                            <SelectItem value="PCMA">PCMA</SelectItem>
                            <SelectItem value="G722">G722</SelectItem>
                            <SelectItem value="OPUS">OPUS</SelectItem>
                            <SelectItem value="AMR-WB">AMR-WB</SelectItem>
                            <SelectItem value="L16">L16</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div>
                        <Label>Bidirectional RTP Sampling Rate</Label>
                        <Select
                          value={String(streamBidirectionalSamplingRate)}
                          onValueChange={(value) =>
                            setStreamBidirectionalSamplingRate(Number(value))
                          }
                        >
                          <SelectTrigger className="mt-1">
                            <SelectValue placeholder="Select sampling rate" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="8000">8000 Hz</SelectItem>
                            <SelectItem value="16000">16000 Hz</SelectItem>
                            <SelectItem value="24000">24000 Hz</SelectItem>
                            <SelectItem value="48000">48000 Hz</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}

                  <div>
                    <Label>Bidirectional Stream Target Legs</Label>
                    <Select
                      value={streamBidirectionalTargetLegs}
                      onValueChange={setStreamBidirectionalTargetLegs}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select target legs" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="self">Self</SelectItem>
                        <SelectItem value="opposite">Opposite</SelectItem>
                        <SelectItem value="both">Both</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1">
                      Call legs that should receive bidirectional stream audio.
                    </p>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Establish Before Call Originate</Label>
                      <p className="text-xs text-muted-foreground">
                        Establish the stream before originating a following outbound call.
                      </p>
                    </div>
                    <Switch
                      checked={streamEstablishBeforeCallOriginate}
                      onCheckedChange={setStreamEstablishBeforeCallOriginate}
                    />
                  </div>
                </>
              )}
            </>
          )}
                </CollapsibleContent>
      </Collapsible>

      {/* Transcription - Collapsible */}
      <Collapsible
        open={transcriptionExpanded}
        onOpenChange={setTranscriptionExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                transcriptionExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Transcription
            </Label>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0">
          <div className="flex items-center space-x-2 mb-4">
            <Checkbox
              id="transcription_enabled"
              checked={transcriptionEnabled}
              onCheckedChange={(checked) => {
                const enabled = checked === true;
                setTranscriptionEnabled(enabled);
                if (!enabled) {
                  setTranscriptionEngine("Google");
                  setTranscriptionEngineConfig({});
                  setTranscriptionTracks("inbound");
                }
                onChange?.({
                  ...buildConfig(),
                  transcription_engine: enabled ? transcriptionEngine : undefined,
                  transcription_engine_config: enabled
                    ? transcriptionEngineConfig
                    : undefined,
                  transcription_tracks: enabled ? transcriptionTracks : undefined,
                });
              }}
            />
            <Label
              htmlFor="transcription_enabled"
              className="text-sm font-normal cursor-pointer"
            >
              Enable Transcription
            </Label>
          </div>
          <p className="text-xs text-muted-foreground -mt-2 mb-4">
            Start real-time transcription when the call is answered
          </p>

          {transcriptionEnabled && (
            <TranscriptionNodeEditor
              config={{
                transcription_engine: transcriptionEngine,
                transcription_engine_config: transcriptionEngineConfig,
                transcription_tracks: transcriptionTracks,
              }}
              onChange={(newConfig) => {
                setTranscriptionEngine(
                  newConfig.transcription_engine || "Google"
                );
                setTranscriptionEngineConfig(
                  newConfig.transcription_engine_config || {}
                );
                setTranscriptionTracks(
                  newConfig.transcription_tracks || "inbound"
                );
                onChange?.(buildConfigWithTranscription(newConfig));
              }}
            />
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
