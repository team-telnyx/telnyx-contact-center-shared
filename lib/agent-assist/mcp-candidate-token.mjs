const PREFIX = "__mcp_candidate__:";

/**
 * A small deterministic 64-bit digest for the generation fingerprint. The
 * fingerprint itself contains resolved tool arguments and must stay server-side;
 * this digest is only a stale-chip discriminator, not a security primitive.
 */
export function candidateGenerationId(generation) {
  const text = String(generation || "");
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Candidate chips carry identity, not the business value itself. The server
 * validates this token against the currently parked result generation before
 * accepting a selection, so duplicate/object values cannot collapse onto the
 * first candidate and a stale chip cannot select from a newer lookup.
 *
 * This is intentionally just an opaque transport token, not an authentication
 * token. Its contents are always checked against server-side session state.
 */
export function createMcpCandidateToken({ resultKey, generation, candidateIndex }) {
  const payload = {
    r: String(resultKey || ""),
    g: candidateGenerationId(generation),
    i: Number(candidateIndex),
  };
  return `${PREFIX}${encodeURIComponent(JSON.stringify(payload))}`;
}

export function parseMcpCandidateToken(value) {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value.slice(PREFIX.length)));
    const candidateIndex = Number(parsed?.i);
    const resultKey = String(parsed?.r || "");
    const generationId = String(parsed?.g || "");
    if (!resultKey || !/^[0-9a-f]{16}$/.test(generationId) || !Number.isInteger(candidateIndex) || candidateIndex < 0) return null;
    return { resultKey, generationId, candidateIndex };
  } catch {
    return null;
  }
}

export function isMcpCandidateToken(value) {
  return parseMcpCandidateToken(value) !== null;
}
