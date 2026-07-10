/**
 * De-duplication helpers for the live "Suggested Responses" (agent guide) panel.
 *
 * Background: suggestions are generated one-per-resolved-target and appended to a
 * running list. The generation guard historically remembered only the *single*
 * most recent target key, so when the resolved target oscillated back to a
 * previously-suggested one (A -> B -> A, common as transcripts stream and slots
 * fill/correct), the guard passed again and the same guide was appended twice.
 *
 * These helpers make the append idempotent by content, and back a set-based
 * "already generated" guard in the component. Pure module (no React) so it can
 * be unit-tested directly with `node --test`.
 */

/**
 * Normalize suggestion text for equality comparison: collapse all whitespace
 * runs to a single space, trim, and lowercase.
 *
 * @param {string|undefined|null} text
 * @returns {string}
 */
export function normalizeSuggestionText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Whether `candidate` duplicates a suggestion already in `list`.
 *
 * Two suggestions are considered duplicates when they target the same item
 * (`itemId`, when both have one) AND their normalized text is identical. Text
 * alone is used as the fallback when either side lacks an `itemId`, so identical
 * guidance never renders twice regardless of which target produced it.
 *
 * @param {Array<{itemId?: string, text?: string}>} list
 * @param {{itemId?: string, text?: string}|null|undefined} candidate
 * @returns {boolean}
 */
export function isDuplicateSuggestion(list, candidate) {
  if (!candidate) return false;
  if (!Array.isArray(list) || list.length === 0) return false;

  const candidateText = normalizeSuggestionText(candidate.text);
  if (!candidateText) return false;

  return list.some((existing) => {
    if (!existing) return false;
    if (normalizeSuggestionText(existing.text) !== candidateText) return false;
    // If both carry an itemId, they must match to count as a duplicate; this
    // still treats identical text with no itemId on either side as a duplicate.
    if (existing.itemId && candidate.itemId) {
      return existing.itemId === candidate.itemId;
    }
    return true;
  });
}

/**
 * Return `list` with `candidate` appended, unless `candidate` is empty or a
 * duplicate (per {@link isDuplicateSuggestion}), in which case the original
 * `list` reference is returned unchanged. Callers can use referential equality
 * (`result === list`) to detect that nothing was added.
 *
 * @template {{itemId?: string, text?: string}} T
 * @param {T[]} list
 * @param {T|null|undefined} candidate
 * @returns {T[]}
 */
export function appendUniqueSuggestion(list, candidate) {
  const base = Array.isArray(list) ? list : [];
  if (!candidate) return base;
  if (!normalizeSuggestionText(candidate.text)) return base;
  if (isDuplicateSuggestion(base, candidate)) return base;
  return [...base, candidate];
}

/**
 * Key a suggestion by its target item plus a NORMALIZED mode. All "ask the
 * customer for this / continue this item" modes (collect_missing_slot,
 * collect_prerequisite, lead_slot, continue_stage, continue_workflow) collapse
 * to "collect"; only confirm_slot is distinct ("confirm"). This keeps one
 * collect + one confirm entry per item (a slot can show both), while fixing the
 * duplicate opening greeting — the resolver reached it as "continue_workflow"
 * (fallback) AND "continue_stage" (conversation match), which used to produce
 * two keys and show the greeting twice.
 *
 * @param {{itemId?: string, targetMode?: string}|null|undefined} s
 * @returns {string}
 */
export function suggestionTargetKey(s) {
  const itemId = s?.itemId ?? "none";
  const mode = s?.targetMode === "confirm_slot" ? "confirm" : "collect";
  return `${itemId}:${mode}`;
}

/**
 * Add `candidate`, or REPLACE the existing suggestion for the same target
 * (item + mode) in place — so a low-confidence slot whose value is later refined
 * updates its guide instead of appending a second, stale-looking copy.
 *
 * Returns the original `list` reference when nothing changed (empty/blank
 * candidate, or identical text for the same target) so callers can detect no-ops
 * with `===`. Order is preserved: a replaced entry keeps its position.
 *
 * @template {{itemId?: string, targetMode?: string, text?: string}} T
 * @param {T[]} list
 * @param {T|null|undefined} candidate
 * @returns {T[]}
 */
export function upsertSuggestionByTarget(list, candidate) {
  const base = Array.isArray(list) ? list : [];
  if (!candidate) return base;
  if (!normalizeSuggestionText(candidate.text)) return base;

  const key = suggestionTargetKey(candidate);
  const idx = base.findIndex((s) => suggestionTargetKey(s) === key);
  if (idx === -1) return [...base, candidate];

  // Same target already present: replace in place only when the text actually
  // changed (a refined value), otherwise it is a no-op.
  if (normalizeSuggestionText(base[idx].text) === normalizeSuggestionText(candidate.text)) {
    return base;
  }
  const next = base.slice();
  next[idx] = candidate;
  return next;
}
