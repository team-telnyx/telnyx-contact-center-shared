// Shared by the browser and the authenticated attachment response handler.
import { normalizeAttachmentMimeType } from "../widgets/attachment-types.mjs";

const TYPES = {
  "application/pdf": "pdf",
  "application/msword": "word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "word",
  "application/vnd.ms-excel": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "text/plain": "text",
  "text/csv": "csv",
  "text/markdown": "markdown",
};
const EXTENSIONS = { pdf: "pdf", doc: "word", docx: "word", xls: "spreadsheet", xlsx: "spreadsheet", txt: "text", csv: "csv" };

export const DOCUMENT_PREVIEW_SIZE = { widthPercent: 60, heightPercent: 80 };

export function documentPreviewKind(mimeType, filename = "") {
  const mime = normalizeAttachmentMimeType(mimeType, filename);
  if (TYPES[mime]) return TYPES[mime];
  // Only fall back to the name for absent/generic MIME metadata.
  if (!mime || mime === "application/octet-stream" || mime === "file") {
    return EXTENSIONS[String(filename).split(".").pop().toLowerCase()] || null;
  }
  return null;
}

export function documentPreviewUrl(url, kind) {
  const parsed = new URL(url, "http://preview.invalid");
  parsed.searchParams.set("preview", "1");
  if (kind === "word") parsed.searchParams.set("previewFormat", "html-v1");
  return /^https?:\/\//i.test(url) ? parsed.href : `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
