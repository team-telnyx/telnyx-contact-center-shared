// Escape application copy as plain ICU text, preserving only our interpolation
// arguments. Quote a complete literal span so adjacent braces cannot become
// doubled-apostrophe escapes (e.g. {{customer_name}} must stay unchanged).
export function toIcuMessage(text) {
  return text.split(/(\{value\d+\})/g).map(part => {
    if (/^\{value\d+\}$/.test(part)) return part;
    const start = part.search(/[{}<]/);
    const apostrophes = value => value.replaceAll("'", "''");
    if (start < 0) return apostrophes(part);
    return apostrophes(part.slice(0, start)) + "'" + apostrophes(part.slice(start)) + "'";
  }).join('');
}

// These examples are executable/configuration syntax, not words to translate.
export function protectedTokens(text) {
  const pattern = /\{\{[^{}\n]+\}\}|\{(?!value\d+\})[A-Za-z_][\w.]*\}|https?:\/\/[^\s<>"'`]+|sips?:[^\s<>"'`]+|[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}/gu;
  return [...text.matchAll(pattern)].map(match => match[0].replace(/[.,;:)]+$/, '')).sort();
}

export function isCodeExample(text) {
  if (['IconMessageCircle', 'save_data'].includes(text)) return true;
  if (!/^[\[{]/.test(text.trim())) return false;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object';
  } catch { return false; }
}

// Some authoring models mirror the input {text, context} envelope despite the
// requested flat response. Accept its text only, and validate it normally.
export function translatedMessageText(value) {
  if (typeof value === 'string') return value;
  if (value && !Array.isArray(value) && typeof value.text === 'string') return value.text;
  return undefined;
}
