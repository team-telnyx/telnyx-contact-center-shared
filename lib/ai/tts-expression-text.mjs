const EMOTION_TAG_PATTERN = /<\s*\/?\s*emotion\b[^>]*>/gi;

export function stripTtsExpressionTags(value) {
  return String(value ?? "")
    .replace(EMOTION_TAG_PATTERN, "")
    .trim();
}
