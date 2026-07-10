/**
 * Slot value display helpers for the agent-assist workflow checklist.
 *
 * Boolean slots (#1118) capture `false` for a "No" answer (e.g. air-safety
 * questions: "any other aircraft responding?" -> false). Rendering with a
 * truthiness check would collapse a captured `false`/`0` to an empty
 * "Enter value", making a completed item look uncollected. These helpers treat
 * false/0 as present and render booleans as Yes/No.
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

/** Human-facing display: booleans read as Yes/No, everything else as-is. */
export function formatSlotDisplay(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return value;
}
