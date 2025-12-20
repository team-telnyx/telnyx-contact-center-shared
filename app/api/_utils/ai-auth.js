export function requireAiApiKey(request) {
  const apiKeyRef = process.env.TELNYX_AI_API_KEY_REF || "telnyx-ai-api-key";
  const headerKey = request.headers.get(apiKeyRef);
  const expected = process.env.TELNYX_AI_API_KEY || "";
  if (!expected) {
    return { ok: false, status: 500, error: "Server not configured" };
  }
  if (!headerKey || headerKey !== expected) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}

export function jsonOk(data, init = 200) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: typeof init === "number" ? init : 200,
    headers: { "content-type": "application/json" },
  });
}

export function jsonError(error, status = 400) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
