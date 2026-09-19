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

/**
 * Recursively replaces every primitive VALUE with its JS type, keeping key
 * names and array/object nesting intact. Lets a diagnostic log reveal a
 * third-party response's field structure (e.g. where an ETA field lives)
 * without ever emitting the actual data - safe even for a response that may
 * echo back patient/trip details, which agentAssistRuntimePayload's own
 * redaction (object-key inspection only) can't protect once a payload has
 * been serialized into a single string value. Depth-capped as a guard
 * against a pathological/cyclic-looking payload rather than any real
 * expected shape.
 */
export function describeShape(value, depth = 0) {
  if (depth > 6) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length ? [describeShape(value[0], depth + 1)] : [];
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, describeShape(value[key], depth + 1)]),
    );
  }
  return typeof value;
}
