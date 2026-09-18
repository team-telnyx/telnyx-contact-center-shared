// Page context reaches the assistant as Telnyx dynamic variables: conversation
// metadata for web chat, and X- SIP headers for WebRTC calls. Both resolve as
// {{snake_case_name}} inside the assistant's instructions and tools.

const MAXIMUM_VARIABLES = 50;
const MAXIMUM_VALUE_LENGTH = 512;

// The integration owns these; a host page must never be able to overwrite them,
// least of all widget_session_id, which authorizes the Contact Center handoff.
export const RESERVED_DYNAMIC_VARIABLE_NAMES = Object.freeze([
  "source",
  "telnyx_conversation_channel",
  "widget_id",
  "widget_origin",
  "widget_session_id",
  "cc_widget_handoff_token",
  "cc_handoff_tool",
  "cc_handoff_queues",
]);

const reserved = new Set(RESERVED_DYNAMIC_VARIABLE_NAMES);

export function dynamicVariableName(key) {
  const name = String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  // Telnyx resolves {{name}} placeholders, so a variable has to read as an
  // identifier: leading digits would never be referenced from instructions.
  if (!name || !/^[a-z]/.test(name)) return null;
  return name.slice(0, 64);
}

function scalarValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAXIMUM_VALUE_LENGTH) : null;
}

export function widgetDynamicVariables(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) return {};
  const variables = {};
  for (const [key, rawValue] of Object.entries(context)) {
    if (Object.keys(variables).length >= MAXIMUM_VARIABLES) break;
    const name = dynamicVariableName(key);
    if (!name || reserved.has(name) || variables[name] !== undefined) continue;
    const value = scalarValue(rawValue);
    if (value !== null) variables[name] = value;
  }
  return variables;
}

// Telnyx resolves {{placeholders}} inside a live conversation, but an Assistant
// greeting read straight from its configuration is still a raw template, so it is
// substituted here before the customer ever sees it.
export function interpolateDynamicVariables(text, variables = {}) {
  return String(text || "")
    .replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
      const name = dynamicVariableName(key);
      return name && variables[name] !== undefined ? variables[name] : "";
    })
    // Removing an unknown placeholder must not leave stray spacing behind.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

// Telnyx turns an X-Foo-Bar SIP header on the WebRTC invite into {{foo_bar}}.
export function dynamicVariableHeaderName(name) {
  return `X-${name.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-")}`;
}

export function widgetDynamicVariableHeaders(context) {
  return Object.entries(widgetDynamicVariables(context)).map(([name, value]) => ({
    name: dynamicVariableHeaderName(name),
    value,
  }));
}
