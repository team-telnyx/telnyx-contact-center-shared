"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
} from "@tabler/icons-react";
import { VariableInput } from "./VariableInput";
import TranscriptionNodeEditor from "./TranscriptionNodeEditor";

const SIP_HEADER_NAMES = ["User-to-User", "Diversion"];

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

export default function DialNodeEditor({
  config = {},
  onChange,
  availableVariables = [],
  onOutputsChange,
}) {
  // Basic fields
  const [to, setTo] = useState(config.to || "");
  const [from, setFrom] = useState(config.from || "");
  const [fromDisplayName, setFromDisplayName] = useState(
    config.from_display_name || ""
  );
  const [connectionId, setConnectionId] = useState(config.connection_id || "");
  const [webhookUrl, setWebhookUrl] = useState(config.webhook_url || "");

  // Audio & Media
  const [audioUrl, setAudioUrl] = useState(config.audio_url || "");
  const [mediaName, setMediaName] = useState(config.media_name || "");

  // Timing
  const [timeoutSecs, setTimeoutSecs] = useState(config.timeout_secs || "");
  const [timeLimitSecs, setTimeLimitSecs] = useState(
    config.time_limit_secs || ""
  );

  // Bridging
  const [linkTo, setLinkTo] = useState(config.link_to || "");
  const [bridgeIntent, setBridgeIntent] = useState(config.bridge_intent || "");
  const [bridgeOnAnswer, setBridgeOnAnswer] = useState(
    config.bridge_on_answer || false
  );
  const [parkAfterUnbridge, setParkAfterUnbridge] = useState(
    config.park_after_unbridge || false
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

  // Supervision
  const [superviseCallControlId, setSuperviseCallControlId] = useState(
    config.supervise_call_control_id || ""
  );
  const [supervisorRole, setSupervisorRole] = useState(
    config.supervisor_role || ""
  );

  // SIP Settings
  const [sipRegion, setSipRegion] = useState(config.sip_region || "");
  const [sipHeaders, setSipHeaders] = useState(
    Array.isArray(config.sip_headers) ? config.sip_headers : []
  );

  // Custom Headers
  const [customHeaders, setCustomHeaders] = useState(
    Array.isArray(config.custom_headers) ? config.custom_headers : []
  );

  // AMD (Answering Machine Detection)
  const [answeringMachineDetection, setAnsweringMachineDetection] = useState(
    config.answering_machine_detection || "disabled"
  );
  const [amdConfig, setAmdConfig] = useState(
    config.answering_machine_detection_config || {}
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
  const [sendSilenceWhenIdle, setSendSilenceWhenIdle] = useState(
    config.send_silence_when_idle || false
  );

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
  const [audioExpanded, setAudioExpanded] = useState(false);
  const [timingExpanded, setTimingExpanded] = useState(false);
  const [bridgingExpanded, setBridgingExpanded] = useState(false);
  const [recordingExpanded, setRecordingExpanded] = useState(false);
  const [supervisionExpanded, setSupervisionExpanded] = useState(false);
  const [amdExpanded, setAmdExpanded] = useState(false);
  const [sipExpanded, setSipExpanded] = useState(false);
  const [streamingExpanded, setStreamingExpanded] = useState(false);
  const [transcriptionExpanded, setTranscriptionExpanded] = useState(false);

  // Sync state from config changes
  useEffect(() => {
    if (config.to !== undefined) setTo(config.to);
    if (config.from !== undefined) setFrom(config.from);
    if (config.from_display_name !== undefined)
      setFromDisplayName(config.from_display_name);
    if (config.connection_id !== undefined)
      setConnectionId(config.connection_id);
    if (config.webhook_url !== undefined) setWebhookUrl(config.webhook_url);
    if (config.audio_url !== undefined) setAudioUrl(config.audio_url);
    if (config.media_name !== undefined) setMediaName(config.media_name);
    if (config.timeout_secs !== undefined) setTimeoutSecs(config.timeout_secs);
    if (config.time_limit_secs !== undefined)
      setTimeLimitSecs(config.time_limit_secs);
    if (config.link_to !== undefined) setLinkTo(config.link_to);
    if (config.bridge_intent !== undefined)
      setBridgeIntent(config.bridge_intent);
    if (config.bridge_on_answer !== undefined)
      setBridgeOnAnswer(config.bridge_on_answer);
    if (config.park_after_unbridge !== undefined)
      setParkAfterUnbridge(config.park_after_unbridge);
    if (config.record !== undefined) setRecord(config.record);
    if (config.record_channels !== undefined)
      setRecordChannels(config.record_channels);
    if (config.record_format !== undefined)
      setRecordFormat(config.record_format);
    if (config.record_max_length !== undefined)
      setRecordMaxLength(config.record_max_length);
    if (config.record_timeout_secs !== undefined)
      setRecordTimeoutSecs(config.record_timeout_secs);
    if (config.record_track !== undefined) setRecordTrack(config.record_track);
    if (config.supervise_call_control_id !== undefined)
      setSuperviseCallControlId(config.supervise_call_control_id);
    if (config.supervisor_role !== undefined)
      setSupervisorRole(config.supervisor_role);
    if (config.sip_region !== undefined) setSipRegion(config.sip_region);
    if (config.sip_headers !== undefined) {
      setSipHeaders(
        Array.isArray(config.sip_headers) ? config.sip_headers : []
      );
    }
    if (config.custom_headers !== undefined) {
      setCustomHeaders(
        Array.isArray(config.custom_headers) ? config.custom_headers : []
      );
    }
    if (config.answering_machine_detection !== undefined) {
      setAnsweringMachineDetection(config.answering_machine_detection);
    }
    if (config.answering_machine_detection_config !== undefined) {
      setAmdConfig(config.answering_machine_detection_config);
    }
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
    if (config.send_silence_when_idle !== undefined)
      setSendSilenceWhenIdle(config.send_silence_when_idle);
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
    updatedSipHeaders = null,
    updatedCustomHeaders = null
  ) => {
    const currentSipHeaders =
      updatedSipHeaders !== null ? updatedSipHeaders : sipHeaders;
    const currentCustomHeaders =
      updatedCustomHeaders !== null ? updatedCustomHeaders : customHeaders;

    return {
      to: to || undefined,
      from: from || undefined,
      from_display_name: fromDisplayName || undefined,
      connection_id: connectionId || undefined,
      webhook_url: webhookUrl || undefined,
      audio_url: audioUrl || undefined,
      media_name: mediaName || undefined,
      timeout_secs: timeoutSecs ? Number(timeoutSecs) : undefined,
      time_limit_secs: timeLimitSecs ? Number(timeLimitSecs) : undefined,
      link_to: linkTo || undefined,
      bridge_intent: bridgeIntent || undefined,
      bridge_on_answer: bridgeOnAnswer || undefined,
      park_after_unbridge: parkAfterUnbridge || undefined,
      record: record || undefined,
      record_channels: recordChannels || undefined,
      record_format: recordFormat || undefined,
      record_max_length: recordMaxLength ? Number(recordMaxLength) : undefined,
      record_timeout_secs: recordTimeoutSecs
        ? Number(recordTimeoutSecs)
        : undefined,
      record_track: recordTrack || undefined,
      supervise_call_control_id: superviseCallControlId || undefined,
      supervisor_role: supervisorRole || undefined,
      sip_region: sipRegion || undefined,
      answering_machine_detection:
        answeringMachineDetection !== "disabled"
          ? answeringMachineDetection
          : undefined,
      answering_machine_detection_config:
        answeringMachineDetection !== "disabled" &&
        Object.keys(amdConfig).length > 0
          ? amdConfig
          : undefined,
      // Keep all headers in config (don't filter incomplete ones)
      // The engine will filter them when sending to API
      sip_headers: currentSipHeaders.length > 0 ? currentSipHeaders : undefined,
      custom_headers:
        currentCustomHeaders.length > 0 ? currentCustomHeaders : undefined,
      // Streaming parameters
      stream_url: streamUrl || undefined,
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
      send_silence_when_idle: sendSilenceWhenIdle || undefined,
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

  // Calculate dynamic outputs based on AMD type and streaming settings
  const calculateDynamicOutputs = useCallback(() => {
    const baseOutputs = ["Call Initiated", "Call Answered", "Call Hangup"];
    const baseEvents = ["call.initiated", "call.answered", "call.hangup"];
    const baseDescriptions = [
      "Triggered when call is initiated (call.initiated event)",
      "Triggered when call is answered (call.answered event)",
      "Triggered when call hangs up (call.hangup event)",
    ];

    // AMD exits - show all AMD exits if AMD is enabled (any option except "disabled")
    const amdOutputs = [];
    const amdEvents = [];
    const amdDescriptions = [];

    if (answeringMachineDetection !== "disabled") {
      // Show all AMD exits when any AMD option is selected
      amdOutputs.push(
        "AMD Detection Ended",
        "AMD Premium Detection Ended",
        "AMD Greeting Ended",
        "AMD Premium Greeting Ended"
      );
      amdEvents.push(
        "call.machine.detection.ended",
        "call.machine.premium.detection.ended",
        "call.machine.greeting.ended",
        "call.machine.premium.greeting.ended"
      );
      amdDescriptions.push(
        "Triggered when standard AMD detection ends (call.machine.detection.ended event)",
        "Triggered when premium AMD detection ends (call.machine.premium.detection.ended event)",
        "Triggered when machine greeting ends (call.machine.greeting.ended event)",
        "Triggered when premium machine greeting ends (call.machine.premium.greeting.ended event)"
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
      ...amdOutputs,
      ...streamingOutputs,
      ...transcriptionOutputs,
    ];
    const allEvents = [
      ...baseEvents,
      ...amdEvents,
      ...streamingEvents,
      ...transcriptionEvents,
    ];
    const allDescriptions = [
      ...baseDescriptions,
      ...amdDescriptions,
      ...streamingDescriptions,
      ...transcriptionDescriptions,
    ];

    return {
      outputs: allOutputs.length,
      outputLabels: allOutputs,
      outputEvents: allEvents,
      outputDescriptions: allDescriptions,
    };
  }, [answeringMachineDetection, streamUrl, transcriptionEnabled]);

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

  // Update config when any field changes
  useEffect(() => {
    updateConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    to,
    from,
    fromDisplayName,
    connectionId,
    webhookUrl,
    audioUrl,
    mediaName,
    timeoutSecs,
    timeLimitSecs,
    linkTo,
    bridgeIntent,
    bridgeOnAnswer,
    parkAfterUnbridge,
    record,
    recordChannels,
    recordFormat,
    recordMaxLength,
    recordTimeoutSecs,
    recordTrack,
    superviseCallControlId,
    supervisorRole,
    sipRegion,
    sipHeaders,
    customHeaders,
    answeringMachineDetection,
    amdConfig,
    streamUrl,
    streamTrack,
    streamCodec,
    streamBidirectionalMode,
    streamBidirectionalCodec,
    streamBidirectionalTargetLegs,
    streamBidirectionalSamplingRate,
    streamEstablishBeforeCallOriginate,
    sendSilenceWhenIdle,
    transcriptionEnabled,
    transcriptionEngine,
    transcriptionEngineConfig,
    transcriptionTracks,
  ]);

  // Update dynamic outputs when AMD, streaming, or transcription settings change
  // Use ref to track previous values to prevent infinite loops
  const prevAmdRef = useRef(answeringMachineDetection);
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
      prevAmdRef.current !== answeringMachineDetection ||
      prevStreamUrlRef.current !== streamUrl ||
      prevTranscriptionEnabledRef.current !== transcriptionEnabled
    ) {
      isInitialMount.current = false;
      prevAmdRef.current = answeringMachineDetection;
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
  }, [answeringMachineDetection, streamUrl, transcriptionEnabled]);

  return (
    <div className="space-y-4">
      {/* Basic Call Settings */}
      <div className="space-y-3">
        <div>
          <Label>
            To Number <span className="text-red-500">*</span>
          </Label>
          <VariableInput
            value={to}
            onChange={(value) => {
              setTo(value);
            }}
            availableVariables={availableVariables}
            placeholder="+15551234567 or {{phone_number}}"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            The DID or SIP URI to dial (supports variables like{" "}
            {`{{phone_number}}`})
          </p>
        </div>

        <div>
          <Label>
            From Number <span className="text-red-500">*</span>
          </Label>
          <VariableInput
            value={from}
            onChange={(value) => {
              setFrom(value);
            }}
            availableVariables={availableVariables}
            placeholder="+15559876543 or {{from_number}}"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            The `from` number to be used as the caller id (supports variables
            like {`{{from_number}}`})
          </p>
        </div>

        <div>
          <Label>From Display Name</Label>
          <VariableInput
            value={fromDisplayName}
            onChange={(value) => {
              setFromDisplayName(value);
            }}
            availableVariables={availableVariables}
            placeholder="John Doe or {{display_name}}"
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            The caller ID name to be used for the call (supports variables like{" "}
            {`{{display_name}}`})
          </p>
        </div>

        <div>
          <Label>Connection ID</Label>
          <Input
            type="text"
            value={connectionId}
            onChange={(e) => {
              setConnectionId(e.target.value);
            }}
            placeholder="Connection ID"
            readOnly
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            The ID of the Call Control App
          </p>
        </div>

        {webhookUrl && (
          <div>
            <Label>Webhook URL</Label>
            <Input type="text" value={webhookUrl} readOnly className="mt-1" />
            <p className="text-xs text-muted-foreground mt-1">
              URL for webhooks related to this call (auto-generated)
            </p>
          </div>
        )}
      </div>

      {/* Audio & Media - Collapsible */}
      <Collapsible
        open={audioExpanded}
        onOpenChange={setAudioExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                audioExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Audio & Media
            </Label>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-3">
          <div>
            <Label>Audio URL</Label>
            <Input
              type="text"
              value={audioUrl}
              onChange={(e) => {
                setAudioUrl(e.target.value);
              }}
              placeholder="https://example.com/audio.mp3"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The URL of the audio file to play when the call is answered
            </p>
          </div>

          <div>
            <Label>Media Name</Label>
            <Input
              type="text"
              value={mediaName}
              onChange={(e) => {
                setMediaName(e.target.value);
              }}
              placeholder="Media file name"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The name of the media file to play
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Timing - Collapsible */}
      <Collapsible
        open={timingExpanded}
        onOpenChange={setTimingExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                timingExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Timing
            </Label>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-3">
          <div>
            <Label>Timeout (seconds)</Label>
            <Input
              type="number"
              value={timeoutSecs}
              onChange={(e) => {
                setTimeoutSecs(e.target.value);
              }}
              placeholder="60"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The number of seconds to wait for the call to be answered
            </p>
          </div>

          <div>
            <Label>Time Limit (seconds)</Label>
            <Input
              type="number"
              value={timeLimitSecs}
              onChange={(e) => {
                setTimeLimitSecs(e.target.value);
              }}
              placeholder="3600"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The maximum duration of the call in seconds
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Bridging - Collapsible */}
      <Collapsible
        open={bridgingExpanded}
        onOpenChange={setBridgingExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                bridgingExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Bridging
            </Label>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-3">
          <div>
            <Label>Link To</Label>
            <Input
              type="text"
              value={linkTo}
              onChange={(e) => {
                setLinkTo(e.target.value);
              }}
              placeholder="Call Control ID"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The call control ID to link this call to
            </p>
          </div>

          <div>
            <Label>Bridge Intent</Label>
            <Input
              type="text"
              value={bridgeIntent}
              onChange={(e) => {
                setBridgeIntent(e.target.value);
              }}
              placeholder="Bridge intent"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The intent for bridging the call
            </p>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="bridge_on_answer"
              checked={bridgeOnAnswer}
              onCheckedChange={(checked) => {
                setBridgeOnAnswer(checked);
              }}
            />
            <Label
              htmlFor="bridge_on_answer"
              className="text-sm font-normal cursor-pointer"
            >
              Bridge On Answer
            </Label>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            Whether to bridge the call when it is answered
          </p>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="park_after_unbridge"
              checked={parkAfterUnbridge}
              onCheckedChange={(checked) => {
                setParkAfterUnbridge(checked);
              }}
            />
            <Label
              htmlFor="park_after_unbridge"
              className="text-sm font-normal cursor-pointer"
            >
              Park After Unbridge
            </Label>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            Whether to park the call after unbridging
          </p>
        </CollapsibleContent>
      </Collapsible>

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
            </>
          )}
        </CollapsibleContent>
      </Collapsible>

      {/* Supervision - Collapsible */}
      <Collapsible
        open={supervisionExpanded}
        onOpenChange={setSupervisionExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                supervisionExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Supervision
            </Label>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-3">
          <div>
            <Label>Supervise Call Control ID</Label>
            <Input
              type="text"
              value={superviseCallControlId}
              onChange={(e) => {
                setSuperviseCallControlId(e.target.value);
              }}
              placeholder="Call Control ID"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The call control ID to supervise
            </p>
          </div>

          <div>
            <Label>Supervisor Role</Label>
            <Select
              value={supervisorRole}
              onValueChange={(value) => {
                setSupervisorRole(value);
              }}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="barge">Barge</SelectItem>
                <SelectItem value="whisper">Whisper</SelectItem>
                <SelectItem value="monitor">Monitor</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              The supervisor role for the call
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* AMD (Answering Machine Detection) - Collapsible */}
      <Collapsible
        open={amdExpanded}
        onOpenChange={setAmdExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                amdExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              Answering Machine Detection (AMD)
            </Label>
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="p-3 pt-0 space-y-3">
          <div>
            <Label>AMD Mode</Label>
            <Select
              value={answeringMachineDetection}
              onValueChange={(value) => {
                setAnsweringMachineDetection(value);
              }}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select AMD mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="disabled">Disabled</SelectItem>
                <SelectItem value="premium">Premium</SelectItem>
                <SelectItem value="detect">Detect</SelectItem>
                <SelectItem value="detect_beep">Detect Beep</SelectItem>
                <SelectItem value="detect_words">Detect Words</SelectItem>
                <SelectItem value="greeting_end">Greeting End</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Premium detection provides detailed results (human_residence,
              human_business, machine, silence, fax_detected). Standard
              detection determines if answered by human or machine.
            </p>
          </div>

          {answeringMachineDetection !== "disabled" && (
            <>
              <div>
                <Label>Total Analysis Time (milliseconds)</Label>
                <Input
                  type="number"
                  value={amdConfig.total_analysis_time_millis || ""}
                  onChange={(e) => {
                    setAmdConfig({
                      ...amdConfig,
                      total_analysis_time_millis: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    });
                  }}
                  placeholder="3500"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Maximum timeout threshold for overall detection (default:
                  3500)
                </p>
              </div>

              <div>
                <Label>After Greeting Silence (milliseconds)</Label>
                <Input
                  type="number"
                  value={amdConfig.after_greeting_silence_millis || ""}
                  onChange={(e) => {
                    setAmdConfig({
                      ...amdConfig,
                      after_greeting_silence_millis: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    });
                  }}
                  placeholder="800"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Silence duration threshold after a greeting message or voice
                  for it be considered human (default: 800)
                </p>
              </div>

              <div>
                <Label>Between Words Silence (milliseconds)</Label>
                <Input
                  type="number"
                  value={amdConfig.between_words_silence_millis || ""}
                  onChange={(e) => {
                    setAmdConfig({
                      ...amdConfig,
                      between_words_silence_millis: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    });
                  }}
                  placeholder="50"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Maximum threshold for silence between words (default: 50)
                </p>
              </div>

              <div>
                <Label>Greeting Duration (milliseconds)</Label>
                <Input
                  type="number"
                  value={amdConfig.greeting_duration_millis || ""}
                  onChange={(e) => {
                    setAmdConfig({
                      ...amdConfig,
                      greeting_duration_millis: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    });
                  }}
                  placeholder="3500"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Maximum threshold of a human greeting. If greeting longer than
                  this value, considered machine (default: 3500)
                </p>
              </div>

              <div>
                <Label>Initial Silence (milliseconds)</Label>
                <Input
                  type="number"
                  value={amdConfig.initial_silence_millis || ""}
                  onChange={(e) => {
                    setAmdConfig({
                      ...amdConfig,
                      initial_silence_millis: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    });
                  }}
                  placeholder="3500"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  If initial silence duration is greater than this value,
                  consider it a machine (default: 3500)
                </p>
              </div>

              <div>
                <Label>Maximum Number of Words</Label>
                <Input
                  type="number"
                  value={amdConfig.maximum_number_of_words || ""}
                  onChange={(e) => {
                    setAmdConfig({
                      ...amdConfig,
                      maximum_number_of_words: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    });
                  }}
                  placeholder="5"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  If number of detected words is greater than this value,
                  consider it a machine (default: 5)
                </p>
              </div>

              <div>
                <Label>Maximum Word Length (milliseconds)</Label>
                <Input
                  type="number"
                  value={amdConfig.maximum_word_length_millis || ""}
                  onChange={(e) => {
                    setAmdConfig({
                      ...amdConfig,
                      maximum_word_length_millis: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    });
                  }}
                  placeholder="3500"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  If a single word lasts longer than this threshold, consider it
                  a machine (default: 3500)
                </p>
              </div>

              <div>
                <Label>Silence Threshold</Label>
                <Input
                  type="number"
                  value={amdConfig.silence_threshold || ""}
                  onChange={(e) => {
                    setAmdConfig({
                      ...amdConfig,
                      silence_threshold: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    });
                  }}
                  placeholder="256"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Minimum noise threshold for any analysis (default: 256)
                </p>
              </div>

              <div>
                <Label>Greeting Total Analysis Time (milliseconds)</Label>
                <Input
                  type="number"
                  value={amdConfig.greeting_total_analysis_time_millis || ""}
                  onChange={(e) => {
                    setAmdConfig({
                      ...amdConfig,
                      greeting_total_analysis_time_millis: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    });
                  }}
                  placeholder="5000"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  If machine already detected, maximum timeout threshold to
                  determine the end of the machine greeting (default: 5000)
                </p>
              </div>

              <div>
                <Label>Greeting Silence Duration (milliseconds)</Label>
                <Input
                  type="number"
                  value={amdConfig.greeting_silence_duration_millis || ""}
                  onChange={(e) => {
                    setAmdConfig({
                      ...amdConfig,
                      greeting_silence_duration_millis: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    });
                  }}
                  placeholder="1500"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  If machine already detected, maximum threshold for silence
                  between words. If exceeded, the greeting is considered ended
                  (default: 1500)
                </p>
              </div>
            </>
          )}
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
              The destination WebSocket address where the stream is going to be
              delivered
            </p>
          </div>

          {streamUrl && (
            <>
              <div>
                <Label>Stream Track</Label>
                <Select
                  value={streamTrack}
                  onValueChange={(value) => {
                    setStreamTrack(value);
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select track" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inbound_track">Inbound Track</SelectItem>
                    <SelectItem value="outbound_track">
                      Outbound Track
                    </SelectItem>
                    <SelectItem value="both_tracks">Both Tracks</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Specifies which track should be streamed
                </p>
              </div>

              <div>
                <Label>Stream Codec</Label>
                <Select
                  value={streamCodec || "default"}
                  onValueChange={(value) => {
                    setStreamCodec(value === "default" ? "" : value);
                  }}
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
                <p className="text-xs text-muted-foreground mt-1">
                  Specifies the codec to be used for the streamed audio. When
                  set to default or when transcoding is not possible, the codec
                  from the call will be used.
                </p>
              </div>

              <div>
                <Label>Bidirectional Stream Mode</Label>
                <Select
                  value={streamBidirectionalMode}
                  onValueChange={(value) => {
                    setStreamBidirectionalMode(value);
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mp3">MP3</SelectItem>
                    <SelectItem value="rtp">RTP</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Configures method of bidirectional streaming (mp3, rtp)
                </p>
              </div>

              {streamBidirectionalMode === "rtp" && (
                <>
                  <div>
                    <Label>Bidirectional Stream Codec</Label>
                    <Select
                      value={streamBidirectionalCodec}
                      onValueChange={(value) => {
                        setStreamBidirectionalCodec(value);
                      }}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select codec" />
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
                    <p className="text-xs text-muted-foreground mt-1">
                      Indicates codec for bidirectional streaming RTP payloads.
                      Used only with stream_bidirectional_mode=rtp.
                    </p>
                  </div>

                  <div>
                    <Label>Bidirectional Stream Sampling Rate</Label>
                    <Select
                      value={String(streamBidirectionalSamplingRate)}
                      onValueChange={(value) => {
                        setStreamBidirectionalSamplingRate(Number(value));
                      }}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select sampling rate" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="8000">8000 Hz</SelectItem>
                        <SelectItem value="16000">16000 Hz</SelectItem>
                        <SelectItem value="22050">22050 Hz</SelectItem>
                        <SelectItem value="24000">24000 Hz</SelectItem>
                        <SelectItem value="48000">48000 Hz</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1">
                      Audio sampling rate for bidirectional RTP streaming
                    </p>
                  </div>
                </>
              )}

              <div>
                <Label>Bidirectional Stream Target Legs</Label>
                <Select
                  value={streamBidirectionalTargetLegs}
                  onValueChange={(value) => {
                    setStreamBidirectionalTargetLegs(value);
                  }}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select target legs" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="both">Both</SelectItem>
                    <SelectItem value="self">Self</SelectItem>
                    <SelectItem value="opposite">Opposite</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Specifies which call legs should receive the bidirectional
                  stream audio
                </p>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="stream_establish_before_call_originate"
                  checked={streamEstablishBeforeCallOriginate}
                  onCheckedChange={(checked) => {
                    setStreamEstablishBeforeCallOriginate(checked);
                  }}
                />
                <Label
                  htmlFor="stream_establish_before_call_originate"
                  className="text-sm font-normal cursor-pointer"
                >
                  Establish WebSocket Before Call Originate
                </Label>
              </div>
              <p className="text-xs text-muted-foreground -mt-2">
                Establish websocket connection before dialing the destination.
                Useful for cases where the websocket connection takes a long
                time to establish.
              </p>

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
            </>
          )}
        </CollapsibleContent>
      </Collapsible>

      {/* SIP Settings - Collapsible */}
      <Collapsible
        open={sipExpanded}
        onOpenChange={setSipExpanded}
        className="border rounded-md"
      >
        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-2">
            <IconChevronRight
              className={`h-4 w-4 transition-transform ${
                sipExpanded ? "rotate-90" : ""
              }`}
            />
            <Label className="text-xs font-semibold cursor-pointer">
              SIP Settings
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
            <Label>SIP Region</Label>
            <Select
              value={sipRegion}
              onValueChange={(value) => {
                setSipRegion(value);
              }}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select SIP region" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="US">US</SelectItem>
                <SelectItem value="Europe">Europe</SelectItem>
                <SelectItem value="Canada">Canada</SelectItem>
                <SelectItem value="Australia">Australia</SelectItem>
                <SelectItem value="Middle East">Middle East</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Defines the SIP region to be used for the call
            </p>
          </div>

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
              SIP headers to be added to the request. Currently only
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
              Custom headers to be added to the SIP INVITE
            </p>
          </div>
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
