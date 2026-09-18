import { whatsappError } from "./policy.mjs";
export { whatsappError };

const CREDENTIAL_CACHE_MS = 5 * 60 * 1000;
let cachedCredentials = null;

export const whatsappId = (value) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_+.-]{1,180}$/.test(value)) throw whatsappError("Invalid Telnyx resource ID");
  return encodeURIComponent(value);
};
export function whatsappBaseUrl() {
  return String(process.env.TELNYX_BASE_PATH || "https://api.telnyx.com").replace(/\/+$/, "");
}

// Candidate API keys in precedence order. Customers normally run WhatsApp on
// the Contact Center account (TELNYX_API_KEY); TELNYX_API_KEY_WHATSAPP is the
// backup account that owns the WhatsApp Business Account when the primary does not.
export function whatsappCredentialCandidates(env = process.env) {
  return [
    { source: "primary", apiKey: env.TELNYX_WHATSAPP_API_KEY || env.TELNYX_MESSAGING_API_KEY || env.TELNYX_API_KEY || "" },
    { source: "backup", apiKey: env.TELNYX_API_KEY_WHATSAPP || "" },
  ].filter((candidate) => candidate.apiKey);
}

async function probeWabas(candidate, fetchImpl) {
  const response = await fetchImpl(`${whatsappBaseUrl()}/v2/whatsapp/business_accounts?page[size]=50&page[number]=1`, {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${candidate.apiKey}`, Accept: "application/json" },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const source = result.errors?.[0] || {};
    throw Object.assign(new Error(source.detail || source.title || `HTTP ${response.status}`), { status: response.status });
  }
  return Array.isArray(result.data) ? result.data : [];
}

// Resolve which account owns a WhatsApp Business Account. The first candidate
// with at least one WABA wins; the result is cached for five minutes.
export async function resolveWhatsAppCredentials({ fetchImpl = fetch, force = false, env = process.env } = {}) {
  if (!force && cachedCredentials && Date.now() - cachedCredentials.checkedAt < CREDENTIAL_CACHE_MS) return cachedCredentials;
  const candidates = whatsappCredentialCandidates(env);
  const checks = [];
  let resolved = null;
  for (const candidate of candidates) {
    try {
      const accounts = await probeWabas(candidate, fetchImpl);
      checks.push({ source: candidate.source, configured: true, wabaCount: accounts.length, error: null });
      if (accounts.length && !resolved) resolved = { source: candidate.source, apiKey: candidate.apiKey, accounts };
    } catch (error) {
      checks.push({ source: candidate.source, configured: true, wabaCount: 0, error: String(error.message).slice(0, 200) });
    }
  }
  for (const source of ["primary", "backup"]) if (!checks.some((check) => check.source === source)) checks.push({ source, configured: false, wabaCount: 0, error: null });
  cachedCredentials = {
    source: resolved?.source || candidates[0]?.source || "none",
    apiKey: resolved?.apiKey || candidates[0]?.apiKey || "",
    resolved: Boolean(resolved), accounts: resolved?.accounts || [], checks, checkedAt: Date.now(),
  };
  return cachedCredentials;
}
export function forgetWhatsAppCredentials() { cachedCredentials = null; }

// Minimal authenticated client restricted to the messaging and WhatsApp
// resources this adapter needs. Credentials never leave the server.
export async function whatsappRequest(path, { method = "GET", body, formData, credentials = null } = {}) {
  if (!/^\/(messages|whatsapp|messaging_profiles)(?:[/?]|$)/.test(path) || path.includes("..")) throw whatsappError("Unsupported WhatsApp resource");
  const resolved = credentials || await resolveWhatsAppCredentials();
  if (!resolved.apiKey) throw whatsappError("Configure TELNYX_API_KEY (and optionally TELNYX_API_KEY_WHATSAPP) on the server", 503);
  const response = await fetch(`${whatsappBaseUrl()}/v2${path}`, {
    method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${resolved.apiKey}`, Accept: "application/json",
      ...(body !== undefined && !formData ? { "Content-Type": "application/json" } : {}) },
    body: formData ? formData : body === undefined ? undefined : JSON.stringify(body),
  });
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const source = result.errors?.[0] || {};
    throw Object.assign(whatsappError(source.detail || source.title || `WhatsApp API returned HTTP ${response.status}`, response.status), { code: source.code, telnyx: result });
  }
  return result;
}

// Saga provider decorator for `whatsapp_send`. POST /v2/messages/whatsapp has
// no idempotency key, so an uncertain outcome is never retried automatically.
export function whatsappProvider(inner, request = whatsappRequest) {
  return { name: inner?.name || "telnyx-whatsapp", async send(command) {
    if (command.operation !== "whatsapp_send") return inner.send(command);
    try {
      const response = await request("/messages/whatsapp", { method: "POST", body: command.request });
      if (!response.data?.id) return { outcome: "ambiguous", httpStatus: 502, response: { error: "Message acceptance did not include a message ID" } };
      return { outcome: "accepted", httpStatus: 200, response };
    } catch (error) {
      const ambiguous = !error.status || error.status >= 500 || [408, 429].includes(error.status);
      return { outcome: ambiguous ? "ambiguous" : "failed", httpStatus: error.status || 504,
        response: { error: String(error.message).slice(0, 500), code: error.code } };
    }
  } };
}
