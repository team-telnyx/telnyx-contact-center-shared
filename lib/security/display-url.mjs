/**
 * Avatar and branding images are addressed by URLs that reach the widget from
 * its published configuration. The widget renders on third-party pages, so the
 * scheme is constrained here rather than trusted: only http(s) and inline image
 * data are allowed through, and anything else — `javascript:`, `data:text/html`,
 * `vbscript:`, a protocol-relative URL that would follow the embedding page's
 * scheme — resolves to null so the caller falls back to initials or an icon.
 *
 * Relative paths are kept: they resolve against the widget's own origin.
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * A URL to be navigated to or framed. Only http(s) survives: `javascript:` in
 * an iframe src executes in the embedding page, and a protocol-relative URL
 * silently adopts the current scheme. Returns null when the value cannot be
 * shown safely, so the caller can render nothing rather than something hostile.
 */
export function safeHttpUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("//")) return null;
  try {
    return ALLOWED_PROTOCOLS.has(new URL(trimmed).protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

export function safeImageUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Inline images only; data:text/html would render as a document.
  if (/^data:/i.test(trimmed)) {
    return /^data:image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml);/i.test(trimmed) ? trimmed : null;
  }

  // "//host/path" adopts the embedding page's scheme — treat it as absolute.
  if (trimmed.startsWith("//")) return null;

  // A relative path has no scheme of its own and stays on the widget's origin.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;

  try {
    return ALLOWED_PROTOCOLS.has(new URL(trimmed).protocol) ? trimmed : null;
  } catch {
    return null;
  }
}
