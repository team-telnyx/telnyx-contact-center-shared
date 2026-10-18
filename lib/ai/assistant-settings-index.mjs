import { settingLabel } from "./assistant-setting-presentation.mjs";
import {
  assistantSchemas,
  resolveAssistantSchema,
} from "./assistant-contract.mjs";
export function settingLocation(path) {
  const [root, field] = path.replaceAll("[]", "").split(".");
  if (["name", "description", "instructions", "tags"].includes(root))
    return ["agent", "identity"];
  if (
    ["model", "llm_api_key_ref", "external_llm", "fallback_config"].includes(
      root,
    )
  )
    return ["agent", "model"];
  if (["greeting", "delegation_settings"].includes(root))
    return ["agent", "greeting"];
  if (root === "voice_settings") return ["voice", "voice"];
  if (root === "transcription") return ["voice", "transcription"];
  if (root === "interruption_settings") return ["voice", "interruptions"];
  if (["tools", "tool_ids"].includes(root)) return ["integrations", "tools"];
  if (["mcp_servers", "integrations"].includes(root))
    return ["integrations", "connections"];
  if (root === "a2a_agents") return ["integrations", "a2a"];
  if (["observability_settings", "websocket_settings"].includes(root))
    return ["integrations", "observability"];
  if (root.startsWith("dynamic_variables"))
    return ["integrations", "variables"];
  if (
    root === "telephony_settings" &&
    ["noise_suppression", "noise_suppression_config"].includes(field)
  )
    return ["voice", "voice"];
  if (root === "telephony_settings")
    return [
      "calling",
      field === "recording_settings"
        ? "recording"
        : field === "voicemail_detection"
          ? "voicemail"
          : [
                "default_texml_app_id",
                "supports_unauthenticated_web_calls",
              ].includes(field)
            ? "connection"
            : "behavior",
    ];
  if (root === "enabled_features") return ["calling", "connection"];
  if (root === "messaging_settings") return ["messaging", "delivery"];
  if (root === "insight_settings") return ["insights", "insight"];
  if (root === "post_conversation_settings") return ["insights", "processing"];
  if (root === "avatar_settings") return ["avatar", null];
  if (root === "widget_settings")
    return [
      "widget",
      ["theme", "audio_visualizer_config", "logo_icon_url"].includes(field)
        ? "appearance"
        : "behavior",
    ];
  if (root === "privacy_settings")
    return [
      "privacy",
      field === "in_transit_data_locality" ? "locality" : "retention",
    ];
  return ["workflow", null];
}
const index = new Map();
function visit(raw, path, seen = new Set()) {
  index.set(path, {
    path,
    label: settingLabel(path),
    location: settingLocation(path),
  });
  if (raw?.$ref) {
    if (seen.has(raw.$ref)) return;
    seen = new Set([...seen, raw.$ref]);
  }
  const s = resolveAssistantSchema(raw);
  for (const [k, v] of Object.entries(s.properties || {}))
    if (!v.readOnly) visit(v, `${path}.${k}`, seen);
  if (s.items) visit(s.items, `${path}[]`, seen);
  for (const v of s.anyOf || s.oneOf || []) visit(v, path, seen);
}
for (const [key, schema] of Object.entries(
  assistantSchemas.CreateAssistantRequest.properties,
))
  visit(schema, key);
export const ASSISTANT_SETTINGS_INDEX = [...index.values()].filter(
  (item) =>
    !/\.(id|position|x|y|start_node_id|node_id|target|type)$/.test(item.path),
);
