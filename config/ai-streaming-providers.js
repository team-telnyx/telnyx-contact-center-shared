/**
 * AI Streaming Provider Configurations
 * Configuration for Google Gemini Live and OpenAI Realtime streaming
 */

export const AI_STREAMING_PROVIDERS = {
  "google-gemini": {
    id: "google-gemini",
    label: "Google Gemini Live",
    model: "gemini-2.0-flash-exp",
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
      stream_bidirectional_sampling_rate: 8000, // 8kHz sampling
      stream_bidirectional_target_legs: "opposite", // Send AI audio to caller
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
    model: "gpt-4o-realtime-preview-2024-10-01",
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
      stream_bidirectional_sampling_rate: 8000, // 8kHz sampling for g711_ulaw
      stream_bidirectional_target_legs: "opposite", // Send AI audio to caller
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
