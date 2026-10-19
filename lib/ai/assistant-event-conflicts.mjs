export const ASSISTANT_EVENT_DESTINATION_CONFLICT = "ASSISTANT_EVENT_DESTINATION_CONFLICT";

export function flowAssistantErrorPayload(error, fallback) {
  return {
    ok: false,
    error: error.message || fallback,
    ...(error.code === ASSISTANT_EVENT_DESTINATION_CONFLICT
      ? { code: error.code, conflicts: error.conflicts }
      : {}),
  };
}
