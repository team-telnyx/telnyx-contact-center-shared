export function videoStartErrorMessage(error, { media, generic }) {
  if (error?.status && error.message) return error.message;
  if (["NotAllowedError", "PermissionDeniedError", "NotFoundError", "NotReadableError", "OverconstrainedError"].includes(error?.name)) return media;
  return generic;
}
