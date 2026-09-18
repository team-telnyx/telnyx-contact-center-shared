import { parentPort, workerData } from "node:worker_threads";
import { parseDocumentPreview } from "./parse-preview.mjs";

try {
  const bytes = Buffer.from(workerData.bytes);
  const data = workerData.kind === "word"
    ? await (await import("./word-preview.mjs")).parseWordPreview(bytes)
    : parseDocumentPreview(bytes, workerData.kind);
  parentPort.postMessage({ data });
} catch (error) {
  // Do not leak parser internals or document content to the caller/logs.
  parentPort.postMessage({ error: error.code === "preview_too_complex" ? error.code : "invalid_document" });
}
