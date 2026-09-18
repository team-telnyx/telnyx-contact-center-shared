import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { documentPreviewKind } from "./preview-types.mjs";
import { attachmentResponseHeaders } from "../widgets/attachment-headers.js";

const MAX_INPUT = 20 * 1024 * 1024;
const MAX_OUTPUT = 25 * 1024 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_TTL = 10 * 60 * 1000;
const fail = (code, status) => Object.assign(new Error(code), { code, status });
// Load the native constructor at runtime. Turbopack 16.1's static Worker
// analysis emits node:worker_threads as a filesystem asset and crashes the build.
// Node 22 (the application runtime) exposes built-ins without bundler resolution.
const { Worker } = process.getBuiltinModule("worker_threads");

export function parseInWorker(file, kind) {
  return new Promise((resolveResult, reject) => {
    // Use the source path at runtime: production Docker includes lib/ and
    // node_modules. Next tracing also explicitly includes these worker files.
    const worker = new Worker(resolve(process.cwd(), "lib/documents/preview-worker.mjs"), {
      workerData: { bytes: file.bytes, kind }, execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    });
    const timer = setTimeout(() => { reject(fail("preview_timeout", 422)); void worker.terminate(); }, 15000);
    worker.once("message", result => {
      clearTimeout(timer);
      void worker.terminate();
      if (result.error) reject(fail(result.error === "preview_too_complex" ? "preview_too_complex" : "invalid_document", result.error === "preview_too_complex" ? 413 : 422));
      else resolveResult({ bytes: Buffer.from(JSON.stringify(result.data)), contentType: "application/json" });
    });
    worker.once("error", () => { clearTimeout(timer); reject(fail("invalid_document", 422)); });
    worker.once("exit", () => { clearTimeout(timer); reject(fail("invalid_document", 422)); });
  });
}

// The cache is bounded, short-lived and process-local; authorization MUST happen
// before calling this service, including on every cache hit. No public file URLs.
export function createPreviewService({ parse = parseInWorker, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  let cacheBytes = 0;
  function remove(key) { cacheBytes -= cache.get(key).bytes.length; cache.delete(key); }
  return async function preview(file) {
    const kind = documentPreviewKind(file.content_type, file.name);
    if (!kind || kind === "pdf") throw fail("unsupported_document", 415);
    if (!file.bytes?.length || file.bytes.length > MAX_INPUT) throw fail("preview_too_large", 413);
    const hash = createHash("sha256").update(file.bytes).digest("hex");
    const key = `preview-v2:${file.conversation_id || file.id || ""}:${kind}:${hash}`;
    for (const [oldKey, value] of cache) if (value.expires <= now()) remove(oldKey);
    if (cache.has(key)) {
      const value = cache.get(key); cache.delete(key); cache.set(key, value); return value;
    }
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 2) throw fail("preview_busy", 429);
    const task = (async () => {
      const result = await parse(file, kind);
      if (result.bytes.length > MAX_OUTPUT) throw fail("preview_too_large", 413);
      while (cache.size && (cacheBytes + result.bytes.length > CACHE_BYTES || cache.size >= 64)) remove(cache.keys().next().value);
      cache.set(key, { ...result, expires: now() + CACHE_TTL });
      cacheBytes += result.bytes.length;
      return result;
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  };
}

const previewDocument = createPreviewService();

export async function documentPreviewResponse(file, request) {
  try {
    const result = await previewDocument(file);
    let bytes = result.bytes;
    if (documentPreviewKind(file.content_type, file.name) === "word") {
      const data = JSON.parse(bytes);
      const rich = request && new URL(request.url).searchParams.get("previewFormat") === "html-v1";
      // Cache the canonical parse only. Response representations are derived
      // afterwards so older open tabs still receive their supported text shape.
      bytes = Buffer.from(JSON.stringify(rich
        ? Object.fromEntries(Object.entries(data).filter(([key]) => data.kind !== "html" || !["text", "textTruncated"].includes(key)))
        : { kind: "text", format: data.format, text: data.text, simplified: true, truncated: data.textTruncated || data.truncated }));
    }
    return new Response(bytes, { headers: {
      ...attachmentResponseHeaders({ mimeType: result.contentType, filename: "preview.json" }, bytes.length),
      "Referrer-Policy": "no-referrer",
    } });
  } catch (error) {
    return Response.json({ error: error.code || "conversion_failed" }, { status: error.status || 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
