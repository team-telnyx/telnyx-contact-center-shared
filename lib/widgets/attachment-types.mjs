// Shared by file pickers and server admission: browsers disagree about Markdown
// MIME metadata. An extension only refines absent/generic/plain-text metadata.
export function normalizeAttachmentMimeType(mimeType, filename = "") {
  const type = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (type === "text/x-markdown") return "text/markdown";
  if (/\.(md|markdown)$/i.test(filename) && ["", "file", "application/octet-stream", "text/plain"].includes(type)) return "text/markdown";
  return type;
}

export function isAttachmentTypeAllowed(mimeType, filename, allowedTypes = []) {
  const type = normalizeAttachmentMimeType(mimeType, filename);
  return allowedTypes.some(allowed => normalizeAttachmentMimeType(allowed) === type);
}

export function attachmentAccept(mimeTypes = []) {
  const types = mimeTypes.map(type => normalizeAttachmentMimeType(type));
  if (types.includes("text/markdown")) types.push("text/x-markdown", ".md", ".markdown");
  return [...new Set(types)].join(",");
}
