import WebSocket from "ws";
import { createHash } from "node:crypto";
import { buildTelnyxV2Url } from "./telnyx.js";

if (!globalThis.__telnyxSttStreamSessions) globalThis.__telnyxSttStreamSessions = new Map();
if (!globalThis.__telnyxSttActiveSessions) globalThis.__telnyxSttActiveSessions = new Map();
if (!globalThis.__telnyxSttMediaStreamCommandIds) globalThis.__telnyxSttMediaStreamCommandIds = new Map();

const TELNYX_STT_WS_URL = "wss://api.telnyx.com/v2/speech-to-text/transcription";

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
    console.warn("[TelnyxSTT] Agent Assist transcription routing failed:", e.message);
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
    console.warn("[TelnyxSTT] Monitor event write failed:", e.message);
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
      console.warn("[TelnyxSTT] TELNYX_API_KEY not configured — cannot start STT WebSocket");
      return;
    }

    const url = this.buildUrl();
    const safeUrl = url.replace(/([?&]api_key=)[^&]+/i, "$1[REDACTED]");
    console.log(`[TelnyxSTT] Connecting track=${this.track}, callControlId=${this.callControlId}, url=${safeUrl}`);

    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });

    this.ws.on("open", () => {
      this.connected = true;
      console.log(`[TelnyxSTT] ✅ Connected track=${this.track}, callControlId=${this.callControlId}`);
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
          console.warn(`[TelnyxSTT] Provider error frame track=${this.track}, callControlId=${this.callControlId}: ${JSON.stringify(summarizeProviderFrame(msg))}`);
          return;
        }
        const frames = Array.isArray(msg) ? msg : [msg];
        for (const frame of frames) {
          this.providerFrames++;
          const normalized = normalizeTranscriptFrame(frame);
          if (!normalized) {
            this.nonTranscriptFrames++;
            if (this.nonTranscriptFrames <= 20 || this.nonTranscriptFrames % 50 === 0) {
              console.log(`[TelnyxSTT] Provider non-transcript frame track=${this.track}, callControlId=${this.callControlId}, frame=${this.nonTranscriptFrames}: ${JSON.stringify(summarizeProviderFrame(frame))}`);
            }
            continue;
          }
          this.receivedTranscripts++;
          if (this.receivedTranscripts <= 5 || this.receivedTranscripts % 25 === 0) {
            console.log(`[TelnyxSTT] Provider transcript frame track=${this.track}, callControlId=${this.callControlId}, count=${this.receivedTranscripts}, rawType=${normalized.rawType || "unknown"}, final=${normalized.isFinal}, confidence=${normalized.confidence ?? "n/a"}`);
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
        console.warn(`[TelnyxSTT] Error handling provider message track=${this.track}:`, e.message);
      }
    });

    this.ws.on("error", (err) => {
      console.error(`[TelnyxSTT] ❌ WS error track=${this.track}:`, err.message);
    });

    this.ws.on("close", (code, reason) => {
      this.connected = false;
      this.closed = true;
      console.log(`[TelnyxSTT] Closed track=${this.track}, callControlId=${this.callControlId}, code=${code}, reason="${reason?.toString?.() || ""}", sent=${this.sentChunks}, sentBytes=${this.sentBytes}, providerMessages=${this.providerMessages}, providerFrames=${this.providerFrames}, nonTranscriptFrames=${this.nonTranscriptFrames}, transcripts=${this.receivedTranscripts}`);
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
      if (this.sentChunks <= 3 || this.sentChunks % 500 === 0) {
        console.log(`[TelnyxSTT] Sent audio track=${this.track}, callControlId=${this.callControlId}, chunks=${this.sentChunks}, bytes=${this.sentBytes}, lastBytes=${audioBuffer.length}`);
      }
    } catch (e) {
      console.warn(`[TelnyxSTT] Failed sending audio track=${this.track}:`, e.message);
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

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.event) {
        case "start": {
          const startData = msg.start || {};
          callControlId = startData.call_control_id;
          if (!callControlId) {
            console.warn("[TelnyxSTT] Missing call_control_id in start event");
            break;
          }
          const clientState = parseClientState(startData.client_state);
          session = new TelnyxSttStreamSession(callControlId, clientState);
          globalThis.__telnyxSttStreamSessions.set(callControlId, session);
          console.log(`[TelnyxSTT] Telnyx stream registered callControlId=${callControlId}, streamId=${startData.stream_id || "n/a"}, tracks=${startData.tracks || "n/a"}, clientStateKeys=${Object.keys(clientState).join(",") || "none"}, hasSttConfig=${!!clientState.telnyx_stt_config}`);
          break;
        }
        case "media": {
          if (!session || !callControlId) break;
          const track = msg.media?.track;
          const payload = msg.media?.payload;
          if (!track || !payload) break;

          session.mediaChunks++;
          const payloadBytes = Buffer.byteLength(payload, "base64");
          session.mediaBytes += payloadBytes;
          const active = globalThis.__telnyxSttActiveSessions.get(callControlId);
          if (session.mediaChunks <= 3 || session.mediaChunks % 500 === 0) {
            const route = active ? "active-stt" : "buffer";
            console.log(`[TelnyxSTT] Telnyx media received callControlId=${callControlId}, track=${track}, route=${route}, chunks=${session.mediaChunks}, bytes=${session.mediaBytes}, lastBytes=${payloadBytes}`);
          }
          if (active) {
            const sttTrack = logicalTrack(track);
            const target = active.sessionsByMediaTrack?.[sttTrack] || active[sttTrack];
            target?.sendAudio(payload);
          } else {
            session.bufferAudio(track, payload);
          }
          break;
        }
        case "stop": {
          console.log(`[TelnyxSTT] Telnyx stream stopped callControlId=${callControlId}, mediaChunks=${session?.mediaChunks || 0}, mediaBytes=${session?.mediaBytes || 0}`);
          if (callControlId) {
            globalThis.__telnyxSttStreamSessions.delete(callControlId);
            stopTelnyxSttTranscription(callControlId).catch(() => {});
          }
          session = null;
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error("[TelnyxSTT] Error processing Telnyx message:", err.message);
    }
  });

  ws.on("close", () => {
    if (callControlId) {
      console.log(`[TelnyxSTT] Telnyx stream socket closed callControlId=${callControlId}, mediaChunks=${session?.mediaChunks || 0}, mediaBytes=${session?.mediaBytes || 0}`);
      globalThis.__telnyxSttStreamSessions.delete(callControlId);
    }
  });

  ws.on("error", (err) => {
    console.error("[TelnyxSTT] Telnyx WS error:", err.message);
  });
}

export async function startTelnyxSttTranscription(callControlId, config, interactionId, agentUsername, options = {}) {
  if (!callControlId || !config?.enabled) return;
  if (globalThis.__telnyxSttActiveSessions.has(callControlId)) {
    console.log(`[TelnyxSTT] Already active for ${callControlId}`);
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

  console.log(`[TelnyxSTT] Starting callControlId=${callControlId}, interactionId=${interactionId}, agent=${agentUsername}, engine=${config.transcription_engine}, model=${config.model}, tracks=${trackMappings.map((t) => `${t.mediaTrack}->${t.outputTrack}`).join(",")}`);
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
      console.log(`[TelnyxSTT] Replaying buffered audio ${bufferSummary}`);
      setTimeout(() => {
        for (const mapping of buffers) {
          const session = active.sessionsByMediaTrack[mapping.mediaTrack];
          for (const payload of mapping.payloads) session?.sendAudio(payload);
          telnyxSession.clearBuffer(mapping.mediaTrack);
        }
      }, 500);
    } else {
      console.log(`[TelnyxSTT] Dropping pre-answer buffered audio ${bufferSummary}`);
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
    console.warn("[TelnyxSTT] TELNYX_API_KEY not configured — cannot start agent-leg media stream");
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
    console.log(`[TelnyxSTT] Agent-leg media stream command already accepted callControlId=${callControlId}, outputTrack=${outputTrack}`);
    return;
  }

  const body = {
    stream_url: buildTelnyxSttStreamUrl(),
    stream_track: "inbound_track",
    stream_codec: "PCMU",
    client_state: clientState,
    command_id: commandId,
  };

  console.log(`[TelnyxSTT] Starting media stream callControlId=${callControlId}, outputTrack=${outputTrack}, stream_track=inbound_track, commandId=${commandId}`);
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
    const text = await res.text().catch(() => "");
    console.warn(`[TelnyxSTT] Agent-leg streaming_start failed status=${res.status}: ${text.slice(0, 500)}`);
    return;
  }

  globalThis.__telnyxSttMediaStreamCommandIds.set(callControlId, commandId);
}

export async function prewarmTelnyxSttAgentLeg(callControlId, config, interactionId, agentUsername) {
  if (!callControlId || !config?.enabled) return;
  const selectedTracks = config.transcription_tracks || "both";
  const wantsOutbound = selectedTracks === "outbound" || selectedTracks === "both";
  if (!wantsOutbound) return;

  const outboundConfig = { ...config, transcription_tracks: "outbound" };
  console.log(`[TelnyxSTT] Prewarming agent leg callControlId=${callControlId}, interactionId=${interactionId}, agent=${agentUsername}, engine=${outboundConfig.transcription_engine}, model=${outboundConfig.model}`);

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
  if (!active) return;
  console.log(`[TelnyxSTT] Stopping callControlId=${callControlId}`);
  const sessions = active.sessions || [active.inbound, active.outbound].filter(Boolean);
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
};
