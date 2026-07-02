export function isPlainJsonObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCustomDataValue(value, { allowUndefined = false } = {}) {
  if (value === undefined) {
    if (allowUndefined) return undefined;
    return {};
  }
  if (value === null || value === "") return {};

  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!isPlainJsonObject(parsed)) {
    throw new Error("Custom data must be a valid JSON object");
  }
  return parsed;
}

export function parseCustomDataText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  return normalizeCustomDataValue(trimmed);
}

export function formatCustomDataText(value) {
  if (!isPlainJsonObject(value)) return "{}";
  return JSON.stringify(value, null, 2);
}
