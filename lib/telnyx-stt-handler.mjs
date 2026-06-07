import WebSocket from "ws";
import { createHash } from "node:crypto";
import { buildTelnyxV2Url } from "./telnyx.js";
import {
  createDiagnosticLogger,
  sanitizeDiagnosticPayload,
  sanitizeDiagnosticUrl,
} from "./diagnostic-logger.mjs";

if (!globalThis.__telnyxSttStreamSessions) globalThis.__telnyxSttStreamSessions = new Map();
if (!globalThis.__telnyxSttActiveSessions) globalThis.__telnyxSttActiveSessions = new Map();
if (!globalThis.__telnyxSttMediaStreamCommandIds) globalThis.__telnyxSttMediaStreamCommandIds = new Map();

const TELNYX_STT_WS_URL = "wss://api.telnyx.com/v2/speech-to-text/transcription";
const sttLogger = createDiagnosticLogger("telnyx.stt");

function logSttDebug(message, payload = {}) {
  sttLogger.debug(message, payload);
}

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
    input_format: config.input_format,
    sample_rate: config.sample_rate,
    interim_results: config.interim_results,
    endpointing: config.endpointing,
    transcription_tracks: config.transcription_tracks,
    flowId: config.flowId || config.flow_id || null,
  });
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

function buildAgentLegMediaStreamCommandId(callControlId, outputTrack = "outbound") {
  return buildStableCommandId("telnyx-stt-agent-leg-media-stream", callControlId, outputTrack);
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
  constructor({ callControlId, interactionId, agentUsername, config, flowId = null, track = "inbound" }) {
    this.callControlId = callControlId;
    this.interactionId = interactionId;
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
  }

  buildUrl() {
    const params = new URLSearchParams();
    params.set("transcription_engine", this.config.transcription_engine || "Google");
    params.set("input_format", this.config.input_format || "mulaw");
    params.set("sample_rate", String(this.config.sample_rate || 8000));
    params.set("language", this.config.language || "en-US");
    if (this.config.model && this.config.model !== "default") params.set("model", this.config.model);
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
            if (this.nonTranscriptFrames <= 20 || this.nonTranscriptFrames % 50 === 0) {
              logSttDebug("provider_socket_non_transcript_frame", {
                callControlId: logIdentifier(this.callControlId),
                interactionId: logIdentifier(this.interactionId),
                track: this.track,
                providerMessages: this.providerMessages,
                providerFrames: this.providerFrames,
                nonTranscriptFrames: this.nonTranscriptFrames,
                frame: summarizeProviderFrame(frame),
              });
            }
            continue;
          }
          this.receivedTranscripts++;
          if (this.receivedTranscripts <= 5 || this.receivedTranscripts % 25 === 0) {
            logSttInfo("provider_socket_transcript", {
              callControlId: logIdentifier(this.callControlId),
              interactionId: logIdentifier(this.interactionId),
              track: this.track,
              isFinal: normalized.isFinal,
              speechFinal: normalized.speechFinal,
              confidence: normalized.confidence,
              transcript: normalized.transcript,
              transcriptLength: normalized.transcript.length,
              rawType: normalized.rawType,
              receivedTranscripts: this.receivedTranscripts,
            });
          }
          const payload = {
            type: "transcription",
            source: "telnyx_standalone_stt_websocket",
            interactionId: this.interactionId,
            callControlId: this.callControlId,
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
      this.connected = false;
      this.closed = true;
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
      });
    });
  }

  sendAudio(payloadBase64) {
    if (!payloadBase64 || this.closed) return;
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingAudio.push(payloadBase64);
      if (this.pendingAudio.length > 600) this.pendingAudio.shift();
      if (this.pendingAudio.length <= 3 || this.pendingAudio.length % 200 === 0) {
        logSttDebug("provider_socket_audio_buffered", {
          callControlId: logIdentifier(this.callControlId),
          interactionId: logIdentifier(this.interactionId),
          track: this.track,
          pendingAudio: this.pendingAudio.length,
          connected: this.connected,
          readyState: this.ws?.readyState ?? null,
        });
      }
      return;
    }
    try {
      const audioBuffer = Buffer.from(payloadBase64, "base64");
      this.ws.send(audioBuffer);
      this.sentChunks++;
      this.sentBytes += audioBuffer.length;
      if (this.sentChunks <= 3 || this.sentChunks % 500 === 0) {
        logSttDebug("provider_socket_audio_sent", {
          callControlId: logIdentifier(this.callControlId),
          interactionId: logIdentifier(this.interactionId),
          track: this.track,
          sentChunks: this.sentChunks,
          sentBytes: this.sentBytes,
          lastChunkBytes: audioBuffer.length,
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
  constructor(callControlId, clientState) {
    this.callControlId = callControlId;
    this.clientState = clientState || {};
    this.interactionId = null;
    this.audioBuffer = { inbound_track: [], outbound_track: [], inbound: [], outbound: [] };
    this.mediaChunks = 0;
    this.mediaBytes = 0;
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
          session = new TelnyxSttStreamSession(callControlId, clientState);
          globalThis.__telnyxSttStreamSessions.set(callControlId, session);

          logSttInfo("media_ws_start", {
            callControlId: logIdentifier(callControlId),
            streamId: logIdentifier(startData.stream_id || startData.streamId),
            tracks: startData.tracks || null,
            mediaFormat: startData.media_format || startData.mediaFormat || null,
            clientStateKeys: Object.keys(clientState || {}),
            interactionId: logIdentifier(clientState.interaction_id),
            agentUsername: clientState.agent_username || null,
            telnyxSttTrack: clientState.telnyx_stt_track || null,
            config: summarizeConfig(clientState.telnyx_stt_config || {}),
            hasActiveSession: globalThis.__telnyxSttActiveSessions.has(callControlId),
            activeSessions: globalThis.__telnyxSttActiveSessions.size,
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

          session.mediaChunks++;
          const payloadBytes = Buffer.byteLength(payload, "base64");
          session.mediaBytes += payloadBytes;
          const active = globalThis.__telnyxSttActiveSessions.get(callControlId);
          if (session.mediaChunks <= 3 || session.mediaChunks % 500 === 0) {
            const route = active ? "active-stt" : "buffer";
            const sttTrack = logicalTrack(track);
            const target = active?.sessionsByMediaTrack?.[sttTrack] || active?.[sttTrack] || null;
            logSttDebug("media_ws_media", {
              callControlId: logIdentifier(callControlId),
              track,
              sttTrack,
              route,
              hasTarget: !!target,
              targetTrack: target?.track || null,
              mediaChunks: session.mediaChunks,
              mediaBytes: session.mediaBytes,
              lastChunkBytes: payloadBytes,
              activeKeys: active ? Object.keys(active.sessionsByMediaTrack || {}) : [],
            });
          }
          if (active) {
            const sttTrack = logicalTrack(track);
            const target = active.sessionsByMediaTrack?.[sttTrack] || active[sttTrack];
            if (target) target.sendAudio(payload);
            else {
              logSttWarn("media_ws_no_target_for_track", {
                callControlId: logIdentifier(callControlId),
                track,
                sttTrack,
                activeKeys: Object.keys(active.sessionsByMediaTrack || {}),
              });
            }
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
          });
          if (callControlId) {
            globalThis.__telnyxSttStreamSessions.delete(callControlId);
            stopTelnyxSttTranscription(callControlId).catch(() => {});
          }
          session = null;
          break;
        }
        default:
          logSttDebug("media_ws_unhandled_event", {
            event: msg.event || null,
            callControlId: logIdentifier(callControlId),
            keys: Object.keys(msg || {}),
          });
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
      globalThis.__telnyxSttStreamSessions.delete(callControlId);
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
    logSttInfo("STT session already active", {
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
  const baseOpts = { callControlId, interactionId, agentUsername, config, flowId };
  const active = { sessions: [], sessionsByMediaTrack: {} };

  for (const mapping of trackMappings) {
    const session = new TelnyxSttRealtimeSession({
      ...baseOpts,
      track: mapping.outputTrack,
    });
    active.sessions.push(session);
    active.sessionsByMediaTrack[mapping.mediaTrack] = session;
    // Backward-compatible keys for existing same-leg both_tracks streams.
    active[mapping.mediaTrack] = session;
  }

  globalThis.__telnyxSttActiveSessions.set(callControlId, active);

  logSttInfo("Started Telnyx standalone STT sessions", {
    callControlId: logIdentifier(callControlId),
    interactionId: logIdentifier(interactionId),
    agentUsername: agentUsername || null,
    flowId: logIdentifier(flowId),
    hasTelnyxMediaSession: !!telnyxSession,
    mediaTrack,
    outputTrack,
    trackMappings,
    config: summarizeConfig(config),
    activeSessions: globalThis.__telnyxSttActiveSessions.size,
    streamSessions: globalThis.__telnyxSttStreamSessions.size,
  });

  for (const session of active.sessions) session.connect();

  if (telnyxSession) {
    const buffers = trackMappings.map((mapping) => ({
      ...mapping,
      payloads: telnyxSession.getBuffer(mapping.mediaTrack),
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
      logSttInfo("Replaying pre-answer buffered audio", {
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
      logSttInfo("Dropping pre-answer buffered audio", {
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

export async function startTelnyxSttMediaStream(callControlId, config, interactionId, agentUsername, outputTrack = "outbound") {
  if (!callControlId || !config?.enabled) return;
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    logSttError("media_stream_start_missing_api_key", {
      callControlId: logIdentifier(callControlId),
      interactionId: logIdentifier(interactionId),
      outputTrack,
    });
    return;
  }

  const clientState = Buffer.from(JSON.stringify({
    telnyx_stt_config: config,
    telnyx_stt_track: outputTrack,
    interaction_id: interactionId || null,
    agent_username: agentUsername || null,
    flowId: config.flowId || config.flow_id || null,
    flow_id: config.flow_id || config.flowId || null,
  })).toString("base64");

  const commandId = buildAgentLegMediaStreamCommandId(callControlId, outputTrack);
  const knownCommandId = globalThis.__telnyxSttMediaStreamCommandIds.get(callControlId);
  if (knownCommandId === commandId) {
    logSttInfo("media_stream_start_already_sent", {
      callControlId: logIdentifier(callControlId),
      interactionId: logIdentifier(interactionId),
      commandId: logIdentifier(commandId),
      outputTrack,
    });
    return;
  }

  const body = {
    stream_url: buildTelnyxSttStreamUrl(),
    stream_track: "inbound_track",
    stream_codec: "PCMU",
    client_state: clientState,
    command_id: commandId,
  };

  logSttInfo("Starting Telnyx STT media stream", {
    callControlId: logIdentifier(callControlId),
    interactionId: logIdentifier(interactionId),
    agentUsername: agentUsername || null,
    outputTrack,
    commandId: logIdentifier(commandId),
    streamUrl: sanitizeDiagnosticUrl(body.stream_url),
    streamTrack: body.stream_track,
    streamCodec: body.stream_codec,
    config: summarizeConfig(config),
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
    logSttError("Telnyx STT media streaming_start failed", {
      callControlId: logIdentifier(callControlId),
      interactionId: logIdentifier(interactionId),
      status: res.status,
      statusText: res.statusText,
      response,
      outputTrack,
      commandId: logIdentifier(commandId),
    });
    return;
  }

  globalThis.__telnyxSttMediaStreamCommandIds.set(callControlId, commandId);
  logSttInfo("Telnyx STT media streaming_start accepted", {
    callControlId: logIdentifier(callControlId),
    interactionId: logIdentifier(interactionId),
    status: res.status,
    outputTrack,
    commandId: logIdentifier(commandId),
  });
}

export async function prewarmTelnyxSttAgentLeg(callControlId, config, interactionId, agentUsername) {
  if (!callControlId || !config?.enabled) return;
  const selectedTracks = config.transcription_tracks || "both";
  const wantsOutbound = selectedTracks === "outbound" || selectedTracks === "both";
  if (!wantsOutbound) return;

  let agentLanguage = config.language || "en-US";
  if (agentUsername) {
    try {
      const { PgDb } = await import("@/lib/pgdb");
      const agent = await PgDb.findUserByUsername(agentUsername);
      agentLanguage = agent?.language || agentLanguage;
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

  // Open the provider socket immediately while the WebRTC leg is ringing. If Telnyx
  // accepts streaming_start on the ringing leg, media will arrive as soon as the
  // agent answers. If it rejects until answered, the call.answered path retries the
  // same idempotent command and reuses the already-warmed provider socket.
  await startTelnyxSttTranscription(
    callControlId,
    outboundConfig,
    interactionId,
    agentUsername,
    { mediaTrack: "inbound", outputTrack: "outbound" },
  );
  await startTelnyxSttMediaStream(callControlId, outboundConfig, interactionId, agentUsername, "outbound");
}

export async function stopTelnyxSttTranscription(callControlId) {
  if (!callControlId) return;
  globalThis.__telnyxSttMediaStreamCommandIds.delete(callControlId);
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
  logIdentifier,
};
