import { smsError } from "./policy.mjs";
export { smsError };

export const smsId = (value) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,180}$/.test(value)) throw smsError("Invalid Telnyx resource ID");
  return encodeURIComponent(value);
};
export function smsConfig() {
  return {
    apiKey: process.env.TELNYX_MESSAGING_API_KEY || process.env.TELNYX_API_KEY || "",
    baseUrl: String(process.env.TELNYX_BASE_PATH || "https://api.telnyx.com").replace(/\/+$/, ""),
  };
}
// Minimal authenticated client restricted to the messaging resources this
// adapter needs. Credentials never leave the server.
export async function smsRequest(path, { method = "GET", body } = {}) {
  if (!/^\/(messages|messaging_profiles|phone_numbers)(?:[/?]|$)/.test(path) || path.includes("..")) throw smsError("Unsupported messaging resource");
  const config = smsConfig();
  if (!config.apiKey) throw smsError("Configure TELNYX_MESSAGING_API_KEY or TELNYX_API_KEY on the server", 503);
  const response = await fetch(`${config.baseUrl}/v2${path}`, {
    method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const source = result.errors?.[0] || {};
    throw Object.assign(smsError(source.detail || source.title || `Messaging API returned HTTP ${response.status}`, response.status), { code: source.code });
  }
  return result;
}

// Saga provider decorator for `sms_send`. POST /v2/messages has no idempotency
// key, so an uncertain outcome is never retried automatically: the message is
// marked unconfirmed and the agent decides whether to send again.
export function smsProvider(inner, request = smsRequest) {
  return { name: inner?.name || "telnyx-sms", async send(command) {
    if (command.operation !== "sms_send") return inner.send(command);
    try {
      const response = await request("/messages", { method: "POST", body: command.request });
      if (!response.data?.id) return { outcome: "ambiguous", httpStatus: 502, response: { error: "Message acceptance did not include a message ID" } };
      return { outcome: "accepted", httpStatus: 200, response };
    } catch (error) {
      const ambiguous = !error.status || error.status >= 500 || [408, 429].includes(error.status);
      return { outcome: ambiguous ? "ambiguous" : "failed", httpStatus: error.status || 504,
        response: { error: String(error.message).slice(0, 500), code: error.code } };
    }
  } };
}
