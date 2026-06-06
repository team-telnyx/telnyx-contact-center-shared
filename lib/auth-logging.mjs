import {
  createDiagnosticLogger,
  sanitizeDiagnosticPayload,
} from "./diagnostic-logger.mjs";

const logger = createDiagnosticLogger("auth");

export const REDACTED = "[REDACTED]";

export function normalizeAuthEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function authUserPayload(user, fallbackEmail = "") {
  if (!user) return { email: normalizeAuthEmail(fallbackEmail) || undefined };
  return {
    userId: String(user.id || user._id || "") || undefined,
    email: normalizeAuthEmail(user.username || user.email || fallbackEmail) || undefined,
    authStrategy: user.auth_strategy || user.authStrategy || undefined,
    verified: typeof user.verified === "boolean" ? user.verified : undefined,
    roles: Array.isArray(user.roles) ? user.roles : undefined,
  };
}

export function authErrorPayload(error) {
  return sanitizeDiagnosticPayload({
    error: error instanceof Error ? error : new Error(String(error || "Unknown error")),
  });
}

export function safeAuthPayload(payload = {}) {
  const safe = sanitizeDiagnosticPayload(payload);
  return {
    ...safe,
    credential: safe.credential ? REDACTED : safe.credential,
    credentialValue: safe.credentialValue ? REDACTED : safe.credentialValue,
  };
}

export function logAuthEvent(level, eventName, payload = {}) {
  const method = typeof logger[level] === "function" ? level : "info";
  logger[method](eventName, safeAuthPayload(payload));
}
