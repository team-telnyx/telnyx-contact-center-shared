import { widgetTestOrigin } from "../widgets/config.js";

export function requestOrigin(request) {
  const supplied = request.headers.get("origin");
  if (!supplied) return new URL(request.url).origin;
  try {
    const parsed = new URL(supplied);
    return parsed.origin === supplied && ["https:", "http:"].includes(parsed.protocol) ? supplied : null;
  } catch { return null; }
}

export function matchStoredOrigin(stored, browserOrigin) {
  if (!browserOrigin) return null;
  return stored === browserOrigin || stored === widgetTestOrigin(browserOrigin) ? stored : null;
}

export function corsHeaders(origin, methods = "GET, POST, OPTIONS") {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

export function noStoreHeaders() { return { "Cache-Control": "no-store" }; }
