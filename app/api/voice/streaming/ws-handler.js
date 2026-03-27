import WebSocket from "ws";
import { getProviderConfig } from "@/config/ai-streaming-providers";

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
    console.warn("[ws-handler] Failed to parse ai_config from URL:", err.message);
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
      console.error("[ws-handler] Unknown provider:", provider);
      ws.close(1008, "Unknown provider");
    }
  } catch (error) {
    console.error("[ws-handler] Unhandled error in handler:", error);
    if (ws.readyState === 1) {
      ws.close(1011, "Handler error");
    }
    throw error;
  }
}

async function handleTestConnection(ws, req) {
  console.log("[test] === Test WebSocket Connection ===");
  if (ws.readyState !== 1) return;

  try {
    ws.send(JSON.stringify({ event: "welcome", message: "WebSocket test connection established!", timestamp: Date.now() }));
  } catch (e) {
    console.error("[test] Failed to send welcome:", e.message);
  }

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      ws.send(JSON.stringify({ event: "echo", original: message, timestamp: Date.now() }));
    } catch (err) {
      console.error("[test] Error processing message:", err);
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
    console.error(`[openai] WebSocket not OPEN (${ws.readyState}), aborting`);
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[openai] OPENAI_API_KEY not set!");
    ws.close(1008, "OPENAI_API_KEY not configured");
    return;
  }

  const config = getProviderConfig("openai-realtime");
  if (!config) {
    console.error("[openai] Provider config not found");
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

    // If language is set, inject it into instructions and transcription
    const effectiveInstructions = languageCode
      ? `${instructions}\n\nIMPORTANT: Always respond in the language specified by this BCP-47 code: ${languageCode}. Do not switch languages regardless of what language the caller uses.`
      : instructions;

    // Convert BCP-47 (e.g. "en-US", "pl-PL") to ISO 639-1 (e.g. "en", "pl") for Whisper
    const whisperLanguage = languageCode ? languageCode.split("-")[0].toLowerCase() : undefined;

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
    console.log(`[openai] Cleanup: ${reason} (${elapsed()})`);
    try { openaiWs?.close(); } catch (_) {}
  };

  ws.once("close", (code) => { cleanup("telnyx-close"); });
  ws.once("error", (err) => { console.error(`[openai] Telnyx error: ${err.message}`); cleanup("telnyx-error"); });

  const connectToOpenAI = () => new Promise((resolve, reject) => {
    const openaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`;
    console.log(`[openai] Connecting to OpenAI: ${openaiUrl}`);

    openaiWs = new WebSocket(openaiUrl, { headers: { Authorization: `Bearer ${apiKey}` } });

    const timeout = setTimeout(() => reject(new Error("OpenAI connect timeout (10s)")), 10000);

    openaiWs.once("open", () => { clearTimeout(timeout); console.log(`[openai] ✅ Connected to OpenAI @ ${elapsed()}`); resolve(); });
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
            console.error(`[openai] ❌ OpenAI error:`, JSON.stringify(msg.error));
            break;

          case "response.done":
            if (msg.response?.status === "failed") {
              console.error(`[openai] ❌ Response failed:`, JSON.stringify(msg.response?.status_details || msg.response));
            }
            break;

          default:
            break;
        }
      } catch (err) {
        console.error(`[openai] Error processing OpenAI message: ${err.message}`);
      }
    });

    openaiWs.on("close", (code) => {
      console.log(`[openai] OpenAI WS closed (${code}) @ ${elapsed()}`);
      cleanup("openai-close");
      if (ws.readyState === 1) ws.close(1000, "OpenAI closed");
    });

    openaiWs.on("error", (err) => {
      console.error(`[openai] OpenAI WS error: ${err.message}`);
      cleanup("openai-error");
      if (ws.readyState === 1) ws.close(1011, "OpenAI error");
    });
  });

  connectToOpenAI().catch((err) => {
    console.error(`[openai] ❌ Failed to connect to OpenAI: ${err.message}`);
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
          console.log(`[openai] ⏹️ Stream stopped @ ${elapsed()} (media=${mediaCount}, sent=${audioSentToOpenAI}, received=${audioReceivedFromOpenAI})`);
          cleanup("telnyx-stop");
          break;

        default:
          break;
      }
    } catch (err) {
      console.error(`[openai] Error parsing Telnyx message: ${err.message}`);
    }
  });
}

async function handleGoogleGeminiStreaming(ws, req) {
  const startTime = Date.now();
  const elapsed = () => `${Date.now() - startTime}ms`;

  if (ws.readyState !== 1) {
    console.error(`[gemini] WebSocket not OPEN (${ws.readyState}), aborting`);
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[gemini] GEMINI_API_KEY not configured");
    ws.close(1008, "GEMINI_API_KEY not configured");
    return;
  }

  const config = getProviderConfig("google-gemini");
  if (!config) {
    console.error("[gemini] Provider configuration not found");
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
    console.log(`[gemini] Cleanup: ${reason} (${elapsed()})`);
    try { geminiSession?.close(); } catch (_) {}
  };

  ws.once("close", (code) => { cleanup("telnyx-close"); });
  ws.once("error", (err) => { console.error(`[gemini] Telnyx error: ${err.message}`); cleanup("telnyx-error"); });

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
                console.error(`[gemini] Error converting output audio: ${err.message}`);
              }
            }

            if (message.serverContent?.turnComplete) {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ event: "mark", mark: { name: `audio_done_${audioReceivedFromGemini}` } }));
              }
            }
          } catch (err) {
            console.error(`[gemini] Error processing Gemini message: ${err.message}`);
          }
        },
        onerror: (e) => {
          console.error(`[gemini] Gemini error: ${e.message}`);
          cleanup("gemini-error");
          if (ws.readyState === 1) ws.close(1011, "Gemini error");
        },
        onclose: (e) => {
          console.log(`[gemini] Gemini session closed @ ${elapsed()}`);
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
          console.error(`[gemini] Error converting buffered audio: ${err.message}`);
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
    console.error(`[gemini] ❌ Failed to connect to Gemini: ${err.message}`);
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
              if (audioSentToGemini === 0) console.error(`[gemini] Error converting audio: ${err.message}`);
            }
          } else {
            messageBuffer.push(message.media.payload);
          }
          break;

        case "stop":
          console.log(`[gemini] ⏹️ Stream stopped @ ${elapsed()} (media=${mediaCount}, sent=${audioSentToGemini}, received=${audioReceivedFromGemini})`);
          cleanup("telnyx-stop");
          break;

        default:
          break;
      }
    } catch (err) {
      console.error(`[gemini] Error parsing Telnyx message: ${err.message}`);
    }
  });
}
