import { assertVisionCapability } from "./vision-capabilities.mjs";
export async function validateAssistantVision(assistant, { request, buffered = false } = {}) {
  const call = request || (await import("../widgets/ai-provider.js")).widgetAiRequest;
  const catalog = await call("/ai/openai/models");
  return assertVisionCapability(assistant, catalog.data || [], { buffered });
}

// Resolve the effective shared attachments as well as inline tools. Node-level
// tools use the same library, so they must not bypass capability validation.
export async function validateAssistantVisionTools(assistant, { request } = {}) {
  const call = request || (await import("../widgets/ai-provider.js")).widgetAiRequest;
  const tools = (assistant.tools || []).filter(tool => !tool.tool_id || assistant.tool_ids === undefined || assistant.tool_ids.includes(tool.tool_id));
  if (tools.some(tool => tool.type === "vision")) return validateAssistantVision(assistant, { request: call, buffered: true });
  const ids = new Set([
    ...(assistant.tool_ids || []),
    ...tools.map(tool => tool.tool_id).filter(Boolean),
    ...(assistant.conversation_flow?.nodes || []).flatMap(node => node.shared_tool_ids || []),
  ]);
  for (const id of ids) {
    const response = await call(`/ai/tools/${encodeURIComponent(id)}`);
    if ((response.data || response).type === "vision") return validateAssistantVision(assistant, { request: call, buffered: true });
  }
}
