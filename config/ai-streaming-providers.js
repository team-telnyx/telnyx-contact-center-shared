/**
 * AI Streaming Provider Configurations
 * Configuration for Google Gemini Live and OpenAI Realtime streaming
 */


export const TELNYX_STT_LANGUAGE_OPTIONS = {
  google: [
    { value: "en-US", label: "🇺🇸 English (US)" },
    { value: "en-GB", label: "🇬🇧 English (UK)" },
    { value: "pl-PL", label: "🇵🇱 Polish" },
    { value: "de-DE", label: "🇩🇪 German" },
    { value: "fr-FR", label: "🇫🇷 French" },
    { value: "es-ES", label: "🇪🇸 Spanish" },
    { value: "it-IT", label: "🇮🇹 Italian" },
    { value: "nl-NL", label: "🇳🇱 Dutch" },
    { value: "pt-PT", label: "🇵🇹 Portuguese" },
    { value: "pt-BR", label: "🇧🇷 Portuguese (Brazil)" },
    { value: "uk-UA", label: "🇺🇦 Ukrainian" },
    { value: "ar-AE", label: "🇦🇪 Arabic" },
  ],
  xai: [
    { value: "en", label: "🇺🇸 English" },
    { value: "pl", label: "🇵🇱 Polish" },
    { value: "de", label: "🇩🇪 German" },
    { value: "fr", label: "🇫🇷 French" },
    { value: "es", label: "🇪🇸 Spanish" },
    { value: "it", label: "🇮🇹 Italian" },
    { value: "pt", label: "🇵🇹 Portuguese" },
  ],
  deepgram: [
    { value: "en-US", label: "🇺🇸 English (US)" },
    { value: "en-GB", label: "🇬🇧 English (UK)" },
    { value: "pl", label: "🇵🇱 Polish" },
    { value: "de", label: "🇩🇪 German" },
    { value: "fr", label: "🇫🇷 French" },
    { value: "es", label: "🇪🇸 Spanish" },
    { value: "it", label: "🇮🇹 Italian" },
    { value: "nl", label: "🇳🇱 Dutch" },
    { value: "pt", label: "🇵🇹 Portuguese" },
    { value: "uk", label: "🇺🇦 Ukrainian" },
  ],
  speechmatics: [
    { value: "en", label: "🇺🇸 English" },
    { value: "pl", label: "🇵🇱 Polish" },
    { value: "de", label: "🇩🇪 German" },
    { value: "fr", label: "🇫🇷 French" },
    { value: "es", label: "🇪🇸 Spanish" },
    { value: "it", label: "🇮🇹 Italian" },
    { value: "nl", label: "🇳🇱 Dutch" },
    { value: "pt", label: "🇵🇹 Portuguese" },
  ],
};

function telnyxSttLanguagesForEngine(engine) {
  const key = String(engine || "").toLowerCase();
  if (key.includes("google")) return TELNYX_STT_LANGUAGE_OPTIONS.google;
  if (key.includes("xai")) return TELNYX_STT_LANGUAGE_OPTIONS.xai;
  if (key.includes("deepgram")) return TELNYX_STT_LANGUAGE_OPTIONS.deepgram;
  if (key.includes("speechmatics")) return TELNYX_STT_LANGUAGE_OPTIONS.speechmatics;
  return TELNYX_STT_LANGUAGE_OPTIONS.google;
}

export const AI_STREAMING_PROVIDERS = {
  "google-gemini": {
    id: "google-gemini",
    label: "Google Gemini Live",
    model: "gemini-2.5-flash-native-audio-latest",
    voice: "Puck", // Default generative voice
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

    // Audio configuration for Telnyx streaming
    telnyx: {
      stream_track: "inbound_track", // Stream caller audio to AI
      stream_codec: "PCMU", // 8kHz PCMU (G.711 μ-law)
      stream_bidirectional_mode: "rtp", // RTP mode with base64-encoded payloads in JSON
      stream_bidirectional_codec: "PCMU", // PCMU for responses
    },

    // Gemini Live API configuration
    gemini: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: "Puck", // Options: Puck, Charon, Kore, Fenrir, Aoede
        },
      },
      generationConfig: {
        responseModalities: ["AUDIO"], // Audio output only
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Puck",
            },
          },
        },
      },
    },
  },

  "openai-realtime": {
    id: "openai-realtime",
    label: "OpenAI Realtime",
    model: "gpt-4o-realtime-preview",
    voice: "alloy", // Options: alloy, echo, shimmer
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

    // Audio configuration for Telnyx streaming
    telnyx: {
      stream_track: "inbound_track", // Stream caller audio to AI
      stream_codec: "PCMU", // G.711 μ-law (8kHz)
      stream_bidirectional_mode: "rtp", // RTP mode with base64-encoded payloads in JSON
      stream_bidirectional_codec: "PCMU", // PCMU for responses (g711_ulaw)
    },

    // OpenAI Realtime API configuration
    openai: {
      modalities: ["text", "audio"],
      voice: "alloy",
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      input_audio_transcription: {
        model: "gpt-4o-transcribe",
      },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 200,
      },
    },
  },

  "telnyx-stt-google-phone-call": {
    id: "telnyx-stt-google-phone-call",
    label: "Telnyx STT WS — Google phone_call (PCMU telco)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Google phone_call. Compatibility-tested for native PCMU/mulaw @ 8 kHz telco audio.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams its own inbound audio; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "PCMU",
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Google",
      model: "phone_call",
      language: "en-US",
      input_format: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForEngine("Google"),
    },
  },

  "telnyx-stt-google-latest-long": {
    id: "telnyx-stt-google-latest-long",
    label: "Telnyx STT WS — Google latest_long (PCMU telco)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Google latest_long. Compatibility-tested for native PCMU/mulaw @ 8 kHz telco audio.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams its own inbound audio; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "PCMU",
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Google",
      model: "latest_long",
      language: "en-US",
      input_format: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForEngine("Google"),
    },
  },

  "telnyx-stt-google-default": {
    id: "telnyx-stt-google-default",
    label: "Telnyx STT WS — Google default (PCMU telco)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Google default. Compatibility-tested for native PCMU/mulaw @ 8 kHz telco audio.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams its own inbound audio; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "PCMU",
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Google",
      model: "default",
      language: "en-US",
      input_format: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForEngine("Google"),
    },
  },

  "telnyx-stt-xai-grok": {
    id: "telnyx-stt-xai-grok",
    label: "Telnyx STT WS — xAI Grok STT (PCMU telco)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using xAI Grok STT. Compatibility-tested for native PCMU/mulaw @ 8 kHz telco audio.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams its own inbound audio; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "PCMU",
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "xAI",
      model: "xai/grok-stt",
      language: "en",
      input_format: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForEngine("xAI"),
    },
  },

  "telnyx-stt-deepgram-nova-2": {
    id: "telnyx-stt-deepgram-nova-2",
    label: "Telnyx STT WS — Deepgram Nova 2 (PCMU telco)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Deepgram Nova 2 with native PCMU/mulaw @ 8 kHz telco audio.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams its own inbound audio; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "PCMU",
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Deepgram",
      model: "nova-2",
      language: "en-US",
      input_format: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForEngine("Deepgram"),
    },
  },

  "telnyx-stt-deepgram-nova-3": {
    id: "telnyx-stt-deepgram-nova-3",
    label: "Telnyx STT WS — Deepgram Nova 3 (PCMU telco)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Deepgram Nova 3 with native PCMU/mulaw @ 8 kHz telco audio.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams its own inbound audio; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "PCMU",
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Deepgram",
      model: "nova-3",
      language: "en-US",
      input_format: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForEngine("Deepgram"),
    },
  },

  "telnyx-stt-deepgram-flux": {
    id: "telnyx-stt-deepgram-flux",
    label: "Telnyx STT WS — Deepgram Flux (PCMU telco)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Deepgram Flux with native PCMU/mulaw @ 8 kHz telco audio.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams its own inbound audio; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "PCMU",
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Deepgram",
      model: "flux",
      language: "en-US",
      input_format: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForEngine("Deepgram"),
    },
  },

  "telnyx-stt-speechmatics-standard": {
    id: "telnyx-stt-speechmatics-standard",
    label: "Telnyx STT WS — Speechmatics standard (PCMU telco)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Speechmatics standard. Compatibility-tested for native PCMU/mulaw @ 8 kHz telco audio.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams its own inbound audio; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "PCMU",
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Speechmatics",
      model: "speechmatics/standard",
      language: "en",
      input_format: "mulaw",
      sample_rate: 8000,
      interim_results: true,
      endpointing: 300,
      supported_languages: telnyxSttLanguagesForEngine("Speechmatics"),
    },
  },
};

/**
 * Get provider configuration by ID
 * @param {string} providerId - Provider ID (e.g., 'google-gemini', 'openai-realtime')
 * @returns {Object|null} Provider configuration or null if not found
 */
export function getProviderConfig(providerId) {
  return AI_STREAMING_PROVIDERS[providerId] || null;
}

/**
 * Get Telnyx streaming configuration for a provider
 * @param {string} providerId - Provider ID
 * @returns {Object|null} Telnyx streaming configuration or null
 */
export function getTelnyxStreamingConfig(providerId) {
  const provider = getProviderConfig(providerId);
  return provider?.telnyx || null;
}

/**
 * Get list of all available providers
 * @returns {Array} Array of provider objects with id and label
 */
export function getAvailableProviders() {
  return Object.values(AI_STREAMING_PROVIDERS).map((provider) => ({
    id: provider.id,
    label: provider.label,
  }));
}
