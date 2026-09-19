// Browser-safe SMS encoding and segment calculator (GSM 03.38 / UCS-2).
// Used by the agent composer counter and by the server before a send is journaled.
// Mirrors the demo portal Send SMS counter: encoding, parts, characters per part, remaining.

const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENSION = "\f^{}\\[~]|€";
const BASIC = new Set(GSM_BASIC);
const EXTENSION = new Set(GSM_EXTENSION);

export const SMS_LIMITS = Object.freeze({
  "GSM-7": Object.freeze({ single: 160, multipart: 153 }),
  "UCS-2": Object.freeze({ single: 70, multipart: 67 }),
});
export const SMS_MAX_PARTS = 10;

export function isGsmText(text) {
  for (const char of String(text || "")) if (!BASIC.has(char) && !EXTENSION.has(char)) return false;
  return true;
}

// Septet cost of every character in GSM-7 order; extension characters cost two.
function gsmUnits(text) {
  const units = [];
  for (const char of text) units.push(EXTENSION.has(char) ? 2 : 1);
  return units;
}

// An escape sequence never straddles two parts: a two-septet character that does
// not fit in the current part moves whole to the next one.
function gsmParts(units, perPart) {
  let parts = 1, used = 0;
  for (const cost of units) {
    if (used + cost > perPart) { parts += 1; used = 0; }
    used += cost;
  }
  return { parts, usedInLast: used };
}

export function smsSegments(input) {
  const text = String(input ?? "");
  const gsm = isGsmText(text);
  const encoding = gsm ? "GSM-7" : "UCS-2";
  const limits = SMS_LIMITS[encoding];
  const chars = [...text].length;
  const units = gsm ? gsmUnits(text).reduce((sum, cost) => sum + cost, 0) : text.length; // UCS-2 counts UTF-16 code units
  if (!text) return { encoding, chars: 0, units: 0, parts: 0, perPart: limits.single, remaining: limits.single, tooLong: false };
  if (units <= limits.single) {
    return { encoding, chars, units, parts: 1, perPart: limits.single, remaining: limits.single - units, tooLong: false };
  }
  const perPart = limits.multipart;
  let parts, remaining;
  if (gsm) {
    const fill = gsmParts(gsmUnits(text), perPart);
    parts = fill.parts; remaining = perPart - fill.usedInLast;
  } else {
    parts = Math.ceil(units / perPart); remaining = parts * perPart - units;
  }
  return { encoding, chars, units, parts, perPart, remaining, tooLong: parts > SMS_MAX_PARTS };
}

export function describeSmsSegments(stats) {
  const s = stats || smsSegments("");
  return `${s.encoding} · ${s.parts} ${s.parts === 1 ? "part" : "parts"} · ${s.remaining} remaining`;
}
