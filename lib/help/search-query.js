export const DEFAULT_HELP_SEARCH_LIMIT = 60;
export const MAX_HELP_SEARCH_LIMIT = 100;

export function parseHelpSearchLimit(searchParams) {
  if (!searchParams.has("limit")) return undefined;

  const requestedLimit = Number(searchParams.get("limit"));
  if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) return undefined;

  return Math.min(requestedLimit, MAX_HELP_SEARCH_LIMIT);
}

export function mergeHelpSearchResultSets(resultSets) {
  const merged = [];
  const seen = new Set();
  const longestSet = Math.max(0, ...resultSets.map((results) => results.length));

  for (let rank = 0; rank < longestSet; rank += 1) {
    for (const results of resultSets) {
      const result = results[rank];
      if (!result) continue;

      const key =
        result.id || `${result.type || "result"}:${result.url}:${result.content}`;
      if (seen.has(key)) continue;

      seen.add(key);
      merged.push(result);
    }
  }

  return merged;
}
