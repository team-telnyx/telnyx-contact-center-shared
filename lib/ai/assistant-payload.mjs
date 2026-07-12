export function normalizeAssistantPayload(payloadInput) {
  const payload = payloadInput ? JSON.parse(JSON.stringify(payloadInput)) : {};
  if (payload.greetings && !payload.greeting) { payload.greeting = payload.greetings; delete payload.greetings; }
  if (payload.transcription && (payload.transcription.region === "" || payload.transcription.region === null)) {
    if (String(payload.transcription.model || "").startsWith("azure/")) payload.transcription.region = "latency";
    else delete payload.transcription.region;
  }
  if (payload.voice_settings && typeof payload.voice_settings === "object") {
    const elevenlabs = payload.voice_settings.elevenlabs_settings;
    if (elevenlabs && typeof elevenlabs === "object") {
      for (const field of ["temperature", "similarity_boost", "style", "use_speaker_boost"]) if (elevenlabs[field] !== undefined) payload.voice_settings[field] = elevenlabs[field];
      if (elevenlabs.speed !== undefined) payload.voice_settings.voice_speed = Number(elevenlabs.speed);
      delete payload.voice_settings.elevenlabs_settings;
    }
    if (payload.voice_settings.language_boost === "") delete payload.voice_settings.language_boost;
    else if (String(payload.voice_settings.language_boost).toLowerCase() === "auto") payload.voice_settings.language_boost = "auto";
    if (payload.voice_settings.voice_speed === undefined && payload.voice_settings.speed !== undefined) payload.voice_settings.voice_speed = Number(payload.voice_settings.speed);
    delete payload.voice_settings.speed;
  }
  const voicemail = payload.telephony_settings?.voicemail_detection;
  if (voicemail && typeof voicemail === "object" && typeof voicemail.on_voicemail_detected === "string") {
    const action = { stop: "stop_assistant", leave_message: "leave_message_and_stop_assistant", continue: "continue_assistant" }[voicemail.on_voicemail_detected] || "stop_assistant";
    const next = { on_voicemail_detected: { action } };
    if (action === "leave_message_and_stop_assistant" && voicemail.voicemail_message?.trim()) next.on_voicemail_detected.voicemail_message = { type: "message", message: voicemail.voicemail_message.trim() };
    payload.telephony_settings.voicemail_detection = next;
  }
  const recording = payload.telephony_settings?.recording_settings;
  if (recording && typeof recording === "object" && "enabled" in recording) {
    payload.telephony_settings.recording_settings = recording.enabled === false ? null : { format: recording.format || "mp3", channels: recording.channels || "single" };
  }
  if (["normal", "aggressive", "ultra_aggressive", "near_field", "far_field"].includes(payload.telephony_settings?.noise_suppression_config?.mode)) payload.telephony_settings.noise_suppression_config.mode = "advanced";
  if (Array.isArray(payload.tools)) payload.tools = payload.tools.map((tool) => {
    if (!tool || tool.type !== "webhook") return tool;
    const next = { ...tool, webhook: { ...(tool.webhook || {}) } };
    if (typeof next.async === "boolean" && next.webhook.async === undefined) next.webhook.async = next.async;
    delete next.async;
    if (typeof next.webhook.timeout_secs === "number" && next.webhook.timeout_ms === undefined) next.webhook.timeout_ms = Math.round(next.webhook.timeout_secs * 1000);
    delete next.webhook.timeout_secs;
    return next;
  });
  if (Array.isArray(payload.conversation_flow?.nodes)) for (const node of payload.conversation_flow.nodes) { delete node.tools_override; delete node.tools_mode; }
  return payload;
}
