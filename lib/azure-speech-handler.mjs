/**
 * Azure Speech Transcription + Translation handler for Contact Center.
 *
 * Architecture:
 * - Telnyx streams audio (PCMU 8kHz both tracks) to our WS server → /streaming/azure
 * - This handler buffers audio per callControlId + track
 * - When call.answered fires (agent picks up), webhook-handler calls startAzureTranscription()
 * - Two AzureSpeechSession instances are created: one for inbound (caller), one for outbound (agent)
 * - Each session connects to Azure via WebSocket, sends audio, receives transcription + translation
 * - Results are normalized and broadcast via SSE to the agent desktop
 *
 * Endpoints used:
 * - STT only:   wss://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
 * - STT+Transl: wss://{region}.s2s.speech.microsoft.com/speech/translation/cognitiveservices/v1
 *
 * Audio format: PCMU 8kHz → PCM16 LE 8kHz → sent as audio/x-wav binary frames
 *
 * ESM module — imported from streaming-ws-handler.mjs and webhook-handler.js
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";

// ─── Global state ─────────────────────────────────────────────────────────────

if (!globalThis.__azureTelnyxSessions) {
  globalThis.__azureTelnyxSessions = new Map(); // callControlId → TelnyxStreamSession
}
if (!globalThis.__azureActiveSessions) {
  globalThis.__azureActiveSessions = new Map(); // callControlId → { inbound, outbound }
}

// ─── PCMU → PCM16 conversion (G.711 μ-law decode) ────────────────────────────

const ULAW_TO_LINEAR = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let ulaw = ~i & 0xff;
    const sign = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

function pcmuToPcm16(pcmuBuffer) {
  const output = Buffer.alloc(pcmuBuffer.length * 2);
  for (let i = 0; i < pcmuBuffer.length; i++) {
    output.writeInt16LE(ULAW_TO_LINEAR[pcmuBuffer[i]], i * 2);
  }
  return output;
}

// Build a minimal WAV header for raw PCM16 mono 8kHz
function buildWavHeader(pcmByteLength) {
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + pcmByteLength, 4);
  hdr.write("WAVE", 8);
  hdr.write("fmt ", 12);
  hdr.writeUInt32LE(16, 16);        // PCM chunk size
  hdr.writeUInt16LE(1, 20);         // PCM format
  hdr.writeUInt16LE(1, 22);         // channels = 1
  hdr.writeUInt32LE(8000, 24);      // sample rate
  hdr.writeUInt32LE(16000, 28);     // byte rate (8000 * 1 * 2)
  hdr.writeUInt16LE(2, 32);         // block align
  hdr.writeUInt16LE(16, 34);        // bits per sample
  hdr.write("data", 36);
  hdr.writeUInt32LE(pcmByteLength, 40);
  return hdr;
}

// ─── SSE broadcast helper ─────────────────────────────────────────────────────

async function broadcastTranscription(agentUsername, payload) {
  if (!agentUsername) return;
  try {
    const { broadcastToKey } = await import("./sse.js");
    await broadcastToKey(`contact-center:agent:${agentUsername}`, payload);
  } catch (e) {
    console.warn("[AzureSpeech] SSE broadcast failed:", e.message);
  }
}

// ─── Azure Speech Session ─────────────────────────────────────────────────────

class AzureSpeechSession {
  /**
   * @param {object} opts
   * @param {string} opts.region
   * @param {string} opts.apiKey
   * @param {string} opts.track - "inbound" | "outbound"
   * @param {object} opts.config - { translationEnabled, sourceLanguage, targetLanguage }
   * @param {string} opts.callControlId
   * @param {string} opts.interactionId
   * @param {string} opts.agentUsername
   */
  constructor({ region, apiKey, track, config, callControlId, interactionId, agentUsername }) {
    this.region = region;
    this.apiKey = apiKey;
    this.track = track;
    this.config = config;
    this.callControlId = callControlId;
    this.interactionId = interactionId;
    this.agentUsername = agentUsername;
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.pendingAudio = [];
    this._audioChunkCount = 0;
    // Track first WAV header: send WAV header only in the very first audio binary frame
    this._firstChunkSent = false;
  }

  _buildUrl() {
    if (this.config.translationEnabled) {
      // Speech Translation endpoint: s2s domain
      // from = source language (e.g. pl-PL, en-US), to = target language
      const params = new URLSearchParams({
        from: this.config.sourceLanguage || "en-US",
        to: this.config.targetLanguage || "en",
        format: "detailed",
        profanity: "Masked",
        features: "partial",
      });
      return `wss://${this.region}.s2s.speech.microsoft.com/speech/translation/cognitiveservices/v1?${params}`;
    } else {
      // Standard STT endpoint: v1
      const params = new URLSearchParams({
        language: this.config.sourceLanguage || "en-US",
        format: "detailed",
        profanity: "raw",
      });
      return `wss://${this.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?${params}`;
    }
  }

  connect() {
    if (this.closed) return;

    const url = this._buildUrl();
    console.log(`[AzureSpeech] Connecting (track=${this.track}, translationEnabled=${this.config.translationEnabled})`);
    console.log(`[AzureSpeech] URL: ${url}`);

    this.ws = new WebSocket(url, {
      headers: { "Ocp-Apim-Subscription-Key": this.apiKey },
    });

    this.ws.on("open", () => {
      console.log(`[AzureSpeech] ✅ Connected (track=${this.track})`);
      this._sendSpeechConfig();
    });

    this.ws.on("message", (data) => {
      try {
        this._handleMessage(data);
      } catch (e) {
        console.warn(`[AzureSpeech] Error processing message (track=${this.track}):`, e.message);
      }
    });

    this.ws.on("error", (err) => {
      console.error(`[AzureSpeech] ❌ WS error (track=${this.track}):`, err.message);
    });

    this.ws.on("close", (code, reason) => {
      const reasonStr = reason ? reason.toString() : "";
      console.log(`[AzureSpeech] Closed (track=${this.track}, code=${code}, reason="${reasonStr}")`);
      this.connected = false;
      this.closed = true;
    });
  }

  _buildTextMsg(path, bodyObj) {
    const requestId = randomUUID().replace(/-/g, "");
    const timestamp = new Date().toISOString();
    const headers = [
      `Path: ${path}`,
      `Content-Type: application/json; charset=utf-8`,
      `X-RequestId: ${requestId}`,
      `X-Timestamp: ${timestamp}`,
    ].join("\r\n");
    return `${headers}\r\n\r\n${JSON.stringify(bodyObj)}`;
  }

  /**
   * Build binary audio frame per Azure WebSocket protocol:
   * [uint16BE: header_length][header_bytes (no spaces after colons)][audio_bytes]
   */
  _buildAudioMsg(audioBuffer) {
    const requestId = randomUUID().replace(/-/g, "");
    const timestamp = new Date().toISOString();
    // Azure SDK format: no spaces after colons in binary headers
    const headerStr = `Path:audio\r\nX-RequestId:${requestId}\r\nX-Timestamp:${timestamp}\r\nContent-Type:audio/x-wav`;
    const headerBytes = Buffer.from(headerStr, "utf-8");
    const sizeBuf = Buffer.alloc(2);
    sizeBuf.writeUInt16BE(headerBytes.length, 0);
    return Buffer.concat([sizeBuf, headerBytes, audioBuffer]);
  }

  _sendSpeechConfig() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Minimal speech.config — no audio format fields (WAV header tells Azure the format)
    const speechConfig = {
      context: {
        system: { version: "1.0.0", name: "telnyx-contact-center", build: "production" },
        os: { platform: "Node.js", name: "Contact Center", version: "1.0.0" },
      },
    };

    const message = this._buildTextMsg("speech.config", speechConfig);
    this.ws.send(message, (err) => {
      if (err) {
        console.error(`[AzureSpeech] Failed to send speech.config (track=${this.track}):`, err.message);
        return;
      }
      console.log(`[AzureSpeech] speech.config sent (track=${this.track})`);
      this.connected = true;
      this._firstChunkSent = false;

      // Flush buffered audio
      if (this.pendingAudio.length > 0) {
        console.log(`[AzureSpeech] Flushing ${this.pendingAudio.length} buffered PCM chunks (track=${this.track})`);
        for (const chunk of this.pendingAudio) {
          this._sendPcmChunk(chunk);
        }
        this.pendingAudio = [];
      }
    });
  }

  _handleMessage(data) {
    const text = Buffer.isBuffer(data) ? data.toString("utf-8") : data.toString();
    const sepIdx = text.indexOf("\r\n\r\n");
    let path = null;
    let bodyText = text;

    if (sepIdx !== -1) {
      const headerSection = text.substring(0, sepIdx);
      bodyText = text.substring(sepIdx + 4);
      const pathMatch = headerSection.match(/^Path[: ]+(.+)$/im);
      if (pathMatch) path = pathMatch[1].trim();
    }

    let msg = {};
    try {
      if (bodyText.trim()) msg = JSON.parse(bodyText);
    } catch (_) {}

    if (path === "turn.start" || path === "speech.startDetected") {
      console.log(`[AzureSpeech] ← ${path} (track=${this.track})`);
      return;
    }
    if (path === "turn.end") {
      console.log(`[AzureSpeech] ← turn.end (track=${this.track})`);
      return;
    }
    if (path === "speech.hypothesis") {
      console.log(`[AzureSpeech] ← hypothesis (track=${this.track}): "${msg.Text ?? ""}"`);
      return;
    }
    if (path === "speech.phrase" || path === "translation.hypothesis" || path === "translation.phrase") {
      this._onPhraseMessage(msg, path);
      return;
    }
    console.log(`[AzureSpeech] ← unknown path "${path}" (track=${this.track})`);
  }

  sendAudio(pcmuBase64) {
    if (this.closed) return;

    let pcmuBuffer;
    try {
      pcmuBuffer = Buffer.from(pcmuBase64, "base64");
    } catch (_) {
      return;
    }

    const pcm16 = pcmuToPcm16(pcmuBuffer);

    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingAudio.push(pcm16);
      if (this.pendingAudio.length > 600) this.pendingAudio.shift();
      if (this.pendingAudio.length % 50 === 0) {
        console.log(`[AzureSpeech] Buffering audio (track=${this.track}, buffered=${this.pendingAudio.length})`);
      }
      return;
    }

    this._audioChunkCount++;
    if (this._audioChunkCount === 1 || this._audioChunkCount % 200 === 0) {
      console.log(`[AzureSpeech] → audio to Azure (track=${this.track}, chunk #${this._audioChunkCount}, bytes=${pcm16.length})`);
    }
    this._sendPcmChunk(pcm16);
  }

  _sendPcmChunk(pcm16) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      let audioPayload;
      if (!this._firstChunkSent) {
        // Prepend WAV header to the very first chunk
        audioPayload = Buffer.concat([buildWavHeader(pcm16.length), pcm16]);
        this._firstChunkSent = true;
        console.log(`[AzureSpeech] → First chunk: WAV header + ${pcm16.length} PCM bytes (track=${this.track})`);
      } else {
        audioPayload = pcm16;
      }
      const binaryMsg = this._buildAudioMsg(audioPayload);
      this.ws.send(binaryMsg, { binary: true });
    } catch (_) {}
  }

  _onPhraseMessage(msg, path) {
    const status = msg.RecognitionStatus;
    console.log(`[AzureSpeech] ← ${path} (track=${this.track}): RecognitionStatus=${status} Text="${msg.DisplayText ?? msg.Text ?? ""}"`);

    if (!status || status === "InitialSilenceTimeout" || status === "EndOfDictation" || status === "NoMatch") return;
    if (status !== "Success") {
      console.log(`[AzureSpeech] Non-success (track=${this.track}): ${status}`);
      return;
    }

    const text = msg.DisplayText || msg.Text;
    if (!text) return;

    const detectedLanguage = msg.PrimaryLanguage?.Language || null;

    let translation = null;
    if (this.config.translationEnabled) {
      // s2s endpoint returns Translation object in speech.phrase
      const translations = msg.Translation?.Translations;
      if (msg.Translation?.TranslationStatus === "Success" && translations?.length) {
        translation = {
          text: translations[0].Text,
          sourceLanguage: detectedLanguage || this.config.sourceLanguage,
          targetLanguage: this.config.targetLanguage,
        };
      }
    }

    const payload = {
      type: "transcription",
      interactionId: this.interactionId,
      callControlId: this.callControlId,
      transcription: {
        transcript: text,
        track: this.track,
        is_final: true,
        timestamp: new Date().toISOString(),
        detectedLanguage,
        translation,
        intent: null,
        sentiment: null,
        sentimentScore: null,
        tags: [],
      },
    };

    broadcastTranscription(this.agentUsername, payload);
  }

  close() {
    this.closed = true;
    this.connected = false;
    this.pendingAudio = [];
    if (this.ws) {
      try { this.ws.close(1000, "Session ended"); } catch (_) {}
      this.ws = null;
    }
  }
}

// ─── Telnyx Stream Session ────────────────────────────────────────────────────

class TelnyxStreamSession {
  constructor(callControlId, clientState) {
    this.callControlId = callControlId;
    this.clientState = clientState;
    this.audioBuffer = { inbound_track: [], outbound_track: [] };
    this.maxBufferChunks = 600;
  }

  bufferAudio(track, payloadBase64) {
    const buf = this.audioBuffer[track];
    if (!buf) return;
    buf.push(payloadBase64);
    if (buf.length > this.maxBufferChunks) buf.shift();
  }
}

// ─── Exported functions ───────────────────────────────────────────────────────

export function handleWebSocketConnection(ws, req) {
  let session = null;
  let callControlId = null;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case "connected":
          break;

        case "start": {
          const startData = msg.start || {};
          callControlId = startData.call_control_id;
          if (!callControlId) {
            console.warn("[AzureSpeech] Missing call_control_id in start event");
            break;
          }
          let clientState = {};
          if (startData.client_state) {
            try {
              clientState = JSON.parse(Buffer.from(startData.client_state, "base64").toString("utf-8"));
            } catch (_) {}
          }
          session = new TelnyxStreamSession(callControlId, clientState);
          globalThis.__azureTelnyxSessions.set(callControlId, session);
          console.log(`[AzureSpeech] Telnyx stream registered (callControlId=${callControlId})`);
          break;
        }

        case "media": {
          if (!session || !callControlId) break;
          const track = msg.media?.track;
          const payload = msg.media?.payload;
          if (!track || !payload) break;

          const activeSessions = globalThis.__azureActiveSessions.get(callControlId);
          if (activeSessions) {
            const azureTrack = track === "inbound_track" ? "inbound" : "outbound";
            const azureSession = activeSessions[azureTrack];
            if (azureSession && !azureSession.closed) {
              azureSession.sendAudio(payload);
            }
          } else {
            session.bufferAudio(track, payload);
          }
          break;
        }

        case "stop": {
          console.log(`[AzureSpeech] Telnyx stream stopped (callControlId=${callControlId})`);
          if (callControlId) {
            globalThis.__azureTelnyxSessions.delete(callControlId);
            stopAzureTranscription(callControlId).catch(() => {});
          }
          session = null;
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error("[AzureSpeech] Error processing Telnyx message:", err.message);
    }
  });

  ws.on("close", () => {
    if (callControlId) globalThis.__azureTelnyxSessions.delete(callControlId);
  });

  ws.on("error", (err) => {
    console.error("[AzureSpeech] Telnyx WS error:", err.message);
  });
}

/**
 * Start Azure transcription for a call.
 *
 * @param {string} callControlId
 * @param {object} config - { enabled, translationEnabled, sourceLanguage, targetLanguage }
 * @param {string} interactionId
 * @param {string} agentUsername
 */
export async function startAzureTranscription(callControlId, config, interactionId, agentUsername) {
  if (!callControlId || !config?.enabled) return;

  if (globalThis.__azureActiveSessions.has(callControlId)) {
    console.log(`[AzureSpeech] Azure already active for ${callControlId}`);
    return;
  }

  const region = process.env.AZURE_SERVICE_REGION || process.env.AZURE_SPEECH_REGION || "eastus";
  const apiKey = process.env.AZURE_SUBSCRIPTION_KEY || process.env.AZURE_SPEECH_API_KEY || "";

  if (!apiKey) {
    console.warn("[AzureSpeech] No Azure API key configured — skipping transcription");
    return;
  }

  const telnyxSession = globalThis.__azureTelnyxSessions.get(callControlId);

  console.log(`[AzureSpeech] Starting (callControlId=${callControlId}, interactionId=${interactionId}, agent=${agentUsername}, region=${region}, translation=${config.translationEnabled}, sourceLanguage=${config.sourceLanguage || "en-US"}, targetLanguage=${config.targetLanguage || "en"})`);

  const sessionOpts = {
    region,
    apiKey,
    config: {
      translationEnabled: config.translationEnabled === true,
      sourceLanguage: config.sourceLanguage || "en-US",
      targetLanguage: config.targetLanguage || "en",
    },
    callControlId,
    interactionId,
    agentUsername,
  };

  const inboundSession = new AzureSpeechSession({ ...sessionOpts, track: "inbound" });
  const outboundSession = new AzureSpeechSession({ ...sessionOpts, track: "outbound" });

  globalThis.__azureActiveSessions.set(callControlId, {
    inbound: inboundSession,
    outbound: outboundSession,
  });

  inboundSession.connect();
  outboundSession.connect();

  if (telnyxSession) {
    const inboundBuffer = [...(telnyxSession.audioBuffer.inbound_track || [])];
    const outboundBuffer = [...(telnyxSession.audioBuffer.outbound_track || [])];
    console.log(`[AzureSpeech] Flushing buffers (inbound=${inboundBuffer.length}, outbound=${outboundBuffer.length})`);
    setTimeout(() => {
      for (const payload of inboundBuffer) inboundSession.sendAudio(payload);
      for (const payload of outboundBuffer) outboundSession.sendAudio(payload);
      telnyxSession.audioBuffer.inbound_track = [];
      telnyxSession.audioBuffer.outbound_track = [];
    }, 500);
  }
}

export async function stopAzureTranscription(callControlId) {
  if (!callControlId) return;
  const activeSessions = globalThis.__azureActiveSessions.get(callControlId);
  if (activeSessions) {
    console.log(`[AzureSpeech] Stopping (callControlId=${callControlId})`);
    try { activeSessions.inbound?.close(); } catch (_) {}
    try { activeSessions.outbound?.close(); } catch (_) {}
    globalThis.__azureActiveSessions.delete(callControlId);
  }
}
