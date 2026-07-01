/**
 * Helpers for jumping from a workflow slot value to the matching transcript
 * utterance in the live transcription panel.
 *
 * Pure module (no React) so it can be unit-tested directly with node --test.
 */

/**
 * Normalize a string for substring matching.
 * Collapses all runs of whitespace to a single space, trims, and lowercases.
 *
 * @param {string|undefined|null} str
 * @returns {string}
 */
export function normalizeForMatch(str) {
  return String(str ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Find the transcription `id` whose transcript text best matches the provided
 * source utterance.
 *
 * Rules:
 *  - If `sourceUtterance` is empty/null or `transcriptions` is not a non-empty
 *    array, returns `null`.
 *  - Normalizes the utterance and each `transcription.transcript`.
 *  - Candidate matches are those whose normalized transcript **contains** the
 *    normalized utterance (substring match).
 *  - Prefers `isFinal === true` transcriptions over interim ones.
 *  - Among matches, prefers the most recent (last in the array).
 *
 * @param {Array<{id: string, transcript?: string, isFinal?: boolean}>} transcriptions
 * @param {string|undefined|null} sourceUtterance
 * @returns {string|null}
 */
export function findTranscriptIdForUtterance(transcriptions, sourceUtterance) {
  const normalizedUtterance = normalizeForMatch(sourceUtterance);
  if (!normalizedUtterance) return null;
  if (!Array.isArray(transcriptions) || transcriptions.length === 0) {
    return null;
  }

  let bestId = null;
  let bestIsFinal = false;

  for (const t of transcriptions) {
    if (!t || t.id === undefined || t.id === null) continue;
    const normalizedTranscript = normalizeForMatch(t.transcript);
    if (!normalizedTranscript) continue;
    if (!normalizedTranscript.includes(normalizedUtterance)) continue;

    const isFinal = t.isFinal === true;

    // Prefer final over interim; among same finality, the last one wins (most
    // recent). We iterate in order, so a later match with equal-or-better
    // finality replaces the previous best.
    if (bestId === null) {
      bestId = t.id;
      bestIsFinal = isFinal;
    } else if (isFinal && !bestIsFinal) {
      bestId = t.id;
      bestIsFinal = true;
    } else if (isFinal === bestIsFinal) {
      bestId = t.id;
      bestIsFinal = isFinal;
    }
  }

  return bestId;
}
