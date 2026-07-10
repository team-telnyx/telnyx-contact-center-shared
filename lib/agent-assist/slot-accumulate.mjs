/**
 * Free-text "notes" slots (trip notes, comments, additional details) collect a
 * multi-sentence answer that can span several STT utterances. The per-utterance
 * analyzer would otherwise OVERWRITE the slot with the latest fragment, losing
 * everything said before — e.g. a safety warning ("mentally disordered, may
 * attack people, very violent") reduced to just "be cautious about that". These
 * helpers let such slots ACCUMULATE instead of overwrite.
 */

const NOTES_SLOT_PATTERN = /(notes?|comments?|details?|remarks?|instructions?|additional|narrative|freeform|free_text)/i;

/**
 * Is this a free-text slot whose value should accumulate across utterances
 * rather than be overwritten? Restricted to text slots whose name/label reads
 * like a notes / comments / details field.
 */
export function isAccumulatingSlot(item = {}) {
  const slotType = item.slot_type || "text";
  if (slotType !== "text") return false;
  const hay = `${item.slot_name || ""} ${item.label || ""}`;
  return NOTES_SLOT_PATTERN.test(hay);
}

/**
 * Merge a newly-extracted fragment into a notes slot's existing value. Appends
 * with "; " unless the incoming text is empty, already contained (case-
 * insensitive) in the existing value, or a superset of it — so repeated STT of
 * the same phrase does not duplicate.
 */
export function accumulateSlotValue(existing, incoming) {
  const inc = String(incoming ?? "").trim();
  if (!inc) return existing ?? "";
  const prev = String(existing ?? "").trim();
  if (!prev) return inc;
  const prevLower = prev.toLowerCase();
  const incLower = inc.toLowerCase();
  if (prevLower.includes(incLower)) return prev; // already captured
  if (incLower.includes(prevLower)) return inc; // incoming supersedes
  return `${prev}; ${inc}`;
}
