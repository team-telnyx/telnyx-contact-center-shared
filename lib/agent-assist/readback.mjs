/**
 * Agent Assist — final read-back helpers.
 *
 * At the confirmation step a workflow usually has a non-slot item like
 * "Confirm all information is correct" / "Read back transport details". The
 * generic suggestion generator is capped at two sentences and explicitly told
 * not to produce a summary, so it can never read back the collected slots. These
 * helpers build a deterministic read-back of every captured slot value that
 * bypasses that truncation, so the agent can confirm the whole intake at once.
 */

// Strong, finalization-specific phrases. Kept tight on purpose so mid-flow
// "summarize the issue" / "summarize their needs" items do NOT trigger a
// premature read-back — a bare "summarize" is intentionally not enough.
const READBACK_PATTERNS = [
  /read[\s-]?back/,
  /confirm all/,
  /all (?:the )?(?:information|details|info) (?:is|are) correct/,
  /everything (?:is|looks) (?:correct|right)/,
  /verify (?:the )?(?:details|information)/,
  /go over (?:the )?(?:details|information)/,
  /recap (?:the )?(?:details|information)/,
];

/**
 * Is this the finalization "read back / confirm all the collected info" item?
 * Slot items never qualify.
 */
export function isReadBackItem({ itemType, itemLabel, itemPromptHint, itemHints } = {}) {
  if (itemType === "slot") return false;
  const text = [itemLabel, itemPromptHint, ...(Array.isArray(itemHints) ? itemHints : [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text) return false;
  return READBACK_PATTERNS.some((re) => re.test(text));
}

/**
 * Given workflow items ALREADY in workflow order (stage, then item), return the
 * id of the earliest read-back-matching item, or null if none match. Lets the
 * caller ensure only the first read-back item recites the full list, so an
 * adjacent "confirm all information" follow-up doesn't repeat every slot.
 */
export function earliestReadBackItemId(orderedItems) {
  const match = (Array.isArray(orderedItems) ? orderedItems : []).find((it) =>
    isReadBackItem({
      itemType: it?.type,
      itemLabel: it?.label,
      itemPromptHint: it?.prompt_hint,
      itemHints: it?.hints,
    })
  );
  return match?.id ?? null;
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

/**
 * Format a captured value for a spoken read-back. Boolean slots (#1118) come
 * through as true/false — read those as "Yes"/"No" instead of "true"/"false".
 */
export function formatSlotValue(value) {
  if (value === true || value === "true") return "Yes";
  if (value === false || value === "false") return "No";
  return String(value).trim();
}

/** "patient_name" -> "Patient Name" */
export function humanizeSlotName(slotName) {
  return String(slotName || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Turn a { slot_name: value } map into an ordered [{ label, value }] list,
 * dropping empties. `labelBySlot` supplies human labels; missing ones fall back
 * to a humanized slot name. Preserves the map's own key order.
 */
export function orderedSlotsFromMap(prefilledSlots, labelBySlot = {}) {
  return Object.entries(prefilledSlots || {})
    .filter(([, value]) => hasValue(value))
    .map(([slotName, value]) => ({
      label: labelBySlot[slotName] || humanizeSlotName(slotName),
      value: formatSlotValue(value),
    }));
}

/**
 * Compose the spoken read-back line from an ordered [{ label, value }] list.
 * Returns null when there is nothing collected (so callers can fall back to the
 * normal single-line suggestion instead of reading back an empty intake).
 */
export function buildReadBackSuggestion({ orderedSlots } = {}) {
  const entries = (Array.isArray(orderedSlots) ? orderedSlots : []).filter(
    (s) => s && hasValue(s.value) && String(s.label || "").trim() !== ""
  );
  if (entries.length === 0) return null;

  const list = entries.map(({ label, value }) => `${label}: ${value}`).join(". ");
  return `Let me read back what I have to make sure everything is correct. ${list}. Is that all correct, or is there anything you'd like to change?`;
}
