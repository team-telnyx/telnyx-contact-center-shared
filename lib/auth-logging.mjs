import {
  createDiagnosticLogger,
  sanitizeDiagnosticPayload,
} from "./diagnostic-logger.mjs";
import {
  getCachedRuntimeLoggingConfig,
  tryLoadRuntimeLoggingConfigEarly,
} from "./logger/runtime-config.mjs";

const logger = createDiagnosticLogger("security.auth");
const RUNTIME_CONFIG_BOOTSTRAP_RETRY_MS = 5000;

let runtimeConfigLoadPromise = null;
let runtimeConfigLoadRetryAfterMs = 0;

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

function emitAuthEvent(level, eventName, payload = {}) {
  const method = typeof logger[level] === "function" ? level : "info";
  logger[method](eventName, safeAuthPayload(payload));
}

export function ensureRuntimeLoggingConfig({ now = Date.now() } = {}) {
  if (getCachedRuntimeLoggingConfig()) return Promise.resolve();
  if (now < runtimeConfigLoadRetryAfterMs) return Promise.resolve();
  if (!runtimeConfigLoadPromise) {
    runtimeConfigLoadPromise = tryLoadRuntimeLoggingConfigEarly()
      .then((config) => {
        runtimeConfigLoadRetryAfterMs = config ? 0 : Date.now() + RUNTIME_CONFIG_BOOTSTRAP_RETRY_MS;
        return config;
      })
      .catch(() => {
        runtimeConfigLoadRetryAfterMs = Date.now() + RUNTIME_CONFIG_BOOTSTRAP_RETRY_MS;
        return null;
      })
      .finally(() => {
        runtimeConfigLoadPromise = null;
      });
  }
  return runtimeConfigLoadPromise;
}

export function logAuthEvent(level, eventName, payload = {}) {
  if (getCachedRuntimeLoggingConfig()) {
    emitAuthEvent(level, eventName, payload);
    return Promise.resolve();
  }

  return ensureRuntimeLoggingConfig().then(() => {
    emitAuthEvent(level, eventName, payload);
  });
}
