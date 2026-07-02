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
