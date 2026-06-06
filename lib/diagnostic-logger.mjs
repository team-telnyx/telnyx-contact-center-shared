import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_KEY_RE = /(authorization|api[_-]?key|apikey|token|secret|password|passwd|bearer)/i;
const MEDIA_KEY_RE = /^(payload|audio|media_payload|audio_payload)$/i;
const SENSITIVE_QUERY_KEY_RE = /(authorization|api[_-]?key|apikey|token|secret|password|passwd|bearer|client[_-]?state|ai[_-]?config)/i;

export function sanitizeDiagnosticUrl(value) {
  if (!value) return value;
  try {
    const url = new URL(String(value), "http://diagnostic.local");
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, SENSITIVE_QUERY_KEY_RE.test(key) ? "[REDACTED]" : "[REDACTED_PARAM]");
    }
    const serialized = url.toString();
    if (String(value).startsWith("/")) return `${url.pathname}${url.search}`;
    return serialized.replace("http://diagnostic.local", "");
  } catch {
    return String(value).replace(/([?&][^=]*(?:secret|token|api[_-]?key|client[_-]?state|ai[_-]?config)[^=]*=)[^&\s]+/gi, "$1[REDACTED]");
  }
}

function currentLevel() {
  const level = String(process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVELS[level] || LEVELS.info;
}

function isEnabled(level) {
  return (LEVELS[level] || LEVELS.info) >= currentLevel();
}

function redactValue(value) {
  if (Buffer.isBuffer(value)) return `[redacted:buffer:${value.length}]`;
  if (typeof value === "string") return `[redacted:string:${value.length}]`;
  if (value == null) return value;
  return `[redacted:${typeof value}]`;
}

export function sanitizeDiagnosticPayload(value, depth = 0, key = "") {
  if (depth > 6) return "[MaxDepth]";
  if (SECRET_KEY_RE.test(key) || MEDIA_KEY_RE.test(key)) return redactValue(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Buffer.isBuffer(value)) return `[Buffer:${value.length}]`;
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    if (/[?&][^=]+=/.test(compact)) {
      return sanitizeDiagnosticUrl(compact);
    }
    if (/^(bearer\s+)?[A-Za-z0-9_-]{24,}\.?[A-Za-z0-9._-]*$/i.test(compact)) {
      return `[redacted:string:${compact.length}]`;
    }
    return compact.length > 500 ? `${compact.slice(0, 500)}…[${compact.length}]` : compact;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeDiagnosticPayload(item, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, 50)) {
      result[entryKey] = sanitizeDiagnosticPayload(entryValue, depth + 1, entryKey);
    }
    return result;
  }
  return `[${typeof value}]`;
}

function writeFileLine(filePath, line) {
  if (!filePath) return;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${line}\n`, "utf8");
  } catch (err) {
    // Never let logging break call handling. Emit a minimal stderr hint only.
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      scope: "diagnostic-logger",
      message: "file_sink_failed",
      error: err?.message || String(err),
    }));
  }
}

export function createDiagnosticLogger(scope, options = {}) {
  const stdout = options.stdout || ((line) => console.log(line));
  const now = options.now || (() => new Date());

  function emit(level, message, payload = {}) {
    if (!isEnabled(level)) return;
    const sanitizedPayload = sanitizeDiagnosticPayload(payload);
    const entry = {
      ...sanitizedPayload,
      ts: now().toISOString(),
      level,
      scope,
      message,
    };
    const line = JSON.stringify(entry);
    stdout(line);
    writeFileLine(process.env.LOG_FILE_PATH, line);
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
