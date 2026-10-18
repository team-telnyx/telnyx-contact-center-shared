// Bound the streamed body as well as Content-Length: image data is transient.
export async function readConferenceBody(request) {
  const limit = 1024 * 1024;
  const fail = (message, status) => Object.assign(new Error(message), { status });
  if (Number(request.headers.get("content-length")) > limit) throw fail("Request exceeds 1 MiB", 413);
  const reader = request.body?.getReader();
  if (!reader) throw fail("Request body is required", 400);
  const parts = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw fail("Request exceeds 1 MiB", 413); }
      parts.push(Buffer.from(value));
    }
    const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Invalid object");
    return value;
  } catch (error) { if (error.status) throw error; throw fail("Invalid JSON request", 400); }
}
