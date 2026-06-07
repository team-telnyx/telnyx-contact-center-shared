import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  );
}

export const workflowLogger = createDiagnosticLogger("agent-assist.workflow");
export const suggestionsLogger = createDiagnosticLogger("agent-assist.suggestions");
export const translationLogger = createDiagnosticLogger("agent-assist.translation");
export const handoffLogger = createDiagnosticLogger("agent-assist.handoff");
export const llmLogger = createDiagnosticLogger("agent-assist.llm");

export function agentAssistErrorPayload(error) {
  if (!error) return {};
  return compactObject({
    errorName: error.name || "Error",
    errorMessage: error.message || String(error),
    errorCode: error.code,
    errorStatus: error.status || error.statusCode,
  });
}

export function agentAssistRuntimePayload({
  error,
  sessionId,
  interactionId,
  workflowId,
  itemId,
  slotName,
  language,
  provider,
  reason,
  status,
  statusCode,
  agentId,
  username,
  stageId,
  conversationId,
  responseSize,
  ...rest
} = {}) {
  return compactObject({
    ...agentAssistErrorPayload(error),
    sessionId: sessionId ? String(sessionId) : undefined,
    interactionId: interactionId ? String(interactionId) : undefined,
    workflowId: workflowId ? String(workflowId) : undefined,
    itemId: itemId ? String(itemId) : undefined,
    slotName,
    language,
    provider,
    reason,
    status,
    statusCode,
    agentId: agentId ? String(agentId) : undefined,
    username,
    stageId: stageId ? String(stageId) : undefined,
    conversationId: conversationId ? String(conversationId) : undefined,
    responseSize,
    ...compactObject(rest),
  });
}
