import { createDiagnosticLogger } from "./diagnostic-logger.mjs";

function compactObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  );
}

export function runtimeErrorPayload(error) {
  if (!error) return {};
  return compactObject({
    errorName: error.name || "Error",
    errorMessage: error.message || String(error),
    errorCode: error.code,
    errorStatus: error.status || error.statusCode,
  });
}

export function runtimePayload({ error, status, route, operation, resourceId, userId, count, reason } = {}) {
  return compactObject({
    ...runtimeErrorPayload(error),
    status: Number.isFinite(Number(status)) ? Number(status) : undefined,
    route,
    operation,
    resourceId: resourceId ? String(resourceId) : undefined,
    userId: userId ? String(userId) : undefined,
    count: Number.isFinite(Number(count)) ? Number(count) : undefined,
    reason,
  });
}

export const platformApiLogger = createDiagnosticLogger("platform.api");
export const platformDbLogger = createDiagnosticLogger("platform.db");
export const contactCenterRuntimeLogger = createDiagnosticLogger("contact-center.interactions");
export const voiceRuntimeLogger = createDiagnosticLogger("voice.flow");
export const adminRuntimeLogger = createDiagnosticLogger("security.admin");
