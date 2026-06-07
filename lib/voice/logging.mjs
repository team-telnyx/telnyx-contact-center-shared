import { createDiagnosticLogger } from "../diagnostic-logger.mjs";

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  );
}

export const voiceWebhookLogger = createDiagnosticLogger("voice.webhooks");
export const voiceFlowLogger = createDiagnosticLogger("voice.flow");
export const callControlLogger = createDiagnosticLogger("voice.call-control");
export const recordingsLogger = createDiagnosticLogger("voice.recordings");
export const voiceMonitorLogger = createDiagnosticLogger("voice.monitor");
export const streamingLogger = createDiagnosticLogger("telnyx.streaming");
export const sttLogger = createDiagnosticLogger("telnyx.stt");
export const mediaLogger = createDiagnosticLogger("telnyx.media");
export const providerApiLogger = createDiagnosticLogger("telnyx.provider-api");

export function voiceErrorPayload(error) {
  if (!error) return {};
  return compactObject({
    errorName: error.name || "Error",
    errorMessage: error.message || String(error),
    errorCode: error.code,
    errorStatus: error.status || error.statusCode,
  });
}

export function voiceRuntimePayload({
  error,
  eventType,
  callControlId,
  callSessionId,
  flowId,
  nodeId,
  reason,
  provider,
  model,
  status,
  statusCode,
  conversationId,
  recordingId,
  mediaCount,
  audioSent,
  audioReceived,
  elapsedMs,
  ...rest
} = {}) {
  return compactObject({
    ...voiceErrorPayload(error),
    eventType,
    callControlId: callControlId ? String(callControlId) : undefined,
    callSessionId: callSessionId ? String(callSessionId) : undefined,
    flowId: flowId ? String(flowId) : undefined,
    nodeId: nodeId ? String(nodeId) : undefined,
    reason,
    provider,
    model,
    status,
    statusCode,
    conversationId: conversationId ? String(conversationId) : undefined,
    recordingId: recordingId ? String(recordingId) : undefined,
    mediaCount,
    audioSent,
    audioReceived,
    elapsedMs,
    ...compactObject(rest),
  });
}
