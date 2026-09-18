// Chrome refuses to render a PDF inside a frame served with a bare CSP `sandbox`
// directive, which is why documents came up blank. PDFs are handed to the browser
// viewer instead, and everything else keeps the opaque-origin sandbox.
const FRAMEABLE_WITHOUT_SANDBOX = new Set(["application/pdf"]);
const MEDIA_EXTENSION_TYPES = new Map([
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["wave", "audio/wav"],
  ["m4a", "audio/mp4"],
  ["aac", "audio/aac"],
  ["ogg", "audio/ogg"],
  ["oga", "audio/ogg"],
  ["flac", "audio/flac"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
]);

export function resolveAttachmentResponseMimeType(attachment, upstreamType = null) {
  const declared = [attachment?.mime, attachment?.contentType, attachment?.mediaType, upstreamType]
    .map((value) => String(value || "").trim().toLowerCase())
    .find((value) => value.includes("/") && value !== "application/octet-stream");
  if (declared) return declared;
  const extension = String(attachment?.filename || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return MEDIA_EXTENSION_TYPES.get(extension)
    || String(upstreamType || "application/octet-stream").toLowerCase();
}

export function attachmentResponseHeaders({ mimeType, filename }, contentLength = null) {
  const type = String(mimeType || "application/octet-stream").toLowerCase();
  const originalName = String(filename || "attachment").replace(/[\x00-\x1f\x7f"\\/]/g, "_").slice(0,240);
  const safeName = originalName.replace(/[^\x20-\x7e]/g,"_");
  return {
    "content-type": type,
    ...(contentLength === null ? {} : { "content-length": String(contentLength) }),
    // The name is attacker-influenced, so it is quoted and never used to pick a
    // content type, and the response can only ever be displayed inline.
    "content-disposition": `${/^(image\/|audio\/|video\/|application\/pdf$)/.test(type)?"inline":"attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(originalName)}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": FRAMEABLE_WITHOUT_SANDBOX.has(type)
      ? "default-src 'none'; object-src 'self'"
      : "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  };
}
