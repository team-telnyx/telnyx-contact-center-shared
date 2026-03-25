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
 * ESM module — imported from streaming-ws-handler.mjs and webhook-handler.js
 */

import WebSocket from "ws";

// ─── Global state (shared across module instances in the same Node.js process) ─

if (!globalThis.__azureTelnyxSessions) {
  globalThis.__azureTelnyxSessions = new Map(); // callControlId → TelnyxStreamSession
}

if (!globalThis.__azureActiveSessions) {
  globalThis.__azureActiveSessions = new Map(); // callControlId → { inbound, outbound }
}

// ─── PCMU → PCM16 conversion (G.711 μ-law decode) ───────────────────────────

// Standard G.711 μ-law to linear decode table (256 entries)
const ULAW_TO_LINEAR = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let ulaw = ~i & 0xFF;
    const sign = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

function pcmuToPcm16(pcmuBuffer) {
  const output = Buffer.alloc(pcmuBuffer.length * 2);
  for (let i = 0; i < pcmuBuffer.length; i++) {
    const sample = ULAW_TO_LINEAR[pcmuBuffer[i]];
    output.writeInt16LE(sample, i * 2);
  }
  return output;
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
   * @param {string} opts.region - Azure region (e.g. "eastus")
   * @param {string} opts.apiKey - Azure Cognitive Services API key
   * @param {string} opts.track - "inbound" or "outbound"
   * @param {object} opts.config - { translationEnabled, targetLanguage }
   * @param {string} opts.callControlId
   * @param {string} opts.interactionId
   * @param {string} opts.agentUsername
   */
  constructor({ region, apiKey, track, config, callControlId, interactionId, agentUsername }) {
    this.region = region;
    this.apiKey = apiKey;
    this.track = track; // "inbound" | "outbound"
    this.config = config;
    this.callControlId = callControlId;
    this.interactionId = interactionId;
    this.agentUsername = agentUsername;
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.pendingAudio = []; // Buffer audio received before connected
  }

  connect() {
    if (this.closed) return;

    const params = new URLSearchParams({
      language: "auto",
      format: "detailed",
      profanity: "raw",
      storeAudio: "false",
      initialSilenceTimeoutMs: "10000",
      endSilenceTimeoutMs: "3000",
    });

    const url = `wss://${this.region}.stt.speech.microsoft.com/speech/universal/v2?${params.toString()}`;

    console.log(`[AzureSpeech] Connecting (track=${this.track}, callControlId=${this.callControlId})`);

    this.ws = new WebSocket(url, {
      headers: { "Ocp-Apim-Subscription-Key": this.apiKey },
    });

    this.ws.on("open", () => {
      console.log(`[AzureSpeech] Connected to Azure (track=${this.track})`);
      this._sendSpeechConfig();
    });

    this.ws.on("message", (data) => {
      try {
        const text = Buffer.isBuffer(data) ? data.toString("utf-8") : data.toString();
        const msg = JSON.parse(text);
        this._onAzureMessage(msg);
      } catch (e) {
        // Ignore non-JSON messages
      }
    });

    this.ws.on("error", (err) => {
      console.error(`[AzureSpeech] WebSocket error (track=${this.track}):`, err.message);
    });

    this.ws.on("close", (code, reason) => {
      console.log(`[AzureSpeech] Closed (track=${this.track}, code=${code})`);
      this.connected = false;
      this.closed = true;
    });
  }

  _sendSpeechConfig() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const speechConfig = {
      context: {
        system: { version: "1.0.0", name: "telnyx-contact-center", build: "production" },
        os: { platform: "Node.js", name: "Contact Center", version: "1.0.0" },
      },
      recognition: "conversation",
      language: "auto",
      features: {
        requireTranslations: !!this.config.translationEnabled,
        globalLID: true,
        autoDetectSourceLanguage: true,
        autoDetectSourceLanguageResult: "detailed",
      },
      audio: {
        source: {
          format: { name: "PCM", sampleRate: 8000, bitsPerSample: 16, channels: 1 },
        },
      },
    };

    if (this.config.translationEnabled && this.config.targetLanguage) {
      speechConfig.translation = { to: [this.config.targetLanguage] };
    }

    this.ws.send(JSON.stringify(speechConfig), (err) => {
      if (err) {
        console.error(`[AzureSpeech] Failed to send speech config:`, err.message);
        return;
      }
      console.log(`[AzureSpeech] Speech config sent (track=${this.track})`);
      this.connected = true;

      // Flush buffered audio
      if (this.pendingAudio.length > 0) {
        console.log(`[AzureSpeech] Flushing ${this.pendingAudio.length} buffered chunks (track=${this.track})`);
        for (const chunk of this.pendingAudio) {
          this._sendPcmBuffer(chunk);
        }
        this.pendingAudio = [];
      }
    });
  }

  sendAudio(pcmuBase64) {
    if (this.closed) return;

    let pcmuBuffer;
    try {
      pcmuBuffer = Buffer.from(pcmuBase64, "base64");
    } catch (e) {
      return;
    }

    const pcm16Buffer = pcmuToPcm16(pcmuBuffer);

    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingAudio.push(pcm16Buffer);
      // Limit buffer: keep last ~30 seconds of audio (600 chunks × 20ms)
      if (this.pendingAudio.length > 600) {
        this.pendingAudio.shift();
      }
      return;
    }

    this._sendPcmBuffer(pcm16Buffer);
  }

  _sendPcmBuffer(pcm16Buffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(pcm16Buffer);
    } catch (e) {
      // Silently ignore send errors
    }
  }

  _onAzureMessage(msg) {
    const status = msg.RecognitionStatus;

    // Skip non-speech events
    if (!status || status === "InitialSilenceTimeout" || status === "EndOfDictation" || status === "NoMatch") {
      return;
    }

    if (status !== "Success") {
      console.log(`[AzureSpeech] Non-success status (track=${this.track}): ${status}`);
      return;
    }

    if (!msg.DisplayText) return;

    const detectedLanguage = msg.PrimaryLanguage?.Language || null;

    let translation = null;
    if (this.config.translationEnabled && msg.Translation?.TranslationStatus === "Success") {
      const t = msg.Translation.Translations?.[0];
      if (t) {
        translation = {
          text: t.Text,
          sourceLanguage: detectedLanguage,
          targetLanguage: this.config.targetLanguage,
        };
      }
    }

    // Normalize to the same SSE format used by handleTranscriptionEvent in webhook-handler.js
    const payload = {
      type: "transcription",
      interactionId: this.interactionId,
      callControlId: this.callControlId,
      transcription: {
        transcript: msg.DisplayText,
        track: this.track,        // "inbound" (caller) or "outbound" (agent)
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
    this.maxBufferChunks = 600; // ~30 seconds
  }

  bufferAudio(track, payloadBase64) {
    const buf = this.audioBuffer[track];
    if (!buf) return;
    buf.push(payloadBase64);
    if (buf.length > this.maxBufferChunks) {
      buf.shift();
    }
  }
}

// ─── Exported functions ───────────────────────────────────────────────────────

/**
 * Handle incoming Telnyx WebSocket connection for Azure streaming.
 * Called from streaming-ws-handler.mjs when /streaming/azure connects.
 */
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
            } catch (e) {
              console.warn("[AzureSpeech] Failed to parse client_state:", e.message);
            }
          }

          session = new TelnyxStreamSession(callControlId, clientState);
          globalThis.__azureTelnyxSessions.set(callControlId, session);

          console.log(`[AzureSpeech] Telnyx stream registered (callControlId=${callControlId}, azure_enabled=${!!clientState?.azure_transcription_config?.enabled})`);
          break;
        }

        case "media": {
          if (!session || !callControlId) break;
          const track = msg.media?.track;
          const payload = msg.media?.payload;
          if (!track || !payload) break;

          // If Azure sessions are active, forward directly; otherwise buffer
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
    if (callControlId) {
      globalThis.__azureTelnyxSessions.delete(callControlId);
    }
  });

  ws.on("error", (err) => {
    console.error("[AzureSpeech] Telnyx WS error:", err.message);
  });
}

/**
 * Start Azure transcription for a call.
 * Called from webhook-handler.js on call.answered.
 * 
 * @param {string} callControlId
 * @param {object} config - { region, apiKey, translationEnabled, targetLanguage, enabled }
 * @param {string} interactionId
 * @param {string} agentUsername
 */
export async function startAzureTranscription(callControlId, config, interactionId, agentUsername) {
  if (!callControlId || !config?.enabled) return;

  // Avoid double-starting
  if (globalThis.__azureActiveSessions.has(callControlId)) {
    console.log(`[AzureSpeech] Azure already active for ${callControlId}`);
    return;
  }

  const region = config.region || process.env.AZURE_SPEECH_REGION || "eastus";
  const apiKey = config.apiKey || process.env.AZURE_SPEECH_API_KEY || "";

  if (!apiKey) {
    console.warn("[AzureSpeech] No Azure API key configured — skipping transcription");
    return;
  }

  const telnyxSession = globalThis.__azureTelnyxSessions.get(callControlId);

  console.log(`[AzureSpeech] Starting Azure transcription (callControlId=${callControlId}, interactionId=${interactionId}, agent=${agentUsername}, hasTelnyxSession=${!!telnyxSession})`);

  const sessionOpts = {
    region,
    apiKey,
    config: {
      translationEnabled: config.translationEnabled === true,
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

  // Flush buffered audio (captured before agent answered)
  if (telnyxSession) {
    const inboundBuffer = [...(telnyxSession.audioBuffer.inbound_track || [])];
    const outboundBuffer = [...(telnyxSession.audioBuffer.outbound_track || [])];

    console.log(`[AzureSpeech] Flushing buffers (inbound=${inboundBuffer.length}, outbound=${outboundBuffer.length})`);

    // Wait for Azure to connect before flushing
    setTimeout(() => {
      for (const payload of inboundBuffer) {
        inboundSession.sendAudio(payload);
      }
      for (const payload of outboundBuffer) {
        outboundSession.sendAudio(payload);
      }
      telnyxSession.audioBuffer.inbound_track = [];
      telnyxSession.audioBuffer.outbound_track = [];
    }, 500);
  }
}

/**
 * Stop Azure transcription sessions for a call.
 * Called on call hangup.
 * 
 * @param {string} callControlId
 */
export async function stopAzureTranscription(callControlId) {
  if (!callControlId) return;

  const activeSessions = globalThis.__azureActiveSessions.get(callControlId);
  if (activeSessions) {
    console.log(`[AzureSpeech] Stopping Azure sessions (callControlId=${callControlId})`);
    try { activeSessions.inbound?.close(); } catch (_) {}
    try { activeSessions.outbound?.close(); } catch (_) {}
    globalThis.__azureActiveSessions.delete(callControlId);
  }
}
