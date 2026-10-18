import {
  extractSharedToolIds,
  stripSharedToolsForAssistantUpdate,
  isLibraryAssistantTool,
  getAssistantToolId,
} from "./tool-library.js";
import { normalizeAssistantPayload } from "./assistant-payload.mjs";
import { modelProvider } from "./model-providers.mjs";

// Writable roots from the endpoint-specific Telnyx request contract (2026-10-14).
// Keep server metadata and local navigation state out of requests.
export const ASSISTANT_WRITABLE_FIELDS = [
  "name",
  "model",
  "instructions",
  "tools",
  "mcp_servers",
  "a2a_agents",
  "tool_ids",
  "description",
  "greeting",
  "llm_api_key_ref",
  "external_llm",
  "fallback_config",
  "voice_settings",
  "avatar_settings",
  "transcription",
  "telephony_settings",
  "messaging_settings",
  "enabled_features",
  "insight_settings",
  "privacy_settings",
  "dynamic_variables_webhook_url",
  "dynamic_variables_webhook_timeout_ms",
  "dynamic_variables",
  "widget_settings",
  "interruption_settings",
  "integrations",
  "observability_settings",
  "tags",
  "post_conversation_settings",
  "delegation_settings",
  "websocket_settings",
  "conversation_flow",
];
const clone = (value) =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const voiceAliases = {
  voice: "voice",
  voice_speed: "voice_speed",
  voice_api_key_ref: "api_key_ref",
  background_audio: "background_audio",
  language_boost: "language_boost",
  voice_language: "language",
  pronunciation_dict_id: "pronunciation_dict_id",
  expressive_mode: "expressive_mode",
};

export function assistantForEditor(assistant = {}) {
  const source = clone(assistant);
  const voice = source.voice_settings || {};
  const result = {
    name: "",
    instructions: "",
    greeting: "",
    description: "",
    model: "",
    tools: [],
    dynamic_variables: {},
    ...source,
    voice: voice.voice || "",
    voice_speed: voice.voice_speed ?? 1,
    voice_api_key_ref: voice.api_key_ref || "",
    background_audio: voice.background_audio ?? {
      type: "predefined_media",
      value: "silence",
      volume: 0.5,
    },
    elevenlabs_settings: Object.fromEntries(
      [
        "temperature",
        "similarity_boost",
        "style",
        "speed",
        "use_speaker_boost",
      ].map((key) => [key, voice[key]]),
    ),
    language_boost: voice.language_boost || "",
    voice_language: voice.language || "",
    pronunciation_dict_id: voice.pronunciation_dict_id || "",
    expressive_mode: voice.expressive_mode ?? false,
    telephony: normalizeAssistantPayload({
      telephony_settings: source.telephony_settings || source.telephony || {},
    }).telephony_settings,
    messaging: clone(source.messaging_settings || source.messaging || {}),
  };
  // Baselines let legacy controls display defaults without silently writing them.
  result._original = clone(
    Object.fromEntries(
      ASSISTANT_WRITABLE_FIELDS.filter((k) => source[k] !== undefined).map(
        (k) => [k, source[k]],
      ),
    ),
  );
  result._editorBaseline = Object.fromEntries(
    [
      ...Object.keys(voiceAliases),
      "elevenlabs_settings",
      "telephony",
      "messaging",
    ].map((k) => [k, clone(result[k])]),
  );
  result._writableBaseline = clone(
    Object.fromEntries(
      ASSISTANT_WRITABLE_FIELDS.filter((key) => result[key] !== undefined).map(
        (key) => [key, result[key]],
      ),
    ),
  );
  return result;
}

export function payloadForSave(values, { patch = false } = {}) {
  const payload = Object.fromEntries(
    ASSISTANT_WRITABLE_FIELDS.filter((k) => values[k] !== undefined).map(
      (k) => [k, clone(values[k])],
    ),
  );
  const baseline = values._editorBaseline || {};
  const voiceSettings = assistantVoiceSettings(values);
  if (voiceSettings !== undefined) payload.voice_settings = voiceSettings;
  for (const [alias, key] of [
    ["telephony", "telephony_settings"],
    ["messaging", "messaging_settings"],
  ]) {
    if (values[alias] !== undefined && !equal(values[alias], baseline[alias]))
      payload[key] = clone(values[alias]);
  }
  const editedRoots = new Set(
    Object.keys(payload).filter(
      (key) =>
        !equal(
          payload[key],
          (values._writableBaseline || values._original)?.[key],
        ),
    ),
  );
  // This is a Contact Center variable-source extension, not a Telnyx field.
  // Its UI state is intentionally not forwarded.
  if (payload.external_llm?.model) {
    if (editedRoots.has("external_llm")) {
      editedRoots.add("model");
      editedRoots.add("llm_api_key_ref");
    }
    payload.model = "";
    payload.llm_api_key_ref = "";
  }
  for (const tool of payload.tools || []) {
    if (!isLibraryAssistantTool(tool)) continue;
    const previous = values._original?.tools?.find(
      (item) => getAssistantToolId(item) === getAssistantToolId(tool),
    );
    if (previous && !equal(tool, previous))
      throw new Error(
        "Edit shared tool definitions in Tools Library. Assistant changes can attach or detach shared tools.",
      );
  }
  let normalized = normalizeAssistantPayload(payload);
  if (Array.isArray(payload.tools) && editedRoots.has("tools")) {
    if (
      values.tool_ids === undefined ||
      equal(values.tool_ids, values._original?.tool_ids)
    ) {
      normalized.tool_ids = [...extractSharedToolIds(payload.tools)];
      editedRoots.add("tool_ids");
    }
    normalized = stripSharedToolsForAssistantUpdate(normalized);
  }
  if (Array.isArray(normalized.tags))
    normalized.tags = [...new Set(normalized.tags.filter((tag) => tag.trim()))];
  if (patch)
    for (const key of Object.keys(normalized)) {
      if (
        !editedRoots.has(key) ||
        equal(normalized[key], values._original?.[key])
      )
        delete normalized[key];
    }
  return normalized;
}

export function modelConfigurationErrors(config, prefix = "model") {
  const errors = [];
  const external = config?.external_llm;
  if (external) {
    if (modelProvider(config) === "fastrouter" && !external.llm_api_key_ref?.trim())
      errors.push(`${prefix}: select a FastRouter API key reference.`);
    if (!external.model?.trim())
      errors.push(`${prefix}: enter an external model identifier.`);
    try {
      const url = new URL(external.base_url);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error();
    } catch {
      errors.push(`${prefix}: enter an HTTPS base URL without credentials.`);
    }
    if (external.authentication_method === "certificate") {
      if (!external.certificate_ref?.trim())
        errors.push(`${prefix}: select a certificate reference.`);
      try {
        if (new URL(external.token_retrieval_url).protocol !== "https:")
          throw new Error();
      } catch {
        errors.push(`${prefix}: enter an HTTPS token retrieval URL.`);
      }
    }
  }
  return errors;
}

/** Shared canonical voice value for the catalog picker and advanced fields. */
export function assistantVoiceSettings(values) {
  const baseline = values._editorBaseline || {};
  let voiceSettings = clone(values.voice_settings);
  for (const [alias, key] of Object.entries(voiceAliases)) {
    if (values[alias] !== undefined && !equal(values[alias], baseline[alias])) {
      voiceSettings = {
        ...voiceSettings,
        [key]: clone(values[alias]),
      };
    }
  }
  if (!equal(values.elevenlabs_settings, baseline.elevenlabs_settings)) {
    voiceSettings = {
      ...voiceSettings,
      ...clone(values.elevenlabs_settings),
    };
  }
  return voiceSettings;
}
export function withAssistantVoiceSettings(values, settings) {
  const refreshed = assistantForEditor({ voice_settings: settings });
  const aliases = Object.fromEntries(
    [...Object.keys(voiceAliases), "elevenlabs_settings"].map((alias) => [
      alias,
      refreshed[alias],
    ]),
  );
  return {
    ...values,
    voice_settings: clone(settings),
    ...aliases,
    // Canonical updates also synchronize the displayed controls. Compare future
    // control edits with this synchronization point, so selecting the originally
    // saved voice again still overrides the newer canonical value. Keep the
    // persisted baselines intact for patch generation and change review.
    _editorBaseline: { ...values._editorBaseline, ...clone(aliases) },
  };
}
