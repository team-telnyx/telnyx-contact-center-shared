export function normalizeLanguageCode(language, { fallback = null, preserveAuto = true } = {}) {
  const value = String(language || "").trim();
  if (!value) return fallback;

  const lower = value.replace(/_/g, "-").toLowerCase();
  if (preserveAuto && (lower === "auto" || lower === "multi" || lower === "auto-detect")) {
    return lower === "auto-detect" ? "auto_detect" : lower;
  }
  if (!preserveAuto && (lower === "auto" || lower === "multi" || lower === "auto-detect" || lower === "auto_detect")) {
    return fallback;
  }

  const base = lower.split("-")[0];
  return base || fallback;
}

export function normalizeSttLanguageCode(language, { supportedCodes = [], fallback = "en" } = {}) {
  const normalizedSupported = (supportedCodes || []).map((code) => String(code || "").trim()).filter(Boolean);
  const value = String(language || "").trim();
  if (!value) return fallback;

  if (normalizedSupported.includes(value)) return value;

  const lower = value.replace(/_/g, "-").toLowerCase();
  if (normalizedSupported.includes(lower)) return lower;

  const base = normalizeLanguageCode(lower, { fallback: null });
  if (base && normalizedSupported.includes(base)) return base;

  return fallback;
}
