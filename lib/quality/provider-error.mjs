// Telnyx errors use an errors[] envelope. Never log prompts, transcripts or keys.
export function qualityProviderError(body, status, operation, secret = "") {
  const detail = (Array.isArray(body?.errors) ? body.errors : [])
    .map(item => item?.detail || item?.title).filter(item => typeof item === "string").join("; ")
    || (typeof body?.detail === "string" ? body.detail : "")
    || (typeof body?.message === "string" ? body.message : "")
    || (typeof body?.error?.message === "string" ? body.error.message : "")
    || `Provider returned HTTP ${status}`;
  const safeDetail = (secret ? detail.replaceAll(secret, "[redacted]") : detail).slice(0, 800);
  const hint = /customer-provided API key/i.test(detail)
    ? " Choose the scorecard default or a Telnyx-hosted inference model." : "";
  const error = new Error(`${operation}: ${safeDetail}${hint}`);
  error.status = status === 400 || status === 422 ? 422 : status === 429 ? 503 : 502;
  error.providerStatus = status;
  return error;
}
