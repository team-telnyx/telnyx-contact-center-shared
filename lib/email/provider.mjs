import { createHash } from "node:crypto";

export const emailError = (message, status = 400) => Object.assign(new Error(message), { status });
export const emailId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,180}$/.test(value)) throw emailError('Invalid Email resource ID');
  return encodeURIComponent(value);
};
export function emailConfig() {
  return {
    apiKey: process.env.TELNYX_EMAIL_API_KEY || process.env.TELNYX_API_KEY || '',
    baseUrl: String(process.env.TELNYX_BASE_PATH || 'https://api.telnyx.com').replace(/\/+$/, ''),
    domain: process.env.CC_MAIL_DOMAIN?.trim().toLowerCase() || '',
  };
}
export async function emailRequest(path, { method = 'GET', body, idempotencyKey } = {}) {
  if (!/^\/email_(messages|inboxes|threads|domains|events|templates|validations|blocks|unsubscribe_groups)(?:[/?]|$)/.test(path) || path.includes('..')) throw emailError('Unsupported Email resource');
  const config = emailConfig();
  if (!config.apiKey) throw emailError('Configure TELNYX_EMAIL_API_KEY or TELNYX_API_KEY on the server', 503);
  const response = await fetch(`${config.baseUrl}/v2${path}`, {
    method, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const source = result.errors?.[0] || {};
    throw Object.assign(emailError(source.detail || source.title || `Email API returned HTTP ${response.status}`, response.status), { code: source.code });
  }
  return result;
}

// Only server-resolved URLs from an authenticated inbox message are accepted.
// They never come from a browser URL parameter. Do not forward API credentials.
export async function fetchEmailContent(value, limit = 1_000_000) {
  const url = new URL(value);
  const hosts = ['.telnyxcloudstorage.com', '.amazonaws.com', '.googleapis.com', '.cloudfront.net'];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !(url.hostname === 'api.telnyx.com' || hosts.some(suffix => url.hostname.endsWith(suffix)))) throw emailError('Unsupported stored email content host', 502);
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw emailError('Stored email content is unavailable', 502);
  if (Number(response.headers.get('content-length') || 0) > limit) { await response.body?.cancel(); throw emailError('Email content exceeds the size limit', 413); }
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > limit) throw emailError('Email content exceeds the size limit', 413);
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

export function emailProvider(voiceProvider, request = emailRequest) {
  return { name: voiceProvider?.name || 'telnyx-email', async send(command) {
    if (command.operation !== 'email_send') return voiceProvider.send(command);
    try {
      const response = await request('/email_messages', { method: 'POST', body: command.request,
        idempotencyKey: createHash('sha256').update(command.commandId).digest('hex') });
      if (!response.data?.id) return { outcome: 'ambiguous', httpStatus: 502, response: { error: 'Email acceptance did not include a message ID' } };
      return { outcome: 'accepted', httpStatus: 200, response };
    } catch (error) {
      const ambiguous = !error.status || error.status >= 500 || [408,409,429].includes(error.status);
      return { outcome: ambiguous ? 'ambiguous' : 'failed', httpStatus: error.status || 504,
        response: { error: String(error.message).slice(0,500), code: error.code } };
    }
  } };
}
