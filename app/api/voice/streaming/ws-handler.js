import WebSocket from "ws";
import { voiceRuntimePayload, streamingLogger } from "../../../../lib/voice/logging.mjs";

const STREAMING_OPENAI_REALTIME_CONFIG = {
  id: "openai-realtime",
  model: "gpt-4o-realtime-preview",
  voice: "alloy",
  systemInstructions: `You are a helpful AI assistant for Telnyx, a leading communications platform as a service (CPaaS) provider.

Your role is to assist customers with information about Telnyx products and services, including:
- Voice APIs and programmable voice solutions
- Messaging APIs (SMS, MMS, WhatsApp)
- SIP trunking and connectivity
- Number management and porting
- WebRTC and real-time communications
- Call control and IVR capabilities
- AI and machine learning integrations

Be friendly, professional, and concise. Provide accurate information about Telnyx offerings and help guide customers to the right solutions for their needs.`,
  openai: {
    voice: "alloy",
    input_audio_transcription: {
      model: "gpt-4o-transcribe",
    },
  },
};

const STREAMING_GOOGLE_GEMINI_CONFIG = {
  id: "google-gemini",
  model: "gemini-2.5-flash-native-audio-latest",
  voice: "Puck",
  systemInstructions: STREAMING_OPENAI_REALTIME_CONFIG.systemInstructions,
};

function getProviderConfig(providerId) {
  if (providerId === "openai-realtime") return STREAMING_OPENAI_REALTIME_CONFIG;
  if (providerId === "google-gemini") return STREAMING_GOOGLE_GEMINI_CONFIG;
  return null;
}

/**
 * Parse AI config from URL query param (ai_config=base64JSON)
 * Flow engine appends this to stream_url before streaming_start
 */
function parseAIConfig(req) {
  try {
    const url = new URL(req.url, "http://localhost");
    const aiConfigB64 = url.searchParams.get("ai_config");
    if (aiConfigB64) {
      return JSON.parse(Buffer.from(aiConfigB64, "base64").toString("utf-8"));
    }
  } catch (err) {
    streamingLogger.warn("streaming_ws_ws_handler", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
  }
  return {};
}

export async function handleWebSocketConnection(ws, req, provider) {
  try {
    if (provider === "google") {
      await handleGoogleGeminiStreaming(ws, req);
    } else if (provider === "openai") {
      await handleOpenAIStreaming(ws, req);
    } else if (provider === "test") {
      await handleTestConnection(ws, req);
    } else {
      streamingLogger.error("streaming_ws_ws_handler", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      ws.close(1008, "Unknown provider");
    }
  } catch (error) {
    streamingLogger.error("streaming_ws_ws_handler", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    if (ws.readyState === 1) {
      ws.close(1011, "Handler error");
    }
    throw error;
  }
}

async function handleTestConnection(ws, req) {
  streamingLogger.debug("streaming_ws_test", voiceRuntimePayload({ eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
  if (ws.readyState !== 1) return;

  try {
    ws.send(JSON.stringify({ event: "welcome", message: "WebSocket test connection established!", timestamp: Date.now() }));
  } catch (e) {
    streamingLogger.error("streaming_ws_test", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
  }

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      ws.send(JSON.stringify({ event: "echo", original: message, timestamp: Date.now() }));
    } catch (err) {
      streamingLogger.error("streaming_ws_test", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    }
  });

  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) {
      try { ws.ping(); } catch (_) {}
    } else {
      clearInterval(pingInterval);
    }
  }, 10000);
}

async function handleOpenAIStreaming(ws, req) {
  const startTime = Date.now();
  const elapsed = () => `${Date.now() - startTime}ms`;

  if (ws.readyState !== 1) {
    streamingLogger.error("streaming_ws_openai", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    streamingLogger.error("streaming_ws_openai", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    ws.close(1008, "OPENAI_API_KEY not configured");
    return;
  }

  const config = getProviderConfig("openai-realtime");
  if (!config) {
    streamingLogger.error("streaming_ws_openai", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    ws.close(1011, "Configuration error");
    return;
  }

  let aiConfig = parseAIConfig(req);
  let instructions = config.systemInstructions;
  let voice = config.openai?.voice || config.voice || "alloy";
  let transcriptionModel = config.openai?.input_audio_transcription?.model || "gpt-4o-transcribe";
  let turnDetectionType = config.openai?.turn_detection?.type || "server_vad";
  let vadThreshold = config.openai?.turn_detection?.threshold ?? 0.5;
  let vadSilenceMs = config.openai?.turn_detection?.silence_duration_ms ?? 500;
  let vadPrefixMs = config.openai?.turn_detection?.prefix_padding_ms ?? 300;
  let greetingPrompt = "Please greet the caller and ask how you can help them today.";
  let languageCode = null; // null = auto-detect
  let aiConfigResolved = Object.keys(aiConfig).length > 0;

  function resolveAIConfig(cfg) {
    instructions = cfg.ai_instructions || config.systemInstructions;
    voice = cfg.ai_voice_openai || config.openai?.voice || config.voice || "alloy";
    transcriptionModel = cfg.ai_transcription_model || config.openai?.input_audio_transcription?.model || "gpt-4o-transcribe";
    turnDetectionType = cfg.ai_turn_detection_type || config.openai?.turn_detection?.type || "server_vad";
    vadThreshold = cfg.ai_vad_threshold ?? config.openai?.turn_detection?.threshold ?? 0.5;
    vadSilenceMs = cfg.ai_vad_silence_ms ?? config.openai?.turn_detection?.silence_duration_ms ?? 500;
    vadPrefixMs = cfg.ai_vad_prefix_padding_ms ?? config.openai?.turn_detection?.prefix_padding_ms ?? 300;
    greetingPrompt = cfg.ai_greeting_prompt || "Please greet the caller and ask how you can help them today.";
    languageCode = cfg.ai_language_code || null;
  }

  if (aiConfigResolved) resolveAIConfig(aiConfig);

  // Hoisted to outer scope so both sendSessionConfig() and session.updated handler can use it
  const effectiveInstructions = languageCode
    ? `${instructions}\n\nIMPORTANT: Start the conversation in the language specified by this BCP-47 code: ${languageCode}. You may switch languages if the caller requests it.`
    : instructions;

  // Convert BCP-47 (e.g. "en-US", "pl-PL") to ISO 639-1 (e.g. "en", "pl") for Whisper
  const whisperLanguage = languageCode ? languageCode.split("-")[0].toLowerCase() : undefined;

  let openaiWs = null;
  let isClosing = false;
  let streamStarted = false;
  let openaiReady = false;
  let openaiConnected = false;
  let sessionConfigSent = false;
  const messageBuffer = [];
  let mediaCount = 0;
  let audioSentToOpenAI = 0;
  let audioReceivedFromOpenAI = 0;

  function sendSessionConfig() {
    if (sessionConfigSent || !openaiConnected || !openaiWs || openaiWs.readyState !== 1) return;
    sessionConfigSent = true;

    const turnDetection = turnDetectionType === "none"
      ? null
      : { type: turnDetectionType, threshold: vadThreshold, prefix_padding_ms: vadPrefixMs, silence_duration_ms: vadSilenceMs };

    const sessionConfig = {
      type: "session.update",
      session: {
        type: "realtime",
        instructions: effectiveInstructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: {
              model: transcriptionModel,
              ...(whisperLanguage ? { language: whisperLanguage } : {}),
            },
            ...(turnDetection ? { turn_detection: turnDetection } : {}),
          },
          output: { format: { type: "audio/pcmu" }, voice },
        },
      },
    };

    openaiWs.send(JSON.stringify(sessionConfig));
  }

  const cleanup = (reason) => {
    if (isClosing) return;
    isClosing = true;
    streamingLogger.debug("streaming_ws_openai", voiceRuntimePayload({ eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    try { openaiWs?.close(); } catch (_) {}
  };

  ws.once("close", (code) => { cleanup("telnyx-close"); });
  ws.once("error", (err) => { streamingLogger.error("streaming_ws_openai", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined })); cleanup("telnyx-error"); });

  const connectToOpenAI = () => new Promise((resolve, reject) => {
    const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`;
    streamingLogger.debug("streaming_ws_openai", voiceRuntimePayload({ eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));

    openaiWs = new WebSocket(openaiUrl, { headers: { Authorization: `Bearer ${apiKey}` } });

    const timeout = setTimeout(() => reject(new Error("OpenAI connect timeout (10s)")), 10000);

    openaiWs.once("open", () => { clearTimeout(timeout); streamingLogger.debug("streaming_ws_openai", voiceRuntimePayload({ eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined })); resolve(); });
    openaiWs.once("error", (err) => { clearTimeout(timeout); reject(err); });

    openaiWs.on("message", (data) => {
      try {
        if (isClosing || ws.readyState !== 1) return;
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case "session.created":
            openaiConnected = true;
            sendSessionConfig();
            break;

          case "session.updated":
            openaiReady = true;
            if (messageBuffer.length > 0) {
              for (const payload of messageBuffer) {
                openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
                audioSentToOpenAI++;
              }
              messageBuffer.length = 0;
            }
            openaiWs.send(JSON.stringify({
              type: "response.create",
              response: { instructions: `${effectiveInstructions}\n\nNow: ${greetingPrompt}` },
            }));
            break;

          case "response.audio.delta":
          case "response.output_audio.delta":
            if (msg.delta && ws.readyState === 1) {
              audioReceivedFromOpenAI++;
              ws.send(JSON.stringify({ event: "media", media: { payload: msg.delta } }));
            }
            break;

          case "response.audio.done":
          case "response.output_audio.done":
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ event: "mark", mark: { name: `audio_done_${audioReceivedFromOpenAI}` } }));
            }
            break;

          case "input_audio_buffer.speech_started":
            if (ws.readyState === 1) ws.send(JSON.stringify({ event: "clear" }));
            break;

          case "error":
            streamingLogger.error("streaming_ws_openai", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
            break;

          case "response.done":
            if (msg.response?.status === "failed") {
              streamingLogger.error("streaming_ws_openai", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
            }
            break;

          default:
            break;
        }
      } catch (err) {
        streamingLogger.error("streaming_ws_openai", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      }
    });

    openaiWs.on("close", (code) => {
      streamingLogger.debug("streaming_ws_openai", voiceRuntimePayload({ eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      cleanup("openai-close");
      if (ws.readyState === 1) ws.close(1000, "OpenAI closed");
    });

    openaiWs.on("error", (err) => {
      streamingLogger.error("streaming_ws_openai", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
      cleanup("openai-error");
      if (ws.readyState === 1) ws.close(1011, "OpenAI error");
    });
  });

  connectToOpenAI().catch((err) => {
    streamingLogger.error("streaming_ws_openai", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    if (ws.readyState === 1) ws.close(1011, "OpenAI connection failed");
  });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.event) {
        case "start":
          streamStarted = true;
          sendSessionConfig();
          break;

        case "media":
          if (!message.media?.payload || !streamStarted || isClosing) break;
          mediaCount++;
          if (openaiReady && openaiWs?.readyState === 1) {
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: message.media.payload }));
            audioSentToOpenAI++;
          } else {
            messageBuffer.push(message.media.payload);
          }
          break;

        case "stop":
          streamingLogger.debug("streaming_ws_openai", voiceRuntimePayload({ eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
          cleanup("telnyx-stop");
          break;

        default:
          break;
      }
    } catch (err) {
      streamingLogger.error("streaming_ws_openai", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    }
  });
}

async function handleGoogleGeminiStreaming(ws, req) {
  const startTime = Date.now();
  const elapsed = () => `${Date.now() - startTime}ms`;

  if (ws.readyState !== 1) {
    streamingLogger.error("streaming_ws_gemini", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    streamingLogger.error("streaming_ws_gemini", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    ws.close(1008, "GEMINI_API_KEY not configured");
    return;
  }

  const config = getProviderConfig("google-gemini");
  if (!config) {
    streamingLogger.error("streaming_ws_gemini", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    ws.close(1011, "Configuration error");
    return;
  }

  let aiConfig = parseAIConfig(req);
  let instructions = config.systemInstructions;
  let voice = config.voice || "Puck";
  let model = config.model || "gemini-2.5-flash-native-audio-latest";
  let greetingPrompt = "Please greet the caller and ask how you can help them today.";
  let languageCode = "en-US";

  function resolveGeminiConfig(cfg) {
    instructions = cfg.ai_instructions || config.systemInstructions;
    voice = cfg.ai_voice_gemini || config.voice || "Puck";
    model = cfg.ai_gemini_model || config.model || "gemini-2.5-flash-native-audio-latest";
    greetingPrompt = cfg.ai_greeting_prompt || greetingPrompt;
    languageCode = cfg.ai_language_code || "en-US";
  }

  if (Object.keys(aiConfig).length > 0) resolveGeminiConfig(aiConfig);

  // Audio conversion: Telnyx sends mu-law 8kHz, Gemini expects PCM16 16kHz
  // Gemini outputs PCM16 24kHz, Telnyx expects mu-law 8kHz
  const alawmulawModule = await import("alawmulaw");
  const alawmulaw = alawmulawModule.default || alawmulawModule;

  function ulawToPCM(ulawBuffer) {
    const uint8Array = new Uint8Array(ulawBuffer.buffer, ulawBuffer.byteOffset, ulawBuffer.length);
    const pcmArray = alawmulaw.mulaw.decode(uint8Array);
    return Buffer.from(pcmArray.buffer, pcmArray.byteOffset, pcmArray.length * 2);
  }

  function pcmToUlaw(pcmBuffer) {
    const int16Array = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.length / 2));
    const ulawArray = alawmulaw.mulaw.encode(int16Array);
    return Buffer.from(ulawArray);
  }

  function resample8kTo16k(inputBuffer) {
    const inputSamples = inputBuffer.length / 2;
    const outputBuffer = Buffer.alloc(inputSamples * 4);
    for (let i = 0; i < inputSamples; i++) {
      const sample = inputBuffer.readInt16LE(i * 2);
      const outputIdx = i * 4;
      outputBuffer.writeInt16LE(sample, outputIdx);
      if (i < inputSamples - 1) {
        const nextSample = inputBuffer.readInt16LE((i + 1) * 2);
        outputBuffer.writeInt16LE(Math.round((sample + nextSample) / 2), outputIdx + 2);
      } else {
        outputBuffer.writeInt16LE(sample, outputIdx + 2);
      }
    }
    return outputBuffer;
  }

  function resample24kTo8k(inputBuffer) {
    const inputSamples = inputBuffer.length / 2;
    const outputSamples = Math.floor(inputSamples / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);
    for (let i = 0; i < outputSamples; i++) {
      const srcIdx = i * 3;
      if (srcIdx + 2 < inputSamples) {
        const s1 = inputBuffer.readInt16LE(srcIdx * 2);
        const s2 = inputBuffer.readInt16LE((srcIdx + 1) * 2);
        const s3 = inputBuffer.readInt16LE((srcIdx + 2) * 2);
        outputBuffer.writeInt16LE(Math.round((s1 + s2 + s3) / 3), i * 2);
      } else if (srcIdx < inputSamples) {
        outputBuffer.writeInt16LE(inputBuffer.readInt16LE(srcIdx * 2), i * 2);
      }
    }
    return outputBuffer;
  }

  let geminiSession = null;
  let isClosing = false;
  let streamStarted = false;
  let geminiReady = false;
  const messageBuffer = [];
  let mediaCount = 0;
  let audioSentToGemini = 0;
  let audioReceivedFromGemini = 0;

  const cleanup = (reason) => {
    if (isClosing) return;
    isClosing = true;
    streamingLogger.debug("streaming_ws_gemini", voiceRuntimePayload({ eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    try { geminiSession?.close(); } catch (_) {}
  };

  ws.once("close", (code) => { cleanup("telnyx-close"); });
  ws.once("error", (err) => { streamingLogger.error("streaming_ws_gemini", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined })); cleanup("telnyx-error"); });

  const connectToGemini = async () => {
    const { GoogleGenAI, Modality } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });

    const geminiConfig = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: instructions,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        languageCode,
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };

    geminiSession = await ai.live.connect({
      model,
      config: geminiConfig,
      callbacks: {
        onopen: () => { geminiReady = true; },
        onmessage: (message) => {
          try {
            if (isClosing) return;

            if (message.serverContent?.interrupted) {
              if (ws.readyState === 1) ws.send(JSON.stringify({ event: "clear" }));
            }

            const audioPart = message.serverContent?.modelTurn?.parts?.find(
              (p) => p?.inlineData?.mimeType?.startsWith("audio/pcm")
            )?.inlineData;

            if (audioPart?.data && ws.readyState === 1) {
              audioReceivedFromGemini++;
              try {
                const pcm24k = Buffer.from(audioPart.data, "base64");
                const pcm8k = resample24kTo8k(pcm24k);
                const ulawOut = pcmToUlaw(pcm8k);
                ws.send(JSON.stringify({ event: "media", media: { payload: ulawOut.toString("base64") } }));
              } catch (err) {
                streamingLogger.error("streaming_ws_gemini", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
              }
            }

            if (message.serverContent?.turnComplete) {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ event: "mark", mark: { name: `audio_done_${audioReceivedFromGemini}` } }));
              }
            }
          } catch (err) {
            streamingLogger.error("streaming_ws_gemini", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
          }
        },
        onerror: (e) => {
          streamingLogger.error("streaming_ws_gemini", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
          cleanup("gemini-error");
          if (ws.readyState === 1) ws.close(1011, "Gemini error");
        },
        onclose: (e) => {
          streamingLogger.debug("streaming_ws_gemini", voiceRuntimePayload({ eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
          cleanup("gemini-close");
          if (ws.readyState === 1) ws.close(1000, "Gemini closed");
        },
      },
    });

    // Flush buffered audio
    if (messageBuffer.length > 0) {
      for (const payload of messageBuffer) {
        try {
          const ulawBuffer = Buffer.from(payload, "base64");
          const pcm8k = ulawToPCM(ulawBuffer);
          const pcm16k = resample8kTo16k(pcm8k);
          geminiSession.sendRealtimeInput({ audio: { data: pcm16k.toString("base64"), mimeType: "audio/pcm;rate=16000" } });
          audioSentToGemini++;
        } catch (err) {
          streamingLogger.error("streaming_ws_gemini", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
        }
      }
      messageBuffer.length = 0;
    }

    geminiSession.sendClientContent({
      turns: [{ role: "user", parts: [{ text: `${instructions}\n\nNow: ${greetingPrompt}` }] }],
      turnComplete: true,
    });
  };

  connectToGemini().catch((err) => {
    streamingLogger.error("streaming_ws_gemini", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    if (ws.readyState === 1) ws.close(1011, "Gemini connection failed");
  });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.event) {
        case "start":
          streamStarted = true;
          break;

        case "media":
          if (!message.media?.payload || !streamStarted || isClosing) break;
          mediaCount++;
          if (geminiReady && geminiSession) {
            try {
              const ulawBuffer = Buffer.from(message.media.payload, "base64");
              const pcm8k = ulawToPCM(ulawBuffer);
              const pcm16k = resample8kTo16k(pcm8k);
              geminiSession.sendRealtimeInput({ audio: { data: pcm16k.toString("base64"), mimeType: "audio/pcm;rate=16000" } });
              audioSentToGemini++;
            } catch (err) {
              if (audioSentToGemini === 0) streamingLogger.error("streaming_ws_gemini", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
            }
          } else {
            messageBuffer.push(message.media.payload);
          }
          break;

        case "stop":
          streamingLogger.debug("streaming_ws_gemini", voiceRuntimePayload({ eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
          cleanup("telnyx-stop");
          break;

        default:
          break;
      }
    } catch (err) {
      streamingLogger.error("streaming_ws_gemini", voiceRuntimePayload({ error: typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof e !== "undefined" ? e : undefined, eventType: typeof event !== "undefined" ? event : typeof eventType !== "undefined" ? eventType : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof payload !== "undefined" ? payload?.call_control_id : undefined, callSessionId: typeof callSessionId !== "undefined" ? callSessionId : typeof payload !== "undefined" ? payload?.call_session_id : undefined, flowId: typeof flowId !== "undefined" ? flowId : typeof flow !== "undefined" ? flow?.id : undefined, nodeId: typeof nodeId !== "undefined" ? nodeId : typeof node !== "undefined" ? node?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined, provider: typeof provider !== "undefined" ? provider : undefined }));
    }
  });
}
