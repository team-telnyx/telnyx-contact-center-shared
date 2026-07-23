export function normalizeEmailFromValue(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length < 2) return trimmed;

  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  if (quote === '"') {
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return inner.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}
