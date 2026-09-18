export const ASSISTANT_TOOL_LIBRARY_SOURCE_KEY = "x_demo_portal_tool_source";
export const ASSISTANT_TOOL_LIBRARY_SOURCE_VALUE = "tools_library";

const TOOL_DEFINITION_KEYS = [
  "webhook",
  "hangup",
  "transfer",
  "handoff",
  "send_message",
  "invite",
  "refer",
  "send_dtmf",
  "retrieval",
  "skip_turn",
  "whatsapp_template",
  "client_side_tool",
];

export function getLibraryToolDefinition(tool) {
  if (!tool || typeof tool !== "object") return {};
  if (tool.tool_definition && typeof tool.tool_definition === "object") {
    return tool.tool_definition;
  }
  const type = tool.type;
  if (type && tool[type] && typeof tool[type] === "object") {
    return tool[type];
  }
  for (const key of TOOL_DEFINITION_KEYS) {
    if (tool[key] && typeof tool[key] === "object") return tool[key];
  }
  return {};
}

export function getAssistantToolId(tool) {
  const toolId = tool?.tool_id ?? tool?.id;
  return typeof toolId === "string" && toolId.trim() ? toolId.trim() : null;
}

export function isLibraryAssistantTool(tool, libraryToolIds = new Set()) {
  const toolId = getAssistantToolId(tool);
  if (!toolId) return false;
  if (tool?.[ASSISTANT_TOOL_LIBRARY_SOURCE_KEY] === ASSISTANT_TOOL_LIBRARY_SOURCE_VALUE) {
    return true;
  }
  if (tool?.shared === true || tool?.is_library_tool === true) {
    return true;
  }
  return libraryToolIds instanceof Set && libraryToolIds.has(String(toolId));
}

export function sanitizeAssistantToolForTelnyx(tool) {
  if (!tool || typeof tool !== "object") return tool;
  const next = { ...tool };
  delete next[ASSISTANT_TOOL_LIBRARY_SOURCE_KEY];
  delete next.shared;
  delete next.is_library_tool;
  return next;
}

export function libraryToolToAssistantTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  const type = String(tool.type || "").trim();
  if (!type) return null;

  const definition = getLibraryToolDefinition(tool);
  const mapped = {
    type,
    ...(tool.id ? { tool_id: tool.id } : {}),
    ...(tool.display_name ? { display_name: tool.display_name } : {}),
    ...(tool.id
      ? { [ASSISTANT_TOOL_LIBRARY_SOURCE_KEY]: ASSISTANT_TOOL_LIBRARY_SOURCE_VALUE }
      : {}),
    [type]: { ...definition },
  };

  if (typeof tool.async === "boolean") mapped.async = tool.async;
  if (
    tool.timeout_ms !== undefined &&
    tool.timeout_ms !== null &&
    tool.timeout_ms !== "" &&
    Number.isFinite(Number(tool.timeout_ms))
  ) {
    mapped.timeout_ms = Number(tool.timeout_ms);
  }
  if (tool.warm_transfer_instructions !== undefined) {
    mapped.warm_transfer_instructions = tool.warm_transfer_instructions;
  }

  return mapped;
}

export function assistantToolToLibraryPayload(tool, displayNameOverride) {
  if (!tool || typeof tool !== "object") return null;
  const type = String(tool.type || "").trim();
  if (!type) return null;

  const definition = getLibraryToolDefinition(tool);
  const displayName =
    String(displayNameOverride || "").trim() ||
    tool.display_name ||
    definition.display_name ||
    definition.name ||
    tool.name ||
    type;

  const payload = {
    type,
    display_name: displayName,
    [type]: { ...definition },
  };

  if (typeof tool.async === "boolean") payload.async = tool.async;
  if (
    tool.timeout_ms !== undefined &&
    tool.timeout_ms !== null &&
    tool.timeout_ms !== "" &&
    Number.isFinite(Number(tool.timeout_ms))
  ) {
    payload.timeout_ms = Number(tool.timeout_ms);
  }
  if (tool.warm_transfer_instructions !== undefined) {
    payload.warm_transfer_instructions = tool.warm_transfer_instructions;
  }

  return payload;
}

export function mergeLibraryToolsIntoAssistantTools(currentTools, libraryTools) {
  const next = Array.isArray(currentTools) ? [...currentTools] : [];
  const existingToolIds = new Set(
    next.map((tool) => tool?.tool_id).filter(Boolean).map(String)
  );

  for (const libraryTool of Array.isArray(libraryTools) ? libraryTools : []) {
    const mapped = libraryToolToAssistantTool(libraryTool);
    if (!mapped) continue;
    if (mapped.tool_id && existingToolIds.has(String(mapped.tool_id))) continue;
    next.push(mapped);
    if (mapped.tool_id) existingToolIds.add(String(mapped.tool_id));
  }

  return next;
}

// --- Saving an assistant: inline tools vs. shared (library) tools ---------
//
// Telnyx returns shared tools attached to an assistant inside `tools`, with
// `tool_id` and `shared: true`, expanded with their definition. Sending them
// back inline creates a second tool with the same webhook name next to the
// attachment ("Webhook tools names must be unique"). Shared tools therefore
// never travel in the update payload; they are attached and detached through
// /ai/assistants/{id}/tools/{toolId}.

export function extractSharedToolIds(tools, libraryToolIds = new Set()) {
  if (!Array.isArray(tools)) return new Set();
  return new Set(
    tools
      .filter((tool) => isLibraryAssistantTool(tool, libraryToolIds))
      .map(getAssistantToolId)
      .filter(Boolean)
      .map(String)
  );
}

export function stripSharedToolsForAssistantUpdate(payload, libraryToolIds = new Set()) {
  if (!Array.isArray(payload?.tools)) return payload;
  return {
    ...payload,
    tools: payload.tools
      .filter((tool) => !isLibraryAssistantTool(tool, libraryToolIds))
      .map(sanitizeAssistantToolForTelnyx),
  };
}

export function getWebhookToolName(tool) {
  if (!tool || tool.type !== "webhook") return null;
  const name = tool.webhook?.name ?? tool.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

// Names that Telnyx would reject as duplicates inside one assistant: inline
// webhook tools repeated in the payload, or an inline copy of a shared tool
// that stays attached. `attachedSharedNames` are the names of shared tools
// that will be attached after the save.
export function findDuplicateWebhookToolNames(inlineTools, attachedSharedNames = []) {
  const seen = new Map();
  for (const name of attachedSharedNames) if (name) seen.set(name, 1);
  const duplicates = new Set();
  for (const tool of Array.isArray(inlineTools) ? inlineTools : []) {
    const name = getWebhookToolName(tool);
    if (!name) continue;
    if (seen.has(name)) duplicates.add(name);
    seen.set(name, (seen.get(name) || 0) + 1);
  }
  return [...duplicates];
}
