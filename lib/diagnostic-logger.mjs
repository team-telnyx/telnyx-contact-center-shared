import {
  createLogger,
  sanitizeDiagnosticUrl,
  sanitizeLogPayload,
} from "./logger/index.mjs";
import { getCachedRuntimeLoggingConfig } from "./logger/runtime-config.mjs";

export { sanitizeDiagnosticUrl };

export function sanitizeDiagnosticPayload(value) {
  return sanitizeLogPayload(value);
}

export function createDiagnosticLogger(scope, options = {}) {
  const now = options.now || (() => new Date());
  const config = {
    globalLevel: process.env.LOG_LEVEL || "info",
    consoleEnabled: true,
    fileEnabled: envFlagEnabled("LOG_FILE_ENABLED") || Boolean(process.env.LOG_FILE_PATH),
    logDir: process.env.LOG_DIR || process.env.LOG_FILE_DIR || "/app/logs",
    logFilePath: process.env.LOG_FILE_PATH || "",
    rotationMode: process.env.LOG_ROTATION_MODE || "daily",
    redactionEnabled: true,
    ...(options.config || {}),
  };

  const logger = createLogger({
    topic: scope,
    config,
    stdout: options.stdout,
    now,
    runId: options.runId,
    getConfig: options.getConfig || getCachedRuntimeLoggingConfig,
  });

  function emit(level, message, payload = {}) {
    const { friendlyMessage, displayMessage, ...safePayload } = payload || {};
    logger[level]({
      ...safePayload,
      ts: now().toISOString(),
      scope,
      ...(friendlyMessage || displayMessage ? { friendlyMessage: friendlyMessage || displayMessage } : {}),
    }, message);
  }

  return {
    debug: (message, payload) => emit("debug", message, payload),
    info: (message, payload) => emit("info", message, payload),
    warn: (message, payload) => emit("warn", message, payload),
    error: (message, payload) => emit("error", message, payload),
  };
}

export function envFlagEnabled(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").toLowerCase());
}
