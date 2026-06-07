/**
 * AI Streaming Provider Configurations
 * Configuration for Google Gemini Live and OpenAI Realtime streaming
 */


import { TRANSCRIPTION_PROVIDERS } from "./voice";
import { getLanguageByCode } from "@/lib/languages";
import { normalizeLanguageCode } from "@/lib/language-code-utils";

const GOOGLE_STANDALONE_STT_LANGUAGE_CODES = [
  "en-US",
  "en-GB",
  "pl-PL",
  "de-DE",
  "fr-FR",
  "es-ES",
  "it-IT",
  "nl-NL",
  "pt-PT",
  "pt-BR",
  "uk-UA",
  "ar-AE",
];

function toLanguageOption(code) {
  const normalizedCode = normalizeLanguageCode(code, { fallback: code });
  const language = getLanguageByCode(normalizedCode);
  return {
    value: normalizedCode,
    label: `${language.flag} ${language.name}`,
  };
}

function normalizeStandaloneSttModel(model) {
  if (!model) return "";
  const value = String(model);
  if (value === "nova-2") return "deepgram/nova-2";
  if (value === "nova-3") return "deepgram/nova-3";
  if (value === "flux") return "deepgram/flux";
  return value;
}

function standaloneSttLanguagesForModel(model) {
  const normalizedModel = normalizeStandaloneSttModel(model);
  if (["phone_call", "latest_long", "default"].includes(normalizedModel)) {
    return GOOGLE_STANDALONE_STT_LANGUAGE_CODES.map(toLanguageOption);
  }
  const provider = TRANSCRIPTION_PROVIDERS.find(
    (entry) => entry.model_name === normalizedModel,
  );
  const seen = new Set();
  return (provider?.languages || [])
    .map(toLanguageOption)
    .filter((option) => {
      if (!option.value || seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    });
}

export const TELNYX_STT_LANGUAGE_OPTIONS_BY_MODEL = Object.fromEntries(
  TRANSCRIPTION_PROVIDERS.map((provider) => [
    provider.model_name,
    standaloneSttLanguagesForModel(provider.model_name),
  ]),
);

function telnyxSttLanguagesForModel(model) {
  return standaloneSttLanguagesForModel(model);
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
    label: "Telnyx STT WS — Google phone_call (L16 test)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Google phone_call. Test preset for Telnyx-managed L16 media transcoding into linear16 @ 16 kHz.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams inbound audio using RTP L16 at 16 kHz; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "L16",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      stream_bidirectional_sampling_rate: 16000,
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Google",
      model: "phone_call",
      language: "en",
      input_format: "linear16",
      sample_rate: 16000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForModel("phone_call"),
    },
  },

  "telnyx-stt-google-latest-long": {
    id: "telnyx-stt-google-latest-long",
    label: "Telnyx STT WS — Google latest_long (L16 test)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Google latest_long. Test preset for Telnyx-managed L16 media transcoding into linear16 @ 16 kHz.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams inbound audio using RTP L16 at 16 kHz; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "L16",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      stream_bidirectional_sampling_rate: 16000,
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Google",
      model: "latest_long",
      language: "en",
      input_format: "linear16",
      sample_rate: 16000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForModel("latest_long"),
    },
  },

  "telnyx-stt-google-default": {
    id: "telnyx-stt-google-default",
    label: "Telnyx STT WS — Google default (L16 test)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Google default. Test preset for Telnyx-managed L16 media transcoding into linear16 @ 16 kHz.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams inbound audio using RTP L16 at 16 kHz; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "L16",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      stream_bidirectional_sampling_rate: 16000,
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Google",
      model: "default",
      language: "en",
      input_format: "linear16",
      sample_rate: 16000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForModel("default"),
    },
  },

  "telnyx-stt-xai-grok": {
    id: "telnyx-stt-xai-grok",
    label: "Telnyx STT WS — xAI Grok STT (L16 test)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using xAI Grok STT. Test preset for Telnyx-managed L16 media transcoding into linear16 @ 16 kHz.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams inbound audio using RTP L16 at 16 kHz; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "L16",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      stream_bidirectional_sampling_rate: 16000,
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "xAI",
      model: "xai/grok-stt",
      language: "en",
      input_format: "linear16",
      sample_rate: 16000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForModel("xai/grok-stt"),
    },
  },

  "telnyx-stt-deepgram-nova-2": {
    id: "telnyx-stt-deepgram-nova-2",
    label: "Telnyx STT WS — Deepgram Nova 2 (L16 test)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Deepgram Nova 2. Test preset for Telnyx-managed L16 media transcoding into linear16 @ 16 kHz.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams inbound audio using RTP L16 at 16 kHz; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "L16",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      stream_bidirectional_sampling_rate: 16000,
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Deepgram",
      model: "deepgram/nova-2",
      language: "en",
      input_format: "linear16",
      sample_rate: 16000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForModel("deepgram/nova-2"),
    },
  },

  "telnyx-stt-deepgram-nova-3": {
    id: "telnyx-stt-deepgram-nova-3",
    label: "Telnyx STT WS — Deepgram Nova 3 (L16 test)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Deepgram Nova 3. Test preset for Telnyx-managed L16 media transcoding into linear16 @ 16 kHz.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams inbound audio using RTP L16 at 16 kHz; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "L16",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      stream_bidirectional_sampling_rate: 16000,
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Deepgram",
      model: "deepgram/nova-3",
      language: "en",
      input_format: "linear16",
      sample_rate: 16000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForModel("deepgram/nova-3"),
    },
  },

  "telnyx-stt-deepgram-flux": {
    id: "telnyx-stt-deepgram-flux",
    label: "Telnyx STT WS — Deepgram Flux (L16 test)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Deepgram Flux. Test preset for Telnyx-managed L16 media transcoding into linear16 @ 16 kHz.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams inbound audio using RTP L16 at 16 kHz; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "L16",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      stream_bidirectional_sampling_rate: 16000,
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Deepgram",
      model: "deepgram/flux",
      language: "auto",
      input_format: "linear16",
      sample_rate: 16000,
      interim_results: true,
      supported_languages: telnyxSttLanguagesForModel("deepgram/flux"),
    },
  },

  "telnyx-stt-speechmatics-standard": {
    id: "telnyx-stt-speechmatics-standard",
    label: "Telnyx STT WS — Speechmatics standard (L16 test)",
    description: "Standalone Telnyx Speech-to-Text WebSocket using Speechmatics standard. Test preset for Telnyx-managed L16 media transcoding into linear16 @ 16 kHz.",
    type: "telnyx-stt",
    telnyx: {
      // Each call leg streams inbound audio using RTP L16 at 16 kHz; outbound/both start a second stream on the agent leg.
      stream_track: "inbound_track",
      stream_codec: "L16",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "L16",
      stream_bidirectional_sampling_rate: 16000,
    },
    telnyxStt: {
      enabled: true,
      transcription_tracks: "both",
      transcription_engine: "Speechmatics",
      model: "speechmatics/standard",
      language: "en",
      input_format: "linear16",
      sample_rate: 16000,
      interim_results: true,
      endpointing: 300,
      supported_languages: telnyxSttLanguagesForModel("speechmatics/standard"),
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
