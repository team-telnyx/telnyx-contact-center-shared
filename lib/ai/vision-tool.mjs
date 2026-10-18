function attachedTools(assistant) {
  // Expanded definitions can remain after a shared tool was detached.
  // When supplied, tool_ids is authoritative for shared attachments.
  return (assistant?.tools || []).filter(tool => !tool.tool_id || assistant.tool_ids === undefined || assistant.tool_ids.includes(tool.tool_id));
}

export function assistantVisionToolStatus(assistant) {
  const tools = attachedTools(assistant);
  if (tools.some(tool => tool.type === "vision")) return "present";
  const resolved = new Set(tools.filter(tool => tool.type).map(tool => tool.tool_id));
  const ids = [...(assistant?.tool_ids || []), ...tools.map(tool => tool.tool_id).filter(Boolean)];
  return ids.some(id => !resolved.has(id)) ? "unknown" : "missing";
}

export async function hasAssistantVisionTool(assistant, request) {
  const status = assistantVisionToolStatus(assistant);
  if (status !== "unknown") return status === "present";
  const ids = new Set([...(assistant.tool_ids || []), ...attachedTools(assistant).map(tool => tool.tool_id).filter(Boolean)]);
  for (const id of ids) {
    const response = await request(`/ai/tools/${encodeURIComponent(id)}`);
    if ((response.data || response).type === "vision") return true;
  }
  return false;
}
