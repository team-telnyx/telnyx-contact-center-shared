const labels = {
  llm_api_key_ref: "Model authentication",
  api_key_ref: "Authentication secret",
  external_llm: "Custom model endpoint",
  fallback_config: "Backup language model",
  telephony_settings: "Calling",
  voice_settings: "Voice",
  widget_settings: "Widget",
  privacy_settings: "Privacy",
  interruption_settings: "Interruptions",
  observability_settings: "Observability",
  websocket_settings: "Live event connection",
  messaging_settings: "Messaging",
  conversation_flow: "Workflow",
  start_node_id: "Starting step",
  tool_ids: "Shared tools",
  a2a_agents: "Connected agents",
  transcription: "Transcription",
  fallback_models: "Fallback models",
  denoising: "Noise reduction",
  parallel_transcription: "Language Booster",
  dynamic_variables_webhook_timeout_ms: "Variable lookup timeout",
  dynamic_variables_webhook_url: "Variable lookup URL",
  dynamic_variables: "Conversation variables",
  in_transit_data_locality: "Processing region",
  disable_greeting_interruption: "Protect the greeting from interruptions",
  identity: "Identity & instructions",
  model: "Model & fallback",
  greeting: "Greeting & delegation",
  a2a: "Connected agents",
  locality: "Processing region",
  retention: "Retention & privacy",
  insight: "Insight groups",
};
export function settingLabel(path) {
  const key = path
    .replace(/\[\d*\]/g, "")
    .split(".")
    .at(-1);
  return (
    labels[key] ||
    key
      .replaceAll("_", " ")
      .replace(/\burl\b/gi, "URL")
      .replace(/\bid\b/gi, "ID")
      .replace(/^./, (c) => c.toUpperCase())
  );
}
export function redactAssistantSettings(value) {
  if (Array.isArray(value)) return value.map(redactAssistantSettings);
  if (value && typeof value === "object") {
    if (/authorization|api.?key|secret|token|cookie/i.test(value.name || ""))
      return { ...value, value: "••••••" };
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|token|api_key$|secret$|authorization|cookie/i.test(key)
          ? "••••••"
          : redactAssistantSettings(item),
      ]),
    );
  }
  return value;
}
export function describeSettingValue(value) {
  if (value === null || value === undefined || value === "")
    return "Not configured";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value))
    return value.length
      ? value
          .map((item) =>
            typeof item === "object"
              ? item?.name ||
                item?.model ||
                item?.webhook?.name ||
                item?.type ||
                "Configured item"
              : String(item),
          )
          .join(", ")
      : "None";
  if (typeof value === "object")
    return value.nodes
      ? `${value.nodes.length} steps · ${(value.edges || []).length} connections`
      : "Configured";
  return String(value);
}
export function assistantChangeRows(before, payload) {
  const rows = [];
  const original = redactAssistantSettings(before || {}),
    after = redactAssistantSettings(payload || {});
  function visit(previous, next, path) {
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    if (
      next &&
      typeof next === "object" &&
      !Array.isArray(next) &&
      path !== "conversation_flow"
    ) {
      for (const key of new Set([
        ...Object.keys(
          previous && typeof previous === "object" ? previous : {},
        ),
        ...Object.keys(next),
      ]))
        visit(previous?.[key], next[key], `${path}.${key}`);
    } else
      rows.push({
        path,
        label: settingLabel(path),
        before: describeSettingValue(previous),
        after: describeSettingValue(next),
      });
  }
  for (const [key, value] of Object.entries(after))
    visit(original[key], value, key);
  return rows;
}
