const XML_EXPRESSION_NAMES = [
  "emotion",
  "break",
  "whisper",
  "soft",
  "loud",
  "emphasis",
  "slow",
  "fast",
  "higher-pitch",
  "lower-pitch",
];

const BRACKET_EXPRESSION_NAMES = [
  "pause",
  "long-pause",
  "laughter",
  "laugh",
  "chuckle",
  "giggle",
  "sigh",
  "breath",
  "inhale",
  "exhale",
];

const EXPRESSION_PATTERN = new RegExp(
  `<\\s*(/?)\\s*(${XML_EXPRESSION_NAMES.join("|")})\\b([^<>]*)>|\\[(${BRACKET_EXPRESSION_NAMES.join(
    "|"
  )})\\]`,
  "gi"
);

function attributeValue(attributes, name) {
  const match = String(attributes || "").match(
    new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i")
  );
  return match?.[2]?.trim() || "";
}

function expressionLabel(name, attributes) {
  if (name === "emotion") {
    return attributeValue(attributes, "value") || "emotion";
  }
  if (name === "break") {
    const duration = attributeValue(attributes, "time");
    return duration ? `${duration} pause` : "pause";
  }
  return name.replaceAll("-", " ");
}

export function parseTtsExpressionText(value) {
  const text = String(value ?? "");
  const parts = [];
  let cursor = 0;

  EXPRESSION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(EXPRESSION_PATTERN)) {
    if (match.index > cursor) {
      parts.push({ type: "text", value: text.slice(cursor, match.index) });
    }

    const closing = Boolean(match[1]);
    const xmlName = match[2]?.toLowerCase();
    const bracketName = match[4]?.toLowerCase();
    const name = xmlName || bracketName;

    // Closing XML tags affect synthesis scope but do not need a second badge.
    if (!closing) {
      parts.push({
        type: "expression",
        kind: name,
        label: expressionLabel(name, match[3]),
        raw: match[0],
      });
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    parts.push({ type: "text", value: text.slice(cursor) });
  }
  return parts;
}

export function stripTtsExpressionTags(value) {
  return parseTtsExpressionText(value)
    .filter((part) => part.type === "text")
    .map((part) => part.value)
    .join("")
    .trim();
}
