// Centralized Telnyx API base and URL builders

function normalizeBase(base) {
  if (!base) return "https://api.telnyx.com";
  try {
    const u = new URL(base);
    // Drop trailing slash for consistent join
    return u.origin + u.pathname.replace(/\/$/, "");
  } catch {
    // If invalid URL in env, fall back to default
    return "https://api.telnyx.com";
  }
}

export function getTelnyxBasePath() {
  // Prefer explicit TELNYX_BASE_PATH, else default to public endpoint
  const fromEnv = process.env.TELNYX_BASE_PATH;
  return normalizeBase(fromEnv);
}

export function buildTelnyxUrl(path = "") {
  const base = getTelnyxBasePath();
  const joined = String(path || "");
  if (!joined) return base;
  if (joined.startsWith("http://") || joined.startsWith("https://"))
    return joined;
  const needsSlash = !base.endsWith("/") && !joined.startsWith("/");
  return `${base}${needsSlash ? "/" : ""}${joined}`;
}

export function buildTelnyxV2Url(path = "") {
  const baseV2 = buildTelnyxUrl("/v2");
  const suffix = String(path || "");
  if (!suffix) return baseV2;
  const needsSlash = !baseV2.endsWith("/") && !suffix.startsWith("/");
  return `${baseV2}${needsSlash ? "/" : ""}${suffix}`;
}
