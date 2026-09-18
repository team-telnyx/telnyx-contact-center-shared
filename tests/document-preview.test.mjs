import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseDocumentPreview, PREVIEW_LIMITS } from "../lib/documents/parse-preview.mjs";
import { createPreviewService, parseInWorker } from "../lib/documents/preview-service.mjs";
import { documentPreviewKind, documentPreviewUrl } from "../lib/documents/preview-types.mjs";
import { attachmentResponse } from "../lib/widgets/attachments.js";

function workbookBytes(bookType, rows = [["Code", "Amount"], ["00123", 42.5]]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Orders");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Zażółć gęślą jaźń"]]), "Notes");
  return XLSX.write(workbook, { bookType, type: "buffer" });
}
const textFile = (value, extra = {}) => ({ bytes: Buffer.from(value), name: "note.txt", content_type: "text/plain", conversation_id: "conversation-a", ...extra });

test("preview classification handles all requested types without overriding a conflicting MIME", () => {
  for (const [ext, kind] of [["docx", "word"], ["doc", "word"], ["xlsx", "spreadsheet"], ["xls", "spreadsheet"], ["txt", "text"], ["csv", "csv"]]) assert.equal(documentPreviewKind("application/octet-stream", `test.${ext.toUpperCase()}`), kind);
  assert.equal(documentPreviewKind("text/plain; charset=utf-8"), "text");
  assert.equal(documentPreviewKind("image/png", "file.docx"), null);
  assert.equal(documentPreviewKind("application/zip", "file.zip"), null);
  assert.equal(documentPreviewUrl("/api/file?access=signed%2Btoken&preview=0"), "/api/file?access=signed%2Btoken&preview=1");
});

for (const extension of ["xls", "xlsx"]) test(`${extension}: real workbook preserves multiple sheets, text identifiers and numbers`, () => {
  const data = parseDocumentPreview(workbookBytes(extension), "spreadsheet");
  assert.deepEqual(data.sheets.map(sheet => sheet.name), ["Orders", "Notes"]);
  assert.deepEqual(data.sheets[0].rows[1], ["00123", "42.5"]);
  assert.equal(data.sheets[1].rows[0][0], "Zażółć gęślą jaźń");
  assert.equal(data.truncated, false);
});

test("Excel uses cached formula values, falls back to formula text, and omits hidden sheets", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, { A1: { t: "n", f: "1+1", v: 2 }, B1: { t: "n", f: "SUM(A1:A2)" }, "!ref": "A1:B1" }, "Visible");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Hidden"]]), "Hidden");
  workbook.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
  const data = parseDocumentPreview(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), "spreadsheet");
  assert.equal(data.sheets.length, 1);
  assert.deepEqual(data.sheets[0].rows[0], ["2", "=SUM(A1:A2)"]);
});

test("CSV preserves leading zeroes, phone numbers, quoted delimiters, multiline cells and HTML as text", () => {
  const data = parseDocumentPreview(Buffer.from('\ufeffCode;Phone;Description\r\n00123;+48123456789;"first; second\n<script>alert(1)</script>"'), "csv");
  assert.deepEqual(data.sheets[0].rows[1], ["00123", "+48123456789", "first; second\n<script>alert(1)</script>"]);
  assert.throws(() => parseDocumentPreview(Buffer.from('Code,Description\n123,"unterminated'), "csv"));
});

test("preview limits truncate rows, columns, long cells and plain text explicitly", () => {
  const rows = Array.from({ length: PREVIEW_LIMITS.rows + 5 }, (_, i) => [String(i), "value"]);
  const table = parseDocumentPreview(workbookBytes("xlsx", rows), "spreadsheet");
  assert.equal(table.sheets[0].rows.length, PREVIEW_LIMITS.rows);
  assert.equal(table.truncated, true);
  const wide = parseDocumentPreview(Buffer.from(Array(105).fill("x").join(",")), "csv");
  assert.equal(wide.sheets[0].rows[0].length, 100);
  assert.equal(wide.truncated, true);
  const long = parseDocumentPreview(Buffer.from("x".repeat(4001)), "csv");
  assert.equal(long.sheets[0].rows[0][0].length, 4000);
  assert.equal(long.truncated, true);
  const text = parseDocumentPreview(Buffer.from("x".repeat(200001)), "text");
  assert.equal(text.text.length, 200000);
  assert.equal(text.truncated, true);
});

test("TXT decoding preserves Unicode, BOM-marked UTF-16, and rejects invalid UTF-8", () => {
  assert.equal(parseDocumentPreview(Buffer.from("Zażółć\n<script>"), "text").text, "Zażółć\n<script>");
  assert.equal(parseDocumentPreview(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hello", "utf16le")]), "text").text, "Hello");
  assert.throws(() => parseDocumentPreview(Buffer.from([0xff, 0x00]), "text"));
  assert.throws(() => parseDocumentPreview(Buffer.from("not an Excel file"), "spreadsheet"));
});

test("worker parses real XLS and TXT and returns controlled errors for damaged files", async () => {
  const data = await parseInWorker({ bytes: workbookBytes("xls") }, "spreadsheet");
  assert.equal(JSON.parse(data.bytes).sheets[0].rows[1][0], "00123");
  assert.equal(JSON.parse((await parseInWorker(textFile("hello"), "text")).bytes).text, "hello");
  await assert.rejects(parseInWorker({ bytes: Buffer.from("corrupt") }, "spreadsheet"), { code: "invalid_document" });
});

test("cache deduplicates work, expires, isolates conversations and never caches failures", async () => {
  let calls = 0, clock = 0;
  const service = createPreviewService({ now: () => clock, parse: async file => { calls++; if (file.bytes.toString() === "bad") throw new Error("bad"); await new Promise(resolve => setTimeout(resolve, 5)); return { bytes: file.bytes, contentType: "application/json" }; } });
  await Promise.all([service(textFile("hello")), service(textFile("hello"))]);
  await service(textFile("hello")); assert.equal(calls, 1);
  await service(textFile("hello", { conversation_id: "conversation-b" })); assert.equal(calls, 2);
  clock = 600001; await service(textFile("hello")); assert.equal(calls, 3);
  await assert.rejects(service(textFile("bad"))); await assert.rejects(service(textFile("bad"))); assert.equal(calls, 5);
});

test("excess concurrent previews and oversized input are rejected before parsing", async () => {
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const service = createPreviewService({ parse: async file => { await wait; return { bytes: file.bytes, contentType: "application/json" }; } });
  const first = service(textFile("a")), second = service(textFile("b"));
  await assert.rejects(service(textFile("c")), { code: "preview_busy", status: 429 });
  await assert.rejects(service(textFile("", { bytes: Buffer.alloc(PREVIEW_LIMITS.inputBytes + 1) })), { code: "preview_too_large", status: 413 });
  finish(); await Promise.all([first, second]);
});

test("preview response preserves original downloads and returns private JSON or a controlled error", async () => {
  const file = { ...textFile("00123"), byte_size: 5 };
  const original = attachmentResponse(new Request("https://cc.test/file"), file);
  assert.equal(await original.text(), "00123");
  assert.match(original.headers.get("content-disposition"), /^attachment;/);
  const preview = await attachmentResponse(new Request("https://cc.test/file?access=signed&preview=1"), file);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("cache-control"), /private, no-store/);
  assert.deepEqual(await preview.json(), { kind: "text", text: "00123", truncated: false });
  const invalid = await attachmentResponse(new Request("https://cc.test/file?preview=1"), { ...file, content_type: "application/zip", name: "file.zip" });
  assert.equal(invalid.status, 415);
});
