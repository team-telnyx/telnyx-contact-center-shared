export function telnyxCallControlId(call) {
  const value = call?.telnyxIDs?.telnyxCallControlId
    || call?.options?.telnyxCallControlId
    || call?.telnyxCallControlId;
  return String(value || "").trim() || null;
}
