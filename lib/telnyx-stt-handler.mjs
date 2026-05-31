import WebSocket from "ws";

if (!globalThis.__telnyxSttStreamSessions) globalThis.__telnyxSttStreamSessions = new Map();
if (!globalThis.__telnyxSttActiveSessions) globalThis.__telnyxSttActiveSessions = new Map();

const TELNYX_STT_WS_URL = "wss://api.telnyx.com/v2/speech-to-text/transcription";

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

async function broadcastTranscription(agentUsername, payload) {
  if (!agentUsername) return;
  try {
    const { broadcastToKey } = await import("./sse.js");
    await broadcastToKey(`contact-center:agent:${agentUsername}`, payload);
  } catch (e) {
    console.warn("[TelnyxSTT] SSE broadcast failed:", e.message);
  }
}

function normalizeTranscriptFrame(frame) {
  if (!frame || typeof frame !== "object") return null;

  let transcript = "";
  let isFinal = false;
  let confidence = null;

  if (typeof frame.transcript === "string") {
    transcript = frame.transcript;
    isFinal = !!(frame.is_final || frame.speech_final || frame.final);
    confidence = frame.confidence ?? null;
  } else if (frame.channel?.alternatives?.[0]?.transcript) {
    const alt = frame.channel.alternatives[0];
    transcript = alt.transcript;
    isFinal = !!(frame.is_final || frame.speech_final || frame.final);
    confidence = alt.confidence ?? null;
  } else if (frame.type === "transcription" && frame.transcription?.transcript) {
    transcript = frame.transcription.transcript;
    isFinal = !!frame.transcription.is_final;
    confidence = frame.transcription.confidence ?? null;
  } else if (frame.type === "Results" && frame.channel?.alternatives?.[0]?.transcript) {
    const alt = frame.channel.alternatives[0];
    transcript = alt.transcript;
    isFinal = !!(frame.is_final || frame.speech_final || frame.final);
    confidence = alt.confidence ?? null;
  }

  transcript = compactText(transcript);
  if (!transcript) return null;
  return { transcript, isFinal, confidence, rawType: frame.type || frame.event || null };
}

class TelnyxSttRealtimeSession {
  constructor({ callControlId, interactionId, agentUsername, config, track = "inbound" }) {
    this.callControlId = callControlId;
    this.interactionId = interactionId;
    this.agentUsername = agentUsername;
    this.config = config || {};
    this.track = track;
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.pendingAudio = [];
    this.sentChunks = 0;
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

    this.ws.on("message", (data) => {
      try {
        const str = data.toString();
        let msg;
        try { msg = JSON.parse(str); } catch { msg = { raw: str }; }
        if (msg?.errors?.length) {
          console.warn(`[TelnyxSTT] Provider errors track=${this.track}:`, JSON.stringify(msg.errors));
          return;
        }
        const frames = Array.isArray(msg) ? msg : [msg];
        for (const frame of frames) {
          const normalized = normalizeTranscriptFrame(frame);
          if (!normalized) continue;
          this.receivedTranscripts++;
          const payload = {
            type: "transcription",
            interactionId: this.interactionId,
            callControlId: this.callControlId,
            transcription: {
              transcript: normalized.transcript,
              track: this.track,
              is_final: normalized.isFinal,
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
            },
          };
          broadcastTranscription(this.agentUsername, payload);
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
      console.log(`[TelnyxSTT] Closed track=${this.track}, callControlId=${this.callControlId}, code=${code}, reason="${reason?.toString?.() || ""}", sent=${this.sentChunks}, transcripts=${this.receivedTranscripts}`);
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
      this.ws.send(Buffer.from(payloadBase64, "base64"));
      this.sentChunks++;
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
          console.log(`[TelnyxSTT] Telnyx stream registered callControlId=${callControlId}`);
          break;
        }
        case "media": {
          if (!session || !callControlId) break;
          const track = msg.media?.track;
          const payload = msg.media?.payload;
          if (!track || !payload) break;

          const active = globalThis.__telnyxSttActiveSessions.get(callControlId);
          if (active) {
            const sttTrack = logicalTrack(track);
            active[sttTrack]?.sendAudio(payload);
          } else {
            session.bufferAudio(track, payload);
          }
          break;
        }
        case "stop": {
          console.log(`[TelnyxSTT] Telnyx stream stopped callControlId=${callControlId}`);
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
    if (callControlId) globalThis.__telnyxSttStreamSessions.delete(callControlId);
  });

  ws.on("error", (err) => {
    console.error("[TelnyxSTT] Telnyx WS error:", err.message);
  });
}

export async function startTelnyxSttTranscription(callControlId, config, interactionId, agentUsername) {
  if (!callControlId || !config?.enabled) return;
  if (globalThis.__telnyxSttActiveSessions.has(callControlId)) {
    console.log(`[TelnyxSTT] Already active for ${callControlId}`);
    return;
  }

  const telnyxSession = globalThis.__telnyxSttStreamSessions.get(callControlId);
  if (telnyxSession && interactionId) telnyxSession.interactionId = interactionId;

  const baseOpts = { callControlId, interactionId, agentUsername, config };
  const inboundSession = new TelnyxSttRealtimeSession({ ...baseOpts, track: "inbound" });
  const outboundSession = new TelnyxSttRealtimeSession({ ...baseOpts, track: "outbound" });

  globalThis.__telnyxSttActiveSessions.set(callControlId, {
    inbound: inboundSession,
    outbound: outboundSession,
  });

  console.log(`[TelnyxSTT] Starting callControlId=${callControlId}, interactionId=${interactionId}, agent=${agentUsername}, engine=${config.transcription_engine}, model=${config.model}`);
  inboundSession.connect();
  outboundSession.connect();

  if (telnyxSession) {
    const inboundBuffer = telnyxSession.getBuffer("inbound");
    const outboundBuffer = telnyxSession.getBuffer("outbound");
    console.log(`[TelnyxSTT] Flushing buffers inbound=${inboundBuffer.length}, outbound=${outboundBuffer.length}`);
    setTimeout(() => {
      for (const payload of inboundBuffer) inboundSession.sendAudio(payload);
      for (const payload of outboundBuffer) outboundSession.sendAudio(payload);
      telnyxSession.clearBuffer("inbound");
      telnyxSession.clearBuffer("outbound");
    }, 500);
  }
}

export async function stopTelnyxSttTranscription(callControlId) {
  if (!callControlId) return;
  const active = globalThis.__telnyxSttActiveSessions.get(callControlId);
  if (!active) return;
  console.log(`[TelnyxSTT] Stopping callControlId=${callControlId}`);
  try { active.inbound?.close(); } catch (_) {}
  try { active.outbound?.close(); } catch (_) {}
  globalThis.__telnyxSttActiveSessions.delete(callControlId);
}
