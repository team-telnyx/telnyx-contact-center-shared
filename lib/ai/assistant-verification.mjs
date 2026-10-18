import { buildTelnyxV2Url } from "../telnyx.js";

const ignored = new Set([
  "promote_to_main",
  "version_name",
  "shared",
  "is_library_tool",
  "tool_id",
  "id",
  "display_name",
  "x_demo_portal_tool_source",
]);
const empty = (value) =>
  value == null ||
  value === "" ||
  (Array.isArray(value) && !value.length) ||
  (typeof value === "object" && Object.values(value).every(empty));
// Telnyx retains inactive audio tuning when merging nested objects. Its presence
// is not a failed clear: volume is inapplicable to silence and custom media,
// and each suppression engine only uses its own tuning fields.
function audioComparisonView(value, expected, previous) {
  const result = structuredClone(value);
  if (!result || typeof result !== "object") return result;
  function voice(settings, requested) {
    for (const key of ["background_audio", "tool_call_audio"]) {
      const audio = requested?.[key];
      if (settings?.[key] && ((key === "background_audio" && audio?.type === "predefined_media" && audio.value === "silence") || ["media_url", "media_name"].includes(audio?.type)))
        delete settings[key].volume;
    }
  }
  voice(result.voice_settings, expected?.voice_settings);
  result.conversation_flow?.nodes?.forEach((node, index) => voice(node.voice_settings, expected?.conversation_flow?.nodes?.[index]?.voice_settings));
  const engine = expected?.telephony_settings?.noise_suppression ?? previous?.telephony_settings?.noise_suppression;
  const config = result.telephony_settings?.noise_suppression_config;
  if (config && ["deepfilternet", "aicoustics", "krisp", "disabled"].includes(engine)) {
    if (engine !== "deepfilternet") for (const key of ["attenuation_limit", "mode"]) delete config[key];
    if (engine !== "aicoustics") for (const key of ["family", "size", "enhancement_level"]) delete config[key];
  }
  return result;
}

/** Compare effective writable values, allowing server-added defaults but never a lost active value. */
export function assistantWriteDifferences(expected, actual, path = "", previous) {
  if (path) return writeDifferences(expected, actual, path, previous);
  return writeDifferences(
    audioComparisonView(expected, expected, previous),
    audioComparisonView(actual, expected, previous),
    path,
    audioComparisonView(previous, expected, previous),
  );
}

function writeDifferences(expected, actual, path = "", previous) {
  if (expected === undefined) return [];
  if (expected === null && empty(actual)) return [];
  if (expected === "" && actual == null) return [];
  if (Array.isArray(expected)) {
    if (!expected.length && actual == null) return [];
    if (!Array.isArray(actual) || expected.length !== actual.length)
      return [path];
    return expected.flatMap((v, i) =>
      writeDifferences(v, actual[i], `${path}[${i}]`, previous?.[i]),
    );
  }
  if (expected && typeof expected === "object") {
    // An explicit empty object is a clear request, not an empty comparison.
    if (path && !Object.keys(expected).length) return empty(actual) ? [] : [path];
    if (!actual || typeof actual !== "object") return [path];
    const isTool = /(?:^|\.)tools\[\d+\]$/.test(path);
    const differences = Object.entries(expected).flatMap(([key, value]) => {
      if (
        (!path && ["promote_to_main", "version_name"].includes(key)) ||
        (isTool && ignored.has(key))
      )
        return [];
      let stored = actual[key];
      let prior = previous?.[key];
      if (!path && key === "tools")
        {
          stored = (actual.tools || []).filter((tool) => !tool.shared);
          prior = (previous?.tools || []).filter((tool) => !tool.shared);
        }
      if (!path && key === "tool_ids")
        stored =
          actual.tool_ids ||
          (actual.tools || [])
            .filter((t) => t.shared)
            .map((t) => t.tool_id || t.id);
      if (!path && key === "tool_ids")
        return JSON.stringify([...value].sort()) ===
          JSON.stringify([...stored].sort())
          ? []
          : ["tool_ids"];
      return writeDifferences(
        value,
        stored,
        path ? `${path}.${key}` : key,
        prior,
      );
    });
    // Omitted roots are patches. Within an edited object, a previously stored
    // value omitted from the replacement must actually disappear. New server
    // defaults remain allowed; variable maps require an exact set of keys.
    if (path) for (const key of Object.keys(path === "dynamic_variables" ? actual : previous || {})) {
      if (!(key in expected) && !(isTool && ignored.has(key)) && !empty(actual[key]))
        differences.push(`${path}.${key}`);
    }
    return differences;
  }
  return Object.is(expected, actual) ? [] : [path];
}
export async function verifyAssistantWrite(
  apiKey,
  id,
  payload,
  { versionId, previousAssistant, fetchImpl = fetch } = {},
) {
  if (payload.promote_to_main === false && !versionId)
    return {
      verification: {
        status: "unavailable",
        message:
          "The version was accepted, but its identifier was not returned for independent read-back.",
      },
    };
  const suffix = versionId ? `/versions/${encodeURIComponent(versionId)}` : "";
  let assistant,
    mismatches = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchImpl(
        buildTelnyxV2Url(`/ai/assistants/${encodeURIComponent(id)}${suffix}`),
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) throw new Error();
      const data = await response.json();
      assistant = data.data || data;
      mismatches = assistantWriteDifferences(payload, assistant, "", previousAssistant);
      if (!mismatches.length)
        return {
          assistant,
          verification: {
            status: "verified",
            attempts: attempt,
            checked_at: new Date().toISOString(),
          },
        };
    } catch {
      if (attempt === 3)
        return {
          assistant,
          verification: {
            status: "unavailable",
            message: "The save was accepted, but independent read-back failed.",
          },
        };
    }
    if (attempt < 3)
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }
  return {
    assistant,
    verification: {
      status: "mismatch",
      paths: mismatches,
      checked_at: new Date().toISOString(),
    },
  };
}
