const SECRET_KEY_RE = /(authorization|api[_-]?key|apikey|token|secret|password|passwd|client[_-]?state|ai[_-]?config)/i;
const PAYLOAD_KEY_RE = /(payload|audio|media[_-]?payload|chunk|buffer|raw[_-]?frame|raw[_-]?body)/i;
const URL_KEY_RE = /(^|[_-])(url|uri|href)$|callback[_-]?url|stream[_-]?url|websocket[_-]?url|request[_-]?url/i;
const MAX_DEPTH = 20;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;

function redactQueryPair(_match, prefix) {
  const key = prefix.replace(/^[?&]/, "").replace(/=$/, "");
  return `${prefix}${SECRET_KEY_RE.test(key) ? "[REDACTED]" : "[REDACTED_PARAM]"}`;
}

export function sanitizeDiagnosticUrl(value) {
  if (!value) return value;
  const raw = String(value);
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const base = hasScheme ? undefined : "http://local.invalid";
    const parsed = new URL(raw, base);
    parsed.username = "";
    parsed.password = "";
    for (const key of parsed.searchParams.keys()) {
      parsed.searchParams.set(key, SECRET_KEY_RE.test(key) ? "[REDACTED]" : "[REDACTED_PARAM]");
    }
    if (parsed.hash) parsed.hash = "[REDACTED_FRAGMENT]";
    if (base) {
      const path = raw.startsWith("/") ? parsed.pathname : parsed.pathname.replace(/^\//, "");
      return `${path}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch {
    return raw
      .replace(/([?&][^=]+)=([^&\s#]+)/g, redactQueryPair)
      .replace(/#.*/, "#[REDACTED_FRAGMENT]");
  }
}

function summarizeRedacted(value) {
  if (Buffer.isBuffer(value)) return `[redacted:buffer:${value.length}]`;
  if (typeof value === "string") return `[redacted:string:${value.length}]`;
  if (Array.isArray(value)) return `[redacted:array:${value.length}]`;
  if (value && typeof value === "object") return "[redacted:object]";
  return "[REDACTED]";
}

function sanitizeString(value) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (/[?&][^=]+=/.test(compact) || /^[a-z][a-z0-9+.-]*:\/\//i.test(compact) || /^\/[^\s#]*#/.test(compact)) {
    return sanitizeDiagnosticUrl(compact);
  }
  if (/^(bearer\s+)?[A-Za-z0-9_-]{24,}\.?[A-Za-z0-9._-]*$/i.test(compact)) {
    return `[redacted:string:${value.length}]`;
  }
  if (compact.length > 2000) return `${compact.slice(0, 2000)}…[truncated:${compact.length}]`;
  return value;
}

export function sanitizeLogPayload(value, seen = new WeakSet(), key = "", depth = 0) {
  if (depth > MAX_DEPTH) return "[MaxDepth]";
  if (Buffer.isBuffer(value)) return summarizeRedacted(value);
  if (value == null) return value;
  if (SECRET_KEY_RE.test(key) || PAYLOAD_KEY_RE.test(key)) return summarizeRedacted(value);
  if (typeof value === "string" && URL_KEY_RE.test(key)) return sanitizeDiagnosticUrl(value);
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message || ""),
      code: value.code,
      stack: value.stack ? sanitizeString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeLogPayload(item, seen, key, depth + 1));
  }

  const output = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    output[childKey] = sanitizeLogPayload(childValue, seen, childKey, depth + 1);
  }
  return output;
}
