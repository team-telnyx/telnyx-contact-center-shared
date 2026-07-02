import { createDiagnosticLogger, sanitizeDiagnosticPayload } from "./diagnostic-logger.mjs";

function compactObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  );
}

export function securityErrorPayload(error) {
  if (!error) return {};
  return compactObject(sanitizeDiagnosticPayload({
    errorName: error.name || "Error",
    errorMessage: error.message || String(error),
    errorCode: error.code,
    errorStatus: error.status || error.statusCode,
  }));
}

export function securityUserPayload(user, fallbackEmail = "") {
  if (!user && !fallbackEmail) return {};
  return compactObject({
    userId: user?.id || user?._id ? String(user.id || user._id) : undefined,
    email: String(user?.username || user?.email || fallbackEmail || "").trim().toLowerCase() || undefined,
    authStrategy: user?.auth_strategy || user?.authStrategy || undefined,
  });
}

export function credentialPayload({ credentialId, credentialResolved, credentialSource, connectionConfigured, status } = {}) {
  return compactObject({
    credentialId: credentialId ? String(credentialId) : undefined,
    credentialResolved: typeof credentialResolved === "boolean" ? credentialResolved : undefined,
    credentialSource,
    connectionConfigured: typeof connectionConfigured === "boolean" ? connectionConfigured : undefined,
    status: Number.isFinite(Number(status)) ? Number(status) : undefined,
  });
}

export const authLogger = createDiagnosticLogger("security.auth");
export const sessionsLogger = createDiagnosticLogger("security.sessions");
export const credentialsLogger = createDiagnosticLogger("security.credentials");
export const adminSecurityLogger = createDiagnosticLogger("security.admin");
