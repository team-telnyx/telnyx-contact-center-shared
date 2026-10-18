export function enabledAiCousticsSettings(telephony = {}) {
  const saved = telephony.noise_suppression_config;
  if (saved?.family === "quail" && ["vf", "vf_2_0_l"].includes(saved.size))
    return { ...saved };
  return { family: "quail", size: "vf", enhancement_level: 0.8 };
}

export function backgroundAudioEnabled(background) {
  return Boolean(background?.type && !(background.type === "predefined_media" && background.value === "silence"));
}

// Choosing background sound replaces tool audio. Explicit null is necessary:
// Telnyx merges voice settings and retains tool audio when it is only omitted.
export function compatibleVoiceAudio(settings) {
  if (!settings || !backgroundAudioEnabled(settings.background_audio)) return settings;
  return { ...settings, tool_call_audio: null };
}

export function hasVoiceAudioConflict(settings) {
  return backgroundAudioEnabled(settings?.background_audio) && settings?.tool_call_audio != null;
}
