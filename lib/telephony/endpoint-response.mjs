// Next.js and upstream proxies can return an empty or HTML body for HTTP 5xx.
// Preserve the HTTP status without displaying a JSON parser error or raw HTML.
export async function decodeVoiceEndpointResponse(response) {
  let body;
  try { body = JSON.parse(await response.text()); } catch { /* handled below */ }
  const valid = body && typeof body === 'object' && !Array.isArray(body);
  if (!response.ok) {
    const fallback = `Voice service is temporarily unavailable (HTTP ${response.status}). Please retry.`;
    throw Object.assign(new Error(valid && typeof body.error === 'string' ? body.error : fallback), { status: response.status });
  }
  if (!valid) throw Object.assign(new Error('Voice service returned an invalid response. Please retry.'), { status: response.status });
  return body;
}
