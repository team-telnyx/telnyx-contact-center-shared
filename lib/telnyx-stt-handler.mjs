import WebSocket from "ws";
import { createHash } from "node:crypto";
import { buildTelnyxV2Url } from "./telnyx.js";
import {
  createDiagnosticLogger,
  sanitizeDiagnosticPayload,
  sanitizeDiagnosticUrl,
} from "./diagnostic-logger.mjs";
import {
  normalizeLanguageCode,
  normalizeSttLanguageCode,
} from "./language-code-utils.js";

if (!globalThis.__telnyxSttStreamSessions) globalThis.__telnyxSttStreamSessions = new Map();
if (!globalThis.__telnyxSttActiveSessions) globalThis.__telnyxSttActiveSessions = new Map();
if (!globalThis.__telnyxSttMediaStreamCommandIds) globalThis.__telnyxSttMediaStreamCommandIds = new Map();
// Bypass-only set: callControlIds whose call.transcription webhooks should be
// silenced because a standalone STT pipeline is already handling that interaction.
// Kept separate from __telnyxSttActiveSessions so audio routing is not affected.
if (!globalThis.__telnyxSttBypassLegIds) globalThis.__telnyxSttBypassLegIds = new Set();

const TELNYX_STT_WS_URL = "wss://api.telnyx.com/v2/speech-to-text/transcription";
const sttLogger = createDiagnosticLogger("telnyx.stt");

// Two known failure modes, both left unhandled leave a track silently dead
// for the rest of the call:
//  1. Cold-start race (two near-simultaneous session starts, e.g. inbound +
//     outbound legs answering within milliseconds of each other): one
//     provider socket opens, accepts audio, but never delivers a single
//     message, then the provider force-closes it cleanly (code 1000, no
//     reason) after ~6s.
//  2. Mid-call abnormal closure (e.g. code 1006): the socket was working
//     fine — hundreds of messages already received — then the provider
//     closes it unexpectedly anyway.
// Both reconnect the same way (see the "close" handler below); capped so a
// persistent problem (bad credentials, provider outage) surfaces as an error
// instead of retrying forever.
const STT_SOCKET_MAX_RECONNECTS = 3;
const STT_PROVIDER_FIRST_RESPONSE_WARN_MS = 5000;

function logSttInfo(message, payload = {}) {
  sttLogger.info(message, payload);
}

function logSttWarn(message, payload = {}) {
  sttLogger.warn(message, payload);
}

function logSttError(message, payload = {}) {
  sttLogger.error(message, payload);
}

function logIdentifier(value) {
  return value == null || value === "" ? null : String(value);
}

function summarizeConfig(config = {}) {
  return sanitizeDiagnosticPayload({
    enabled: config.enabled,
    transcription_engine: config.transcription_engine,
    model: config.model,
    language: config.language,
    stream_codec: config.stream_codec,
    input_format: config.input_format,
    sample_rate: config.sample_rate,
    interim_results: config.interim_results,
    endpointing: config.endpointing,
    transcription_tracks: config.transcription_tracks,
    flowId: config.flowId || config.flow_id || null,
  });
}

function normalizeTelnyxSttStreamCodec(value, fallback = "PCMU") {
  const normalized = String(value || "").trim().toUpperCase();
  if (["PCMA", "G711A", "A-LAW", "ALAW", "AUDIO/X-ALAW"].includes(normalized)) {
    return "PCMA";
  }
  if (["PCMU", "G711U", "MU-LAW", "MULAW", "AUDIO/X-MULAW"].includes(normalized)) {
    return "PCMU";
  }
  return fallback;
}

function telnyxSttConfigForMediaCodec(config = {}, codec, sampleRate = null) {
  const fallbackCodec = normalizeTelnyxSttStreamCodec(config.stream_codec, "PCMU");
  const streamCodec = normalizeTelnyxSttStreamCodec(codec, fallbackCodec);
  const parsedSampleRate = Number(sampleRate);
  return {
    ...config,
    stream_codec: streamCodec,
    input_format: streamCodec === "PCMA" ? "alaw" : "mulaw",
    sample_rate:
      Number.isFinite(parsedSampleRate) && parsedSampleRate > 0
        ? parsedSampleRate
        : Number(config.sample_rate) || 8000,
  };
}

function telnyxSttConfigForMediaFormat(config = {}, mediaFormat = null) {
  const encoding =
    (mediaFormat && typeof mediaFormat === "object"
      ? mediaFormat.encoding || mediaFormat.codec || mediaFormat.name
      : mediaFormat) || config.stream_codec;
  const sampleRate =
    mediaFormat && typeof mediaFormat === "object"
      ? mediaFormat.sample_rate || mediaFormat.sampleRate
      : null;
  return telnyxSttConfigForMediaCodec(config, encoding, sampleRate);
}

async function summarizeHttpErrorResponse(res) {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return sanitizeDiagnosticPayload(JSON.parse(text));
  } catch {
    return sanitizeDiagnosticPayload(text);
  }
}

function normalizeTranscriptionTracks(value) {
  if (value === "inbound" || value === "outbound" || value === "both") return value;
  return "both";
}

function selectedTrackLabels(value) {
  const normalized = normalizeTranscriptionTracks(value);
  if (normalized === "inbound") return ["inbound"];
  if (normalized === "outbound") return ["outbound"];
  return ["inbound", "outbound"];
}

function normalizeTelnyxSttWebSocketModel(engine, model) {
  const value = String(model || "").trim();
  if (!value || value === "default") return null;

  // The application stores the canonical catalog identifier (for example
  // deepgram/flux), while the Telnyx STT WebSocket selects Deepgram separately
  // through transcription_engine and expects only the provider model name.
  if (
    String(engine || "").trim().toLowerCase() === "deepgram" &&
    value.toLowerCase().startsWith("deepgram/")
  ) {
    return value.slice("deepgram/".length);
  }
  return value;
}

function normalizeTelnyxSttWebSocketLanguage(engine, model, language) {
  const value = String(language || "").trim() || "en-US";
  const normalizedModel = normalizeTelnyxSttWebSocketModel(engine, model);
  if (
    String(engine || "").trim().toLowerCase() === "deepgram" &&
    normalizedModel === "flux"
  ) {
    // Flux is English-only. `auto` is mapped by Telnyx to multilingual mode,
    // which belongs to flux-multi and can leave a plain Flux session silent.
    return "en";
  }
  return value;
}

function configuredSupportedLanguageCodes(config = {}) {
  return (config.supported_languages || [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.value))
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function normalizeAgentSttLanguage(language, config = {}) {
  const supportedCodes = configuredSupportedLanguageCodes(config);
  const configuredFallback = normalizeLanguageCode(config.language, {
    fallback: "en",
  });
  if (supportedCodes.length === 0) {
    return normalizeLanguageCode(language, { fallback: configuredFallback });
  }
  const fallback = normalizeSttLanguageCode(config.language, {
    supportedCodes,
    fallback: supportedCodes.includes("en") ? "en" : supportedCodes[0],
  });
  return normalizeSttLanguageCode(language, { supportedCodes, fallback });
}

function buildStreamWsBase() {
  let streamWsBase = process.env.WS_BASE_URL || process.env.STREAMING_WS_URL;
  if (!streamWsBase) {
    let baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL ||
      process.env.APP_BASE_URL ||
      process.env.VERCEL_URL ||
      "localhost:3000";
    baseUrl = baseUrl.replace(/^https?:\/\//, "");
    const protocol = baseUrl.startsWith("localhost") || baseUrl.startsWith("127.") ? "ws" : "wss";
    const wsPort =
      globalThis.__streamingWsPort ||
      parseInt(process.env.STREAMING_WS_PORT || "0", 10) ||
      parseInt(process.env.PORT || "3000", 10) + 1;
    const host = baseUrl.replace(/:\d+$/, "");
    streamWsBase = `${protocol}://${host}:${wsPort}`;
  }
  return streamWsBase.replace(/\/$/, "");
}

function buildTelnyxSttStreamUrl() {
  const streamingSecret = process.env.STREAMING_SECRET || "";
  const secretParam = streamingSecret ? `?secret=${encodeURIComponent(streamingSecret)}` : "";
  return `${buildStreamWsBase()}/streaming/telnyx-stt${secretParam}`;
}

function parseClientState(clientStateB64) {
  if (!clientStateB64) return {};
  try {
    return JSON.parse(Buffer.from(clientStateB64, "base64").toString("utf-8"));
  } catch (_) {
    return {};
  }
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildStableCommandId(...parts) {
  const hex = createHash("sha256")
    .update(parts.map((part) => String(part || "")).join("|"))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(
    (parseInt(hex.slice(16, 18), 16) & 0x3f) |
    0x80
  ).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function buildAgentLegMediaStreamCommandId(
  callControlId,
  {
    outputTrack = "outbound",
    mediaTrack = "inbound",
    streamTrack = "inbound_track",
    streamCodec = "PCMU",
  } = {},
) {
  return buildStableCommandId(
    "telnyx-stt-agent-leg-media-stream",
    callControlId,
    streamTrack,
    streamCodec,
    mediaTrack,
    outputTrack,
  );
}

function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 6) return "[MaxDepth]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    if (/^(bearer\s+)?[A-Za-z0-9_-]{24,}\.?[A-Za-z0-9._-]*$/i.test(compact)) {
      return `[redacted:string:${compact.length}]`;
    }
    return compact.length > 300 ? `${compact.slice(0, 300)}…[${compact.length}]` : compact;
  }
  if (Buffer.isBuffer(value)) return `[Buffer:${value.length}]`;
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item) => sanitizeDiagnosticValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 20)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("authorization") ||
        lower.includes("api_key") ||
        lower.includes("apikey") ||
        lower.includes("token") ||
        lower.includes("secret") ||
        lower.includes("password") ||
        lower === "payload" ||
        lower === "audio"
      ) {
        result[key] = `[redacted:${typeof item === "string" ? item.length : typeof item}]`;
      } else {
        result[key] = sanitizeDiagnosticValue(item, depth + 1);
      }
    }
    return result;
  }
  return `[${typeof value}]`;
}

function summarizeProviderFrame(frame) {
  if (!frame || typeof frame !== "object") return { value: sanitizeDiagnosticValue(frame) };
  return sanitizeDiagnosticValue({
    type: frame.type || frame.event || frame.message_type || frame.channel?.type || null,
    keys: Object.keys(frame),
    error: frame.error || frame.errors || frame.reason || null,
    metadata: frame.metadata || frame.request_id || frame.transaction_id || null,
    channel: frame.channel
      ? {
          keys: Object.keys(frame.channel),
          alternatives: Array.isArray(frame.channel.alternatives)
            ? frame.channel.alternatives.slice(0, 2).map((alt) => ({
                keys: Object.keys(alt || {}),
                transcript: alt?.transcript,
                confidence: alt?.confidence,
              }))
            : null,
        }
      : null,
    is_final: frame.is_final ?? frame.final ?? frame.speech_final ?? null,
    raw: frame,
  });
}

async function routeTranscriptionThroughAgentAssist(payload) {
  try {
    const { routeAgentAssistTranscription } = await import("./agent-assist-transcription-router.mjs");
    await routeAgentAssistTranscription({
      call_control_id: payload.callControlId,
      call_session_id: payload.callSessionId || null,
      interaction_id: payload.interactionId || null,
      source: payload.source,
      transcription_data: {
        transcript: payload.transcription?.transcript || "",
        transcription_track: payload.transcription?.track || "inbound",
        is_final: payload.transcription?.is_final === true,
        speech_final: payload.transcription?.speech_final ?? payload.transcription?.is_final === true,
        confidence: payload.transcription?.confidence ?? null,
        language: payload.transcription?.detectedLanguage || null,
        provider: payload.transcription?.provider || null,
        model: payload.transcription?.model || null,
        source: payload.source,
      },
    });
  } catch (e) {
    logSttError("agent_assist_route_failed", {
      callControlId: logIdentifier(payload.callControlId),
      interactionId: logIdentifier(payload.interactionId),
      source: payload.source,
      error: e?.message || String(e),
    });
  }
}

async function addMonitorTranscriptionEvent(payload, rawFrame, flowId) {
  try {
    const { addTelnyxStandaloneSttEvent } = await import("./call-monitor-store.js");
    addTelnyxStandaloneSttEvent({
      callControlId: payload.callControlId,
      flowId,
      interactionId: payload.interactionId,
      transcript: payload.transcription?.transcript,
      track: payload.transcription?.track,
      isFinal: payload.transcription?.is_final,
      confidence: payload.transcription?.confidence,
      detectedLanguage: payload.transcription?.detectedLanguage,
      provider: payload.transcription?.provider,
      model: payload.transcription?.model,
      rawType: payload.transcription?.rawType || rawFrame?.type || rawFrame?.event || null,
      raw: rawFrame,
    });
  } catch (e) {
    logSttError("monitor_transcription_event_failed", {
      callControlId: logIdentifier(payload.callControlId),
      interactionId: logIdentifier(payload.interactionId),
      flowId: logIdentifier(flowId),
      error: e?.message || String(e),
    });
  }
}

function normalizeTranscriptFrame(frame) {
  if (!frame || typeof frame !== "object") return null;

  let transcript = "";
  let isFinal = false;
  let speechFinal = null;
  let confidence = null;

  if (typeof frame.transcript === "string") {
    transcript = frame.transcript;
    isFinal = !!(frame.is_final || frame.speech_final || frame.final);
    speechFinal = typeof frame.speech_final === "boolean" ? frame.speech_final : null;
    confidence = frame.confidence ?? null;
  } else if (frame.channel?.alternatives?.[0]?.transcript) {
    const alt = frame.channel.alternatives[0];
    transcript = alt.transcript;
    isFinal = !!(frame.is_final || frame.speech_final || frame.final);
    speechFinal = typeof frame.speech_final === "boolean" ? frame.speech_final : null;
    confidence = alt.confidence ?? null;
  } else if (frame.type === "transcription" && frame.transcription?.transcript) {
    transcript = frame.transcription.transcript;
    isFinal = !!frame.transcription.is_final;
    speechFinal = typeof frame.transcription.speech_final === "boolean"
      ? frame.transcription.speech_final
      : null;
    confidence = frame.transcription.confidence ?? null;
  } else if (frame.type === "Results" && frame.channel?.alternatives?.[0]?.transcript) {
    const alt = frame.channel.alternatives[0];
    transcript = alt.transcript;
    isFinal = !!(frame.is_final || frame.speech_final || frame.final);
    speechFinal = typeof frame.speech_final === "boolean" ? frame.speech_final : null;
    confidence = alt.confidence ?? null;
  }

  transcript = compactText(transcript);
  if (!transcript) return null;
  return { transcript, isFinal, speechFinal, confidence, rawType: frame.type || frame.event || null };
}

class TelnyxSttRealtimeSession {
  constructor({ callControlId, interactionId, agentUsername, config, flowId = null, track = "inbound", callSessionId = null }) {
    this.callControlId = callControlId;
    this.interactionId = interactionId;
    this.callSessionId = callSessionId;
    this.agentUsername = agentUsername;
    this.config = config || {};
    this.flowId = flowId || this.config.flow_id || this.config.flowId || null;
    this.track = track;
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.pendingAudio = [];
    this.sentChunks = 0;
    this.sentBytes = 0;
    this.providerMessages = 0;
    this.providerFrames = 0;
    this.nonTranscriptFrames = 0;
    this.receivedTranscripts = 0;
    this.reconnectAttempts = 0;
    this.firstAudioSentAtMs = null;
    this.noProviderResponseWarned = false;
  }

  buildUrl() {
    const params = new URLSearchParams();
    const engine = this.config.transcription_engine || "Google";
    const model = normalizeTelnyxSttWebSocketModel(engine, this.config.model);
    params.set("transcription_engine", engine);
    params.set("input_format", this.config.input_format || "mulaw");
    params.set("sample_rate", String(this.config.sample_rate || 8000));
    params.set(
      "language",
      normalizeTelnyxSttWebSocketLanguage(engine, model, this.config.language),
    );
    if (model) params.set("model", model);
    if (this.config.interim_results !== undefined) params.set("interim_results", String(this.config.interim_results));
    if (this.config.endpointing !== undefined) params.set("endpointing", String(this.config.endpointing));
    return `${TELNYX_STT_WS_URL}?${params.toString()}`;
  }

  connect() {
    if (this.closed) return;
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      logSttError("provider_socket_missing_api_key", {
        callControlId: logIdentifier(this.callControlId),
        interactionId: logIdentifier(this.interactionId),
        track: this.track,
      });
      return;
    }

    const url = this.buildUrl();
    const safeUrl = sanitizeDiagnosticUrl(url);

    logSttInfo("provider_socket_connecting", {
      callControlId: logIdentifier(this.callControlId),
      interactionId: logIdentifier(this.interactionId),
      flowId: logIdentifier(this.flowId),
      track: this.track,
      url: safeUrl,
      config: summarizeConfig(this.config),
    });

    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });

    this.ws.on("open", () => {
      this.connected = true;
      this.firstAudioSentAtMs = null;
      this.noProviderResponseWarned = false;
      logSttInfo("provider_socket_open", {
        callControlId: logIdentifier(this.callControlId),
        interactionId: logIdentifier(this.interactionId),
        track: this.track,
        pendingAudio: this.pendingAudio.length,
      });

      const buffered = this.pendingAudio.splice(0);
      for (const payload of buffered) this.sendAudio(payload);
    });

    this.ws.on("message", async (data) => {
      try {
        this.providerMessages++;
        this.noProviderResponseWarned = false;
        const str = data.toString();
        let msg;
        try { msg = JSON.parse(str); } catch { msg = { raw: str }; }
        if (msg?.errors?.length || msg?.error) {
          logSttError("provider_socket_error_frame", {
            callControlId: logIdentifier(this.callControlId),
            interactionId: logIdentifier(this.interactionId),
            track: this.track,
            frame: summarizeProviderFrame(msg),
          });
          return;
        }
        const frames = Array.isArray(msg) ? msg : [msg];
        for (const frame of frames) {
          this.providerFrames++;
          const normalized = normalizeTranscriptFrame(frame);
          if (!normalized) {
            this.nonTranscriptFrames++;
            continue;
          }
          this.receivedTranscripts++;
          const payload = {
            type: "transcription",
            source: "telnyx_standalone_stt_websocket",
            interactionId: this.interactionId,
            callControlId: this.callControlId,
            callSessionId: this.callSessionId,
            transcription: {
              transcript: normalized.transcript,
              track: this.track,
              is_final: normalized.isFinal,
              speech_final: normalized.speechFinal ?? normalized.isFinal,
              timestamp: new Date().toISOString(),
              detectedLanguage: this.config.language || null,
              confidence: normalized.confidence,
              provider: this.config.transcription_engine || "Google",
              model: this.config.model || "default",
              translation: null,
              intent: null,
              sentiment: null,
              sentimentScore: null,
              tags: [],
              rawType: normalized.rawType,
            },
          };
          await routeTranscriptionThroughAgentAssist(payload);
          addMonitorTranscriptionEvent(payload, frame, this.flowId);
        }
      } catch (e) {
        logSttError("provider_socket_message_handler_error", {
          callControlId: logIdentifier(this.callControlId),
          interactionId: logIdentifier(this.interactionId),
          track: this.track,
          error: e?.message || String(e),
        });
      }
    });

    this.ws.on("error", (err) => {
      logSttError("provider_socket_error", {
        callControlId: logIdentifier(this.callControlId),
        interactionId: logIdentifier(this.interactionId),
        track: this.track,
        error: err?.message || String(err),
      });
    });

    this.ws.on("close", (code, reason) => {
      // this.closed is already true here iff OUR OWN close() ran first (it
      // sets this.closed synchronously before asking the socket to close) —
      // that's how an intentional close (call ended, session stopped) is
      // told apart from the provider closing on us unexpectedly.
      const wasIntentional = this.closed;
      this.connected = false;
      this.closed = true;

      // Diagnostic only: zero messages received for this socket's entire
      // lifetime — the original cold-start race (two near-simultaneous
      // session starts) this reconnect logic was first built for.
      const deadOnArrival = this.providerMessages === 0;
      // Reconnect on ANY provider-initiated close, not just dead-on-arrival:
      // a socket that was working fine (hundreds of messages already
      // received) can still be abnormally closed by the provider mid-call
      // (e.g. code 1006) — left unhandled, that track silently stops
      // transcribing for the rest of the call with no recovery path.
      // Audio spoken during the reconnect gap itself is unrecoverable (the
      // provider doesn't buffer/replay), but resuming afterward is far
      // better than staying dead for the remainder of the call.
      const shouldReconnect = !wasIntentional;
      const willReconnect = shouldReconnect && this.reconnectAttempts < STT_SOCKET_MAX_RECONNECTS;

      logSttInfo("provider_socket_close", {
        callControlId: logIdentifier(this.callControlId),
        interactionId: logIdentifier(this.interactionId),
        track: this.track,
        code,
        reason: reason?.toString?.() || "",
        sentChunks: this.sentChunks,
        sentBytes: this.sentBytes,
        pendingAudio: this.pendingAudio.length,
        providerMessages: this.providerMessages,
        providerFrames: this.providerFrames,
        nonTranscriptFrames: this.nonTranscriptFrames,
        receivedTranscripts: this.receivedTranscripts,
        deadOnArrival,
        shouldReconnect,
        willReconnect,
        reconnectAttempts: this.reconnectAttempts,
      });

      if (!shouldReconnect) return;

      if (!willReconnect) {
        logSttError("provider_socket_reconnect_exhausted", {
          callControlId: logIdentifier(this.callControlId),
          interactionId: logIdentifier(this.interactionId),
          track: this.track,
          deadOnArrival,
          reconnectAttempts: this.reconnectAttempts,
        });
        return;
      }

      this.reconnectAttempts++;
      // Undo the "intentional close" bookkeeping above so connect() (which
      // early-returns when this.closed) runs again for a fresh socket. Audio
      // already buffered in pendingAudio is preserved and flushed once the
      // new socket opens.
      this.closed = false;
      this.ws = null;
      this.providerMessages = 0;
      this.providerFrames = 0;
      this.nonTranscriptFrames = 0;
      logSttWarn("provider_socket_reconnecting", {
        callControlId: logIdentifier(this.callControlId),
        interactionId: logIdentifier(this.interactionId),
        track: this.track,
        deadOnArrival,
        reconnectAttempts: this.reconnectAttempts,
      });
      this.connect();
    });
  }

  sendAudio(payloadBase64) {
    if (!payloadBase64 || this.closed) return;
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingAudio.push(payloadBase64);
      if (this.pendingAudio.length > 600) this.pendingAudio.shift();
      return;
    }
    try {
      const audioBuffer = Buffer.from(payloadBase64, "base64");
      this.ws.send(audioBuffer);
      this.sentChunks++;
      this.sentBytes += audioBuffer.length;
      const nowMs = Date.now();
      if (this.firstAudioSentAtMs === null) this.firstAudioSentAtMs = nowMs;
      if (
        this.providerMessages === 0 &&
        !this.noProviderResponseWarned &&
        nowMs - this.firstAudioSentAtMs >= STT_PROVIDER_FIRST_RESPONSE_WARN_MS
      ) {
        this.noProviderResponseWarned = true;
        logSttWarn("provider_socket_no_response_after_audio", {
          callControlId: logIdentifier(this.callControlId),
          interactionId: logIdentifier(this.interactionId),
          track: this.track,
          sentChunks: this.sentChunks,
          sentBytes: this.sentBytes,
          elapsedSinceFirstAudioMs: nowMs - this.firstAudioSentAtMs,
          reconnectAttempts: this.reconnectAttempts,
        });
      }
    } catch (e) {
      logSttError("provider_socket_audio_send_failed", {
        callControlId: logIdentifier(this.callControlId),
        interactionId: logIdentifier(this.interactionId),
        track: this.track,
        error: e?.message || String(e),
      });
    }
  }

  close() {
    this.closed = true;
    this.pendingAudio = [];
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch (_) {}
      try { this.ws.close(1000, "Session ended"); } catch (_) {}
      this.ws = null;
    }
  }
}

class TelnyxSttStreamSession {
  constructor(callControlId, clientState, callSessionId = null) {
    this.callControlId = callControlId;
    this.clientState = clientState || {};
    this.interactionId = this.clientState.interaction_id || this.clientState.interactionId || null;
    this.callSessionId =
      callSessionId ||
      this.clientState.call_session_id ||
      this.clientState.callSessionId ||
      null;
    this.audioBuffer = { inbound_track: [], outbound_track: [], inbound: [], outbound: [] };
    this.mediaChunks = 0;
    this.mediaBytes = 0;
    this.mediaChunksByTrack = { inbound: 0, outbound: 0 };
    this.mediaBytesByTrack = { inbound: 0, outbound: 0 };
    this.maxBufferChunks = 600;
  }

  bufferAudio(track, payloadBase64) {
    const buf = this.audioBuffer[track];
    if (!buf) return;
    buf.push(payloadBase64);
    if (buf.length > this.maxBufferChunks) buf.shift();
  }

  getBuffer(logicalTrack) {
    const a = this.audioBuffer[logicalTrack] || [];
    const b = this.audioBuffer[`${logicalTrack}_track`] || [];
    return [...a, ...b];
  }

  clearBuffer(logicalTrack) {
    this.audioBuffer[logicalTrack] = [];
    this.audioBuffer[`${logicalTrack}_track`] = [];
  }
}

function logicalTrack(track) {
  return track === "outbound_track" || track === "outbound" ? "outbound" : "inbound";
}

function explicitStreamTrackMappings(outputTrack, mediaTrack = null) {
  if (
    ["inbound", "outbound"].includes(mediaTrack) &&
    ["inbound", "outbound"].includes(outputTrack)
  ) {
    return [{ mediaTrack, outputTrack }];
  }
  if (outputTrack === "both") {
    return [
      { mediaTrack: "inbound", outputTrack: "outbound" },
      { mediaTrack: "outbound", outputTrack: "inbound" },
    ];
  }
  if (outputTrack === "outbound") {
    return [{ mediaTrack: "inbound", outputTrack: "outbound" }];
  }
  if (outputTrack === "inbound") {
    return [{ mediaTrack: "inbound", outputTrack: "inbound" }];
  }
  return [];
}

function ensureExplicitStreamSttSession(
  streamSession,
  start = startTelnyxSttTranscription,
) {
  const clientState = streamSession?.clientState || {};
  const config = clientState.telnyx_stt_config;
  const outputTrack = clientState.telnyx_stt_track;
  const mediaTrack = clientState.telnyx_stt_media_track || null;
  const trackMappings = explicitStreamTrackMappings(outputTrack, mediaTrack);
  if (
    !streamSession?.callControlId ||
    !config?.enabled ||
    trackMappings.length === 0 ||
    globalThis.__telnyxSttActiveSessions.has(streamSession.callControlId)
  ) {
    return false;
  }

  // A media WebSocket can terminate on a different runtime worker from the
  // webhook/ACD callback that prepared the provider session. Explicit dynamic
  // streams carry everything needed to recover locally; bind them immediately
  // instead of buffering the complete agent leg forever with no STT target.
  const recovery = start(
    streamSession.callControlId,
    config,
    streamSession.interactionId,
    clientState.agent_username || null,
    {
      trackMappings,
      callSessionId: streamSession.callSessionId,
    },
  );
  void Promise.resolve(recovery).catch((error) => {
    logSttError("media_ws_stt_session_recovery_failed", {
      callControlId: logIdentifier(streamSession.callControlId),
      interactionId: logIdentifier(streamSession.interactionId),
      outputTrack,
      mediaTrack,
      error: error?.message || String(error),
    });
  });
  streamSession.ownsRecoveredSttSession = true;
  return true;
}

function stopRecoveredStreamSttSession(
  streamSession,
  stop = stopTelnyxSttTranscription,
) {
  if (
    !streamSession?.ownsRecoveredSttSession ||
    !streamSession.callControlId ||
    globalThis.__telnyxSttStreamSessions.get(streamSession.callControlId) !== streamSession
  ) {
    return false;
  }

  streamSession.ownsRecoveredSttSession = false;
  const cleanup = stop(streamSession.callControlId);
  void Promise.resolve(cleanup).catch((error) => {
    logSttError("media_ws_recovered_stt_cleanup_failed", {
      callControlId: logIdentifier(streamSession.callControlId),
      interactionId: logIdentifier(streamSession.interactionId),
      error: error?.message || String(error),
    });
  });
  return true;
}

export function handleWebSocketConnection(ws, req) {
  let session = null;
  let callControlId = null;

  logSttInfo("media_ws_connected", {
    url: sanitizeDiagnosticUrl(req?.url || null),
    remoteAddress: req?.socket?.remoteAddress || null,
    activeSessions: globalThis.__telnyxSttActiveSessions.size,
    streamSessions: globalThis.__telnyxSttStreamSessions.size,
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.event) {
        case "start": {
          const startData = msg.start || {};
          callControlId = startData.call_control_id;
          if (!callControlId) {
            logSttWarn("media_ws_start_missing_call_control_id", {
              startKeys: Object.keys(startData),
            });
            break;
          }
          const clientState = parseClientState(startData.client_state);
          const mediaFormat = startData.media_format || startData.mediaFormat || null;
          if (clientState.telnyx_stt_config?.enabled) {
            clientState.telnyx_stt_config = telnyxSttConfigForMediaFormat(
              clientState.telnyx_stt_config,
              mediaFormat,
            );
            clientState.telnyx_stt_stream_codec =
              clientState.telnyx_stt_config.stream_codec;
          }
          const startCallSessionId =
            startData.call_session_id ||
            startData.callSessionId ||
            msg.call_session_id ||
            null;
          session = new TelnyxSttStreamSession(callControlId, clientState, startCallSessionId);
          const previousStreamSession = globalThis.__telnyxSttStreamSessions.get(callControlId);
          if (previousStreamSession?.ownsRecoveredSttSession) {
            previousStreamSession.ownsRecoveredSttSession = false;
            session.ownsRecoveredSttSession = true;
          }
          globalThis.__telnyxSttStreamSessions.set(callControlId, session);

          logSttInfo("media_ws_start", {
            callControlId: logIdentifier(callControlId),
            streamId: logIdentifier(startData.stream_id || startData.streamId),
            tracks: startData.tracks || null,
            mediaFormat,
            clientStateKeys: Object.keys(clientState || {}),
            callSessionId: logIdentifier(session.callSessionId),
            interactionId: logIdentifier(clientState.interaction_id),
            agentUsername: clientState.agent_username || null,
            telnyxSttTrack: clientState.telnyx_stt_track || null,
            telnyxSttMediaTrack: clientState.telnyx_stt_media_track || null,
            telnyxSttStreamTrack: clientState.telnyx_stt_stream_track || null,
            telnyxSttStreamCodec: clientState.telnyx_stt_stream_codec || null,
            config: summarizeConfig(clientState.telnyx_stt_config || {}),
            hasActiveSession: globalThis.__telnyxSttActiveSessions.has(callControlId),
            activeSessions: globalThis.__telnyxSttActiveSessions.size,
          });

          const providerSessionRecovered = ensureExplicitStreamSttSession(session);
          logSttInfo("media_ws_stt_binding", {
            callControlId: logIdentifier(callControlId),
            interactionId: logIdentifier(session.interactionId),
            telnyxSttTrack: clientState.telnyx_stt_track || null,
            telnyxSttMediaTrack: clientState.telnyx_stt_media_track || null,
            telnyxSttStreamTrack: clientState.telnyx_stt_stream_track || null,
            telnyxSttStreamCodec: clientState.telnyx_stt_stream_codec || null,
            providerSessionRecovered,
            ownsRecoveredSttSession: !!session.ownsRecoveredSttSession,
            hasActiveSession: globalThis.__telnyxSttActiveSessions.has(callControlId),
          });

          break;
        }
        case "media": {
          if (!session || !callControlId) {
            logSttWarn("media_ws_media_without_session", {
              hasSession: !!session,
              callControlId: logIdentifier(callControlId),
            });
            break;
          }
          const track = msg.media?.track;
          const payload = msg.media?.payload;
          if (!track || !payload) {
            logSttWarn("media_ws_media_missing_track_or_payload", {
              callControlId: logIdentifier(callControlId),
              track: track || null,
              hasPayload: !!payload,
            });
            break;
          }

          // If a newer stream WebSocket for this callControlId has started, this
          // connection has been superseded — stop forwarding audio to avoid
          // double-sending the same chunks to Deepgram (causing duplicate bubbles).
          const currentStreamSession = globalThis.__telnyxSttStreamSessions.get(callControlId);
          if (currentStreamSession && currentStreamSession !== session) {
            break;
          }

          session.mediaChunks++;
          const payloadBytes = Buffer.byteLength(payload, "base64");
          session.mediaBytes += payloadBytes;
          const sttTrack = logicalTrack(track);
          session.mediaChunksByTrack[sttTrack]++;
          session.mediaBytesByTrack[sttTrack] += payloadBytes;
          const active = globalThis.__telnyxSttActiveSessions.get(callControlId);
          if (active) {
            const target = active.sessionsByMediaTrack?.[sttTrack] || active[sttTrack];
            if (target) target.sendAudio(payload);
          } else {
            session.bufferAudio(track, payload);
          }
          break;
        }
        case "stop": {
          logSttInfo("media_ws_stop", {
            callControlId: logIdentifier(callControlId),
            mediaChunks: session?.mediaChunks || 0,
            mediaBytes: session?.mediaBytes || 0,
            mediaChunksByTrack: session?.mediaChunksByTrack || {},
            mediaBytesByTrack: session?.mediaBytesByTrack || {},
          });
          if (callControlId) {
            const currentStreamSession = globalThis.__telnyxSttStreamSessions.get(callControlId);
            if (currentStreamSession === session) {
              // Same-runtime sessions remain owned by call.hangup. A streaming
              // worker that recovered its own provider session has no shared
              // process state with that handler, so it must close only that
              // explicitly-owned session before removing the media stream.
              stopRecoveredStreamSttSession(session);
              globalThis.__telnyxSttStreamSessions.delete(callControlId);
            }
          }
          session = null;
          break;
        }
        default:
          break;
      }
    } catch (err) {
      logSttError("media_ws_message_handler_error", {
        callControlId: logIdentifier(callControlId),
        error: err?.message || String(err),
      });
    }
  });

  ws.on("close", () => {
    if (callControlId) {
      logSttInfo("media_ws_close", {
        callControlId: logIdentifier(callControlId),
        mediaChunks: session?.mediaChunks || 0,
        mediaBytes: session?.mediaBytes || 0,
      });
      const currentStreamSession = globalThis.__telnyxSttStreamSessions.get(callControlId);
      if (currentStreamSession === session) {
        stopRecoveredStreamSttSession(session);
        globalThis.__telnyxSttStreamSessions.delete(callControlId);
      }
    }
  });

  ws.on("error", (err) => {
    logSttError("media_ws_error", {
      callControlId: logIdentifier(callControlId),
      error: err?.message || String(err),
    });
  });
}

export async function startTelnyxSttTranscription(callControlId, config, interactionId, agentUsername, options = {}) {
  if (!callControlId || !config?.enabled) return;
  if (globalThis.__telnyxSttActiveSessions.has(callControlId)) {
    logSttInfo("stt_session_already_active", {
      callControlId: logIdentifier(callControlId),
      interactionId: logIdentifier(interactionId),
    });
    return;
  }

  const telnyxSession = globalThis.__telnyxSttStreamSessions.get(callControlId);
  if (telnyxSession && interactionId) telnyxSession.interactionId = interactionId;

  const mediaTrack = options.mediaTrack || "inbound";
  const outputTrack = options.outputTrack || mediaTrack;
  const trackMappings = options.trackMappings || [{ mediaTrack, outputTrack }];
  const flowId = options.flowId || config.flow_id || config.flowId || telnyxSession?.clientState?.flowId || telnyxSession?.clientState?.flow_id || null;
  const callSessionId =
    options.callSessionId ||
    telnyxSession?.callSessionId ||
    telnyxSession?.clientState?.call_session_id ||
    telnyxSession?.clientState?.callSessionId ||
    null;
  const baseOpts = { callControlId, interactionId, agentUsername, config, flowId, callSessionId };
  const active = { sessions: [], sessionsByMediaTrack: {}, interactionId: interactionId || null };

  for (const mapping of trackMappings) {
    const session = new TelnyxSttRealtimeSession({
      ...baseOpts,
      config: mapping.config || config,
      track: mapping.outputTrack,
    });
    active.sessions.push(session);
    active.sessionsByMediaTrack[mapping.mediaTrack] = session;
    // Backward-compatible keys for existing same-leg both_tracks streams.
    active[mapping.mediaTrack] = session;
  }

  globalThis.__telnyxSttActiveSessions.set(callControlId, active);

  logSttInfo("started_telnyx_standalone_stt_sessions", {
    callControlId: logIdentifier(callControlId),
    interactionId: logIdentifier(interactionId),
    agentUsername: agentUsername || null,
    flowId: logIdentifier(flowId),
    hasTelnyxMediaSession: !!telnyxSession,
    mediaTrack,
    outputTrack,
    trackMappings: trackMappings.map(({ mediaTrack: input, outputTrack: output }) => ({
      mediaTrack: input,
      outputTrack: output,
    })),
    config: summarizeConfig(config),
    activeSessions: globalThis.__telnyxSttActiveSessions.size,
    streamSessions: globalThis.__telnyxSttStreamSessions.size,
  });

  for (const session of active.sessions) session.connect();

  if (telnyxSession) {
    const buffers = trackMappings.map(({ mediaTrack: input, outputTrack: output }) => ({
      mediaTrack: input,
      outputTrack: output,
      payloads: telnyxSession.getBuffer(input),
    }));
    const bufferSummary = buffers
      .map((b) => `${b.mediaTrack}->${b.outputTrack}:${b.payloads.length}`)
      .join(", ");

    // Agent Assist live transcription should start at the moment the call legs are
    // connected. Audio captured before that point is usually queue prompts, hold
    // music, or caller speech before the agent is present. Replaying it into the
    // freshly opened STT provider delays the first live bubble and can surface
    // stale prompt audio in Agent Desktop / Monitor. Keep the STT provider
    // pre-warmed from this point forward, but drop the pre-answer media buffer by
    // default. Tests can opt into replayBufferedAudio for compatibility checks.
    if (options.replayBufferedAudio === true) {
      logSttInfo("replaying_pre_answer_buffered_audio", {
        callControlId: logIdentifier(callControlId),
        interactionId: logIdentifier(interactionId),
        bufferSummary,
      });
      setTimeout(() => {
        for (const mapping of buffers) {
          const session = active.sessionsByMediaTrack[mapping.mediaTrack];
          for (const payload of mapping.payloads) session?.sendAudio(payload);
          telnyxSession.clearBuffer(mapping.mediaTrack);
        }
      }, 500);
    } else {
      logSttInfo("dropping_pre_answer_buffered_audio", {
        callControlId: logIdentifier(callControlId),
        interactionId: logIdentifier(interactionId),
        bufferSummary,
      });
      for (const mapping of buffers) {
        telnyxSession.clearBuffer(mapping.mediaTrack);
      }
    }
  }
}

export async function startTelnyxSttMediaStream(
  callControlId,
  config,
  interactionId,
  agentUsername,
  {
    outputTrack = "outbound",
    mediaTrack = "inbound",
    streamTrack = "inbound_track",
    streamCodec = config?.stream_codec || "PCMU",
    sampleRate = config?.sample_rate || 8000,
    callSessionId = null,
  } = {},
) {
  if (!callControlId || !config?.enabled) return;
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    logSttError("media_stream_start_missing_api_key", {
      callControlId: logIdentifier(callControlId),
      interactionId: logIdentifier(interactionId),
      outputTrack,
      mediaTrack,
      streamTrack,
    });
    return;
  }

  const resolvedStreamCodec = normalizeTelnyxSttStreamCodec(streamCodec, "PCMU");
  const mediaConfig = telnyxSttConfigForMediaCodec(
    config,
    resolvedStreamCodec,
    sampleRate,
  );
  const clientState = Buffer.from(JSON.stringify({
    telnyx_stt_config: mediaConfig,
    telnyx_stt_track: outputTrack,
    telnyx_stt_media_track: mediaTrack,
    telnyx_stt_stream_track: streamTrack,
    telnyx_stt_stream_codec: resolvedStreamCodec,
    interaction_id: interactionId || null,
    call_session_id: callSessionId || null,
    agent_username: agentUsername || null,
    flowId: config.flowId || config.flow_id || null,
    flow_id: config.flow_id || config.flowId || null,
  })).toString("base64");

  const commandId = buildAgentLegMediaStreamCommandId(callControlId, {
    outputTrack,
    mediaTrack,
    streamTrack,
    streamCodec: resolvedStreamCodec,
  });
  const knownCommandId = globalThis.__telnyxSttMediaStreamCommandIds.get(callControlId);
  if (knownCommandId === commandId) {
    logSttInfo("media_stream_start_already_sent", {
      callControlId: logIdentifier(callControlId),
      interactionId: logIdentifier(interactionId),
      commandId: logIdentifier(commandId),
      outputTrack,
      mediaTrack,
      streamTrack,
      streamCodec: resolvedStreamCodec,
    });
    return;
  }

  const body = {
    stream_url: buildTelnyxSttStreamUrl(),
    stream_track: streamTrack,
    stream_codec: resolvedStreamCodec,
    client_state: clientState,
    command_id: commandId,
  };

  logSttInfo("starting_telnyx_stt_media_stream", {
    callControlId: logIdentifier(callControlId),
    interactionId: logIdentifier(interactionId),
    agentUsername: agentUsername || null,
    outputTrack,
    mediaTrack,
    commandId: logIdentifier(commandId),
    streamUrl: sanitizeDiagnosticUrl(body.stream_url),
    streamTrack: body.stream_track,
    streamCodec: body.stream_codec,
    providerInputFormat: mediaConfig.input_format,
    providerSampleRate: mediaConfig.sample_rate,
    config: summarizeConfig(mediaConfig),
  });

  const res = await fetch(
    buildTelnyxV2Url(`/calls/${encodeURIComponent(callControlId)}/actions/streaming_start`),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const response = await summarizeHttpErrorResponse(res);
    logSttError("telnyx_stt_media_streaming_start_failed", {
      callControlId: logIdentifier(callControlId),
      interactionId: logIdentifier(interactionId),
      status: res.status,
      statusText: res.statusText,
      response,
      outputTrack,
      mediaTrack,
      streamTrack,
      streamCodec: resolvedStreamCodec,
      commandId: logIdentifier(commandId),
    });
    return;
  }

  globalThis.__telnyxSttMediaStreamCommandIds.set(callControlId, commandId);
  logSttInfo("telnyx_stt_media_streaming_start_accepted", {
    callControlId: logIdentifier(callControlId),
    interactionId: logIdentifier(interactionId),
    status: res.status,
    outputTrack,
    mediaTrack,
    streamTrack,
    streamCodec: resolvedStreamCodec,
    commandId: logIdentifier(commandId),
  });
}

export async function prewarmTelnyxSttAgentLeg(callControlId, config, interactionId, agentUsername) {
  if (!callControlId || !config?.enabled) return;
  const selectedTracks = config.transcription_tracks || "both";
  const wantsOutbound = selectedTracks === "outbound" || selectedTracks === "both";
  if (!wantsOutbound) return;

  let agentLanguage = normalizeAgentSttLanguage(config.language, config);
  if (agentUsername) {
    try {
      const { PgDb } = await import("@/lib/pgdb");
      const agent = await PgDb.findUserByUsername(agentUsername);
      agentLanguage = normalizeAgentSttLanguage(agent?.language, config);
    } catch (error) {
      logSttWarn("agent_language_lookup_failed", {
        callControlId: logIdentifier(callControlId),
        interactionId: logIdentifier(interactionId),
        agentUsername,
        error: error?.message || String(error),
      });
    }
  }
  const outboundConfig = { ...config, transcription_tracks: "outbound", language: agentLanguage };

  logSttInfo("prewarm_agent_leg", {
    callControlId: logIdentifier(callControlId),
    interactionId: logIdentifier(interactionId),
    agentUsername: agentUsername || null,
    selectedTracks,
    agentLanguage,
    config: summarizeConfig(outboundConfig),
  });

  // Prewarm only the Telnyx media fork while the WebRTC leg is ringing. Do not
  // open the provider STT socket yet: on production calls the provider socket
  // could be open for several seconds before the media WebSocket existed, stay
  // nominally active, and then never produce a frame. The media WebSocket start
  // event owns provider-session creation through ensureExplicitStreamSttSession,
  // so the socket is bound on the runtime that actually receives the audio.
  //
  // Preserve the legacy-proven transport-leg media request: Telnyx must expose
  // both physical tracks for the WebRTC microphone to flow on this transferred
  // topology. Only the inbound media track is bound to STT and it is labelled as
  // the logical outbound (agent) speaker, so the opposite track cannot create a
  // duplicate customer transcript.
  await startTelnyxSttMediaStream(
    callControlId,
    outboundConfig,
    interactionId,
    agentUsername,
    {
      streamTrack: "both_tracks",
      mediaTrack: "inbound",
      outputTrack: "outbound",
    },
  );
}

// Soft-stop: close Deepgram sessions and remove from active map WITHOUT clearing
// __telnyxSttMediaStreamCommandIds. Used by the TARGET block so the prewarm's
// both_tracks media stream keeps its commandId dedup entry → the subsequent
// startTelnyxSttMediaStream call recognises it as already sent and
// skips the streaming_start restart that causes ~10s transcription delay.
export function stopTelnyxSttSessions(callControlId) {
  if (!callControlId) return;
  const active = globalThis.__telnyxSttActiveSessions.get(callControlId);
  if (!active) return;
  const sessions = active.sessions || [active.inbound, active.outbound].filter(Boolean);
  logSttInfo("stt_sessions_soft_stop", {
    callControlId: logIdentifier(callControlId),
    sessions: sessions.map((s) => ({ track: s?.track, sentChunks: s?.sentChunks })),
  });
  for (const s of sessions) { try { s?.close(); } catch (_) {} }
  globalThis.__telnyxSttActiveSessions.delete(callControlId);
}

export async function stopTelnyxSttTranscription(callControlId) {
  if (!callControlId) return;
  globalThis.__telnyxSttMediaStreamCommandIds.delete(callControlId);
  globalThis.__telnyxSttBypassLegIds?.delete(callControlId);
  const active = globalThis.__telnyxSttActiveSessions.get(callControlId);
  if (!active) {
    logSttInfo("stt_transcription_stop_without_active", {
      callControlId: logIdentifier(callControlId),
    });
    return;
  }

  const sessions = active.sessions || [active.inbound, active.outbound].filter(Boolean);
  logSttInfo("stt_transcription_stop", {
    callControlId: logIdentifier(callControlId),
    sessions: sessions.map((session) => ({
      track: session?.track,
      sentChunks: session?.sentChunks,
      sentBytes: session?.sentBytes,
      pendingAudio: session?.pendingAudio?.length || 0,
      providerMessages: session?.providerMessages,
      providerFrames: session?.providerFrames,
      nonTranscriptFrames: session?.nonTranscriptFrames,
      receivedTranscripts: session?.receivedTranscripts,
    })),
  });
  for (const session of sessions) {
    try { session?.close(); } catch (_) {}
  }
  globalThis.__telnyxSttActiveSessions.delete(callControlId);
  globalThis.__telnyxSttMediaStreamCommandIds.delete(callControlId);
}

export const __telnyxSttTestUtils = {
  normalizeTranscriptionTracks,
  selectedTrackLabels,
  buildTelnyxSttStreamUrl,
  sanitizeDiagnosticValue,
  summarizeProviderFrame,
  normalizeTranscriptFrame,
  normalizeTelnyxSttWebSocketModel,
  normalizeTelnyxSttWebSocketLanguage,
  normalizeAgentSttLanguage,
  normalizeTelnyxSttStreamCodec,
  telnyxSttConfigForMediaCodec,
  telnyxSttConfigForMediaFormat,
  logIdentifier,
  explicitStreamTrackMappings,
  ensureExplicitStreamSttSession,
  stopRecoveredStreamSttSession,
};
