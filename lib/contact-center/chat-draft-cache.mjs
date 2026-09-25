/** Recover unsent text only inside the authenticated draft scope that wrote it. */
export function readScopedDraftCache(storage, key, scope = "legacy") {
  try {
    const cached = JSON.parse(storage.getItem(key) || "null");
    if (!cached) return null;
    if (typeof cached.body !== "string" || (cached.scope || "legacy") !== (scope || "legacy")) {
      storage.removeItem(key);
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}
