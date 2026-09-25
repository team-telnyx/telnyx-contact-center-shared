// Provider credentials belong to the server. Their rejection must not rotate
// the mobile user's single-use refresh token or be mistaken for an RBAC denial.
export function providerResponseStatus(status) {
  return status === 401 || status === 403 ? 502 : status;
}
