import { createDiagnosticLogger, sanitizeDiagnosticPayload } from "./diagnostic-logger.mjs";

function compactObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  );
}

export function telnyxErrorPayload(error) {
  if (!error) return {};
  const sanitized = sanitizeDiagnosticPayload({
    errorName: error.name || "Error",
    errorMessage: error.message || String(error),
    errorCode: error.code,
    errorStatus: error.status || error.statusCode,
  });
  return compactObject(sanitized);
}

export function telnyxRequestPayload({ path, method, attempt, retries, status, reason } = {}) {
  return compactObject({
    path,
    method,
    attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : undefined,
    retries: Number.isFinite(Number(retries)) ? Number(retries) : undefined,
    status: Number.isFinite(Number(status)) ? Number(status) : undefined,
    reason,
  });
}

export function telnyxResourcePayload({ workflowId, workflowName, groupId, insightId, appId, flowId, eventId, interactionId, sessionId } = {}) {
  return compactObject({
    workflowId: workflowId ? String(workflowId) : undefined,
    workflowName: workflowName || undefined,
    groupId: groupId ? String(groupId) : undefined,
    insightId: insightId ? String(insightId) : undefined,
    appId: appId ? String(appId) : undefined,
    flowId: flowId ? String(flowId) : undefined,
    eventId: eventId ? String(eventId) : undefined,
    interactionId: interactionId ? String(interactionId) : undefined,
    sessionId: sessionId ? String(sessionId) : undefined,
  });
}

export const providerApiLogger = createDiagnosticLogger("telnyx.provider-api");
export const telnyxVoiceAppsLogger = createDiagnosticLogger("telnyx.provider-api");
export const telnyxWebhookLogger = createDiagnosticLogger("telnyx.webhooks");
