// Keep API paths in the diagnostic response, never in user-facing save messages.
const english = (text, values = {}) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);

const sections = {
  voice_settings: "Voice → Voice", telephony_settings: "Voice → Voice / Calling",
  transcription: "Voice → Transcription", interruption_settings: "Voice → Interruptions",
  conversation_flow: "Workflow", avatar_settings: "Avatar", widget_settings: "Widget",
  messaging_settings: "Messaging", insight_settings: "Insights", privacy_settings: "Privacy",
  observability_settings: "Insights → Observability", tools: "Integrations", tool_ids: "Integrations",
  integrations: "Integrations", mcp_servers: "Integrations", enabled_features: "Integrations",
  external_llm: "Agent → Model & fallback", fallback_config: "Agent → Model & fallback",
  model: "Agent → Model & fallback", llm_api_key_ref: "Agent → Model & fallback",
  delegation_settings: "Agent → Greeting & delegation", websocket_settings: "Integrations",
};
const descriptions = [
  ["voice_settings.background_audio.volume", "background audio volume"],
  ["voice_settings.background_audio", "background sound"],
  ["voice_settings.tool_call_audio.volume", "volume of audio while tools run"],
  ["voice_settings.tool_call_audio", "audio while tools run"],
  ["telephony_settings.noise_suppression_config.attenuation_limit", "noise reduction strength"],
  ["telephony_settings.noise_suppression_config", "noise reduction settings"],
  ["telephony_settings.noise_suppression", "noise reduction engine"],
  ["voice_settings.voice_speed", "voice speed"],
  ["voice_settings.voice", "assistant voice"],
  ["voice_settings", "voice settings"],
  ["telephony_settings", "call settings"],
  ["transcription.fallback_models", "backup transcription models"],
  ["transcription.challenger", "Language Booster"],
  ["transcription", "transcription settings"],
  ["conversation_flow", "workflow settings"],
  ["fallback_config", "backup language model"],
  ["external_llm", "custom language model connection"],
  ["model", "language model"],
  ["llm_api_key_ref", "model authentication"],
  ["name", "assistant name"], ["instructions", "assistant instructions"], ["tags", "tags"],
  ["avatar_settings", "avatar settings"], ["widget_settings", "widget settings"],
  ["privacy_settings", "privacy settings"], ["tools", "assistant tools"], ["tool_ids", "shared tools"],
];
function settingDescription(path, tUi) {
  const normalized = String(path || "").replace(/\[\d+\]/g, "");
  const item = descriptions.find(([prefix]) => normalized === prefix || normalized.startsWith(`${prefix}.`));
  return { label: tUi(item?.[1] || "assistant settings"), section: tUi(sections[normalized.split(".")[0]] || "Agent") };
}

export function assistantVerificationMessage(verification, tUi = english) {
  if (!verification?.paths?.length)
    return tUi("Telnyx accepted the save, but we could not confirm the saved settings. Your draft is still available. Try saving again before leaving this page.");
  const settings = verification.paths.map(path => settingDescription(path, tUi));
  const unique = [...new Map(settings.map(item => [`${item.section}:${item.label}`, item])).values()];
  return [
    ...unique.slice(0, 3).map(({ label, section }) => tUi("The saved {setting} differs from your selection. Review it in {section}.", { setting: label, section })),
    ...(unique.length > 3 ? [tUi("Some other settings also need review.")] : []),
    tUi("Your draft is still available. Review these settings and save again before leaving this page."),
  ].join(" ");
}

export function assistantSaveErrorMessage(error, tUi = english) {
  const detail = String(error?.message || error || "");
  if ((/tool_call_audio/.test(detail) && /background_audio/.test(detail)) || detail.startsWith("Background audio and audio while tools run cannot be used together."))
    return tUi("Background audio and audio while tools run cannot be used together. Choose Silence as the background sound, or turn off audio while tools run, then save again.");
  if (/timeout|timed out|failed to fetch|network|fetch failed/i.test(detail))
    return tUi("We could not reach Telnyx to confirm the save. Your draft is still available. Check your connection and try again.");
  if (/rate limit|too many requests|\b429\b/i.test(detail))
    return tUi("Telnyx is receiving too many requests. Wait a moment and save again. Your draft is still available.");
  const field = detail.match(/^([a-z][a-z_]*(?:\.[a-z_]+|\[\d+\])*)\s*:/)?.[1];
  if (field) {
    const { label, section } = settingDescription(field, tUi);
    return tUi("Check {setting} in {section}. One of the values is missing or is not supported. Correct it and save again. Your draft is still available.", { setting: label, section });
  }
  return tUi("The assistant could not be saved. Review your configuration and try again. Your draft is still available. If this continues, contact your administrator.");
}
