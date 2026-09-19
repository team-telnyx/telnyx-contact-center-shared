/**
 * Slot value display helpers for the agent-assist workflow checklist.
 *
 * Boolean slots (#1118) capture `false` for a "No" answer (e.g. air-safety
 * questions: "any other aircraft responding?" -> false). Rendering with a
 * truthiness check would collapse a captured `false`/`0` to an empty
 * "Enter value", making a completed item look uncollected. These helpers treat
 * false/0 as present and render booleans as Yes/No.
 *
 * Phone slots (an earlier fix) render with a 3-3-4 mask: 5551234567 -> 555-123-4567.
 * The mask is derived at render time from the raw captured value and is never
 * written back, so the digits that reach the database, the dispatch system
 * dispatch payload (an earlier fix) and pre-dispatch validation (an earlier fix) are exactly
 * what the analyzer captured. Nothing outside a JSX render should call the
 * phone formatter.
 */

/** A captured value is present when it exists and isn't an empty string. */
export function hasSlotValue(value) {
  return value !== null && value !== undefined && value !== "";
}

/** First present value among the candidates (NOT `a || b || c`, which drops false/0). */
export function pickSlotValue(...candidates) {
  for (const v of candidates) {
    if (hasSlotValue(v)) return v;
  }
  return null;
}

/** Only digits and the punctuation a phone number is written with. */
const PHONE_SHAPED = /^[\d\s().+-]+$/;

/** 3-3-4 over however many digits we have so far: 555 -> 555, 5551 -> 555-1. */
function maskNationalDigits(digits) {
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Split a NANP country code off the front, or return null when the value isn't
 * ours to mask (an explicit +<country> that isn't +1).
 */
function splitNanpPrefix(raw, digits) {
  if (raw.startsWith("+")) {
    if (!digits.startsWith("1")) return null;
    return { prefix: "+1 ", national: digits.slice(1) };
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return { prefix: "1-", national: digits.slice(1) };
  }
  return { prefix: "", national: digits };
}

/**
 * Display-only 3-3-4 mask for phone slots.
 *
 * Masks partial input as digits stream in from the analyzer, so a value being
 * collected reads as 555 -> 555-1 -> 555-123-4 rather than jumping into shape
 * only once it hits ten digits. Anything that can't be masked confidently —
 * extensions ("555-1234 x22"), non-NANP international, more digits than the
 * plan holds — is returned exactly as captured instead of mis-masked.
 *
 * Display only: never call this on a value headed for the database or an API
 * payload.
 */
export function formatPhoneSlotDisplay(value) {
  if (typeof value !== "string" && typeof value !== "number") return value;

  const raw = String(value).trim();
  // Letters mean an extension or free text — leave the agent's own words alone.
  if (!raw || !PHONE_SHAPED.test(raw)) return value;

  const digits = raw.replace(/\D/g, "");
  const parts = splitNanpPrefix(raw, digits);
  if (!parts || !parts.national || parts.national.length > 10) return value;

  return `${parts.prefix}${maskNationalDigits(parts.national)}`;
}

/**
 * Human-facing display: booleans read as Yes/No, phone slots get the 3-3-4
 * mask, everything else renders as-is. `slotType` is the item's `slot_type`
 * column, so the mask follows the workflow definition rather than guessing
 * from a slot name ("room number", "bed number" are not phone numbers).
 */
export function formatSlotDisplay(value, slotType) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (slotType === "phone") return formatPhoneSlotDisplay(value);
  return value;
}
