import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CFB } from "xlsx";
import { Parser } from "htmlparser2";
import { parseWordPreview, sanitizeWordHtml, validateDocxArchive, WORD_PREVIEW_LIMITS } from "../lib/documents/word-preview.mjs";
import { parseInWorker, documentPreviewResponse } from "../lib/documents/preview-service.mjs";
import { documentPreviewKind, documentPreviewUrl } from "../lib/documents/preview-types.mjs";
import { wordPreviewFrame } from "../lib/documents/word-preview-frame.mjs";
import { documentPreviewCopy } from "../lib/documents/preview-copy.mjs";
import { documentPreviewTracingIncludes } from "../scripts/lib/document-preview-tracing.mjs";
import { attachmentResponse } from "../lib/widgets/attachments.js";
import { emailAttachmentResponse } from "../lib/email/attachment-response.mjs";
import { docxFixture, richDocxFixture, imageRun, imageRelationship, PNG_PIXEL, WORD_NS } from "./helpers/word-fixtures.mjs";

const wordFile = bytes => ({ bytes, byte_size: bytes.length, name: "sample.docx", content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", conversation_id: "word-preview-fixture" });

test("rich DOCX keeps headings, nested lists, table contents, emphasis, images and Unicode", async () => {
  const data = await parseWordPreview(await richDocxFixture());
  assert.equal(data.kind, "html");
  assert.equal(data.simplified, true);
  assert.equal(data.omitted, false);
  assert.match(data.html, /<h1>Alliance sample document<\/h1>/);
  assert.match(data.html, /<strong><em><u>Important details/);
  assert.match(data.html, /<ul>.*First item.*<ul>.*Nested item/s);
  assert.match(data.html, /colspan="2"/);
  assert.match(data.html, /42\.50/);
  assert.match(data.html, /src="data:image\/png;base64,/);
  assert.match(data.text, /00123.*Zażółć.*مرحبا.*שלום/);
  assert.match(data.text, /Accepted insertion/);
  assert.doesNotMatch(data.text, /DELETED PRIVATE NOTE/);
});

test("HTML text fallback decodes entities instead of exposing markup escapes", async () => {
  const data = await parseWordPreview(await docxFixture());
  assert.match(data.text, /Hello & goodbye/);
  assert.doesNotMatch(data.text, /&amp;/);
});

test("empty, image-only and long DOCX documents retain explicit preview states", async () => {
  assert.equal((await parseWordPreview(await docxFixture({ body: "" }))).empty, true);
  const image = await parseWordPreview(await docxFixture({ body: imageRun("image"), relationships: imageRelationship("image", "media/image.png"), files: { "word/media/image.png": PNG_PIXEL } }));
  assert.equal(image.empty, false);
  const long = await parseWordPreview(await docxFixture({ body: `<w:p><w:r><w:t>${"x".repeat(200100)}</w:t></w:r></w:p>` }));
  assert.equal(long.text.length, 200000);
  assert.equal(long.textTruncated, true);
  assert.equal(long.truncated, false);
  assert.match(long.html, new RegExp("x{200100}"));
});

test("DOCX retains footnotes while omitting review comments, headers and footers", async () => {
  const relation = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const data = await parseWordPreview(await docxFixture({
    body: '<w:p><w:r><w:t>Body content</w:t><w:footnoteReference w:id="1"/><w:commentReference w:id="0"/></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/></w:sectPr>',
    relationships: relation("footnotes", "footnotes", "footnotes.xml") + relation("comments", "comments", "comments.xml") + relation("header", "header", "header1.xml") + relation("footer", "footer", "footer1.xml"),
    files: {
      "word/footnotes.xml": `<w:footnotes xmlns:w="${WORD_NS}"><w:footnote w:id="1"><w:p><w:r><w:t>Readable footnote</w:t></w:r></w:p></w:footnote></w:footnotes>`,
      "word/comments.xml": `<w:comments xmlns:w="${WORD_NS}"><w:comment w:id="0" w:author="Reviewer"><w:p><w:r><w:t>PRIVATE COMMENT</w:t></w:r></w:p></w:comment></w:comments>`,
      "word/header1.xml": `<w:hdr xmlns:w="${WORD_NS}"><w:p><w:r><w:t>HEADER TEXT</w:t></w:r></w:p></w:hdr>`,
      "word/footer1.xml": `<w:ftr xmlns:w="${WORD_NS}"><w:p><w:r><w:t>FOOTER TEXT</w:t></w:r></w:p></w:ftr>`,
    },
  }));
  assert.match(data.text, /Body content/);
  assert.match(data.text, /Readable footnote/);
  assert.doesNotMatch(data.html, /PRIVATE COMMENT|HEADER TEXT|FOOTER TEXT|Reviewer/);
});

for (const ext of ["doc", "docx"]) test(`real ${ext} fixture parses in the disposable worker with no converter URL`, async () => {
  const bytes = await readFile(new URL(`./fixtures/documents/word.${ext}`, import.meta.url));
  const result = await parseInWorker({ bytes }, "word");
  const data = JSON.parse(result.bytes);
  assert.equal(result.contentType, "application/json");
  assert.equal(data.format, ext);
  assert.match(data.text, /Zażółć gęślą jaźń/);
  assert.match(data.text, /00123/);
  assert.equal(data.kind, ext === "docx" ? "html" : "text");
});

test("sanitizer strips active content, remote resources and document styling", () => {
  const html = sanitizeWordHtml('<p style="background:url(https://example.com/x)" onclick="alert(1)">Safe<script>alert(1)</script><style>body{color:red}</style><svg onload="alert(1)"><image href="https://example.com/x"/></svg><iframe src="https://example.com/x"></iframe><form action="https://example.com/x"><input name="token"/></form><img src="data:image/svg+xml;base64,xxx"><img src="https://example.com/x"><a href="javascript:alert(1)">bad</a><a href="https://example.com/x">external</a><a href="#word-preview-note">note</a></p>');
  assert.doesNotMatch(html, /script|style=|onclick|<svg|<iframe|<form|<input|<img|javascript:|https:/);
  assert.match(html, /Safe/);
  assert.match(html, /href="#word-preview-note"/);
});

test("sanitizer only admits image URLs produced by the checked raster converter", () => {
  const src = `data:image/png;base64,${PNG_PIXEL.toString("base64")}`;
  assert.doesNotMatch(sanitizeWordHtml(`<img src="${src}">`), /<img/);
  assert.match(sanitizeWordHtml(`<img src="${src}" onerror="bad()">`, new Set([src])), /<img src="data:image\/png/);
});

test("external DOCX image relationships are omitted and reported", async () => {
  const data = await parseWordPreview(await docxFixture({ body: imageRun("remote"), relationships: imageRelationship("remote", "file:///definitely-not-a-document-image", true) }));
  assert.equal(data.omitted, true);
  assert.doesNotMatch(data.html, /file:|<img/);
});

test("embedded SVG is omitted instead of being embedded as a data URL", async () => {
  const data = await parseWordPreview(await docxFixture({ body: imageRun("svg"), relationships: imageRelationship("svg", "media/image.svg"), files: { "word/media/image.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>alert(1)</script></svg>' } }));
  assert.equal(data.omitted, true);
  assert.doesNotMatch(data.html, /<img|<svg|script/);
});

test("image pixel budgets remain hard failures even when Mammoth recovers image errors", async () => {
  const image = Buffer.from(PNG_PIXEL);
  image.writeUInt32BE(100000, 16);
  image.writeUInt32BE(100000, 20);
  await assert.rejects(parseWordPreview(await docxFixture({ body: imageRun("large"), relationships: imageRelationship("large", "media/large.png"), files: { "word/media/large.png": image } })), { code: "preview_too_complex" });
});

test("DTD/entity documents and ZIPs without an actual Word main document are rejected", async () => {
  await assert.rejects(parseWordPreview(await docxFixture({ main: `<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="${WORD_NS}"><w:body>&x;</w:body></w:document>` })), { code: "invalid_document" });
  await assert.rejects(parseWordPreview(await docxFixture({ main: "<spreadsheet/>" })), { code: "invalid_document" });
});

test("ZIP traversal, repeated paths, entry count and decompression budgets reject unsafe archives", async () => {
  await assert.rejects(validateDocxArchive(await docxFixture({ files: { "../outside.xml": "bad" } })), { code: "invalid_document" });
  const duplicate = await docxFixture({ files: { "word/dupe01.xml": "<x/>", "word/dupe02.xml": "<x/>" } });
  const repeated = Buffer.from(duplicate.toString("latin1").replaceAll("dupe02.xml", "dupe01.xml"), "latin1");
  await assert.rejects(validateDocxArchive(repeated), { code: "invalid_document" });
  const many = Object.fromEntries(Array.from({ length: WORD_PREVIEW_LIMITS.entries }, (_, i) => [`parts/${i}.bin`, "a"]));
  await assert.rejects(validateDocxArchive(await docxFixture({ files: many })), { code: "preview_too_complex" });
  await assert.rejects(validateDocxArchive(await docxFixture({ files: { "word/large.bin": Buffer.alloc(WORD_PREVIEW_LIMITS.entryBytes + 1) } })), { code: "preview_too_complex" });
});

test("HTML nesting and node-count limits reject complexity rather than silently dropping content", () => {
  assert.throws(() => sanitizeWordHtml('<p>'.repeat(WORD_PREVIEW_LIMITS.nodes + 1)), { code: "preview_too_complex" });
  assert.throws(() => sanitizeWordHtml('<blockquote>'.repeat(WORD_PREVIEW_LIMITS.depth + 1)), { code: "preview_too_complex" });
});

test("encrypted OLE packages and non-Word containers return a controlled error", async () => {
  const ole = CFB.utils.cfb_new();
  CFB.utils.cfb_add(ole, "EncryptedPackage", Buffer.from("encrypted fixture"));
  const bytes = CFB.write(ole, { type: "buffer" });
  await assert.rejects(parseInWorker({ bytes }, "word"), { code: "invalid_document" });
  await assert.rejects(parseInWorker({ bytes: Buffer.from("invalid") }, "word"), { code: "invalid_document" });
  assert.equal(JSON.parse((await parseInWorker({ bytes: await docxFixture() }, "word")).bytes).kind, "html");
});

test("current and older clients receive compatible Word representations and unchanged downloads", async () => {
  const file = wordFile(await docxFixture());
  const plain = await documentPreviewResponse(file, new Request("https://cc.test/file?preview=1"));
  const text = await plain.json();
  assert.equal(text.kind, "text");
  assert.match(text.text, /Hello & goodbye/);
  const rich = await attachmentResponse(new Request("https://cc.test/file?preview=1&previewFormat=html-v1"), file);
  assert.match(rich.headers.get("cache-control"), /private, no-store/);
  const html = await rich.json();
  assert.equal(html.kind, "html");
  assert.equal(html.text, undefined);
  const original = attachmentResponse(new Request("https://cc.test/file"), file);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), file.bytes);
  const range = attachmentResponse(new Request("https://cc.test/file", { headers: { Range: "bytes=0-9" } }), file);
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), file.bytes.subarray(0,10));
});

test("email attachment responses share the same local Word preview", async () => {
  const file = wordFile(await docxFixture());
  const response = await emailAttachmentResponse(new Request("https://cc.test/email/file?preview=1&previewFormat=html-v1"), { file, bytes: file.bytes, conversationId: file.conversation_id });
  assert.equal((await response.json()).kind, "html");
});

test("Word URLs keep signed widget access and request rich previews only for Word", () => {
  const url = documentPreviewUrl("/api/file?access=signed%2Btoken&preview=1", "word");
  assert.equal(new URL(url,"https://cc.test").searchParams.get("access"), "signed+token");
  assert.match(url, /previewFormat=html-v1/);
  assert.doesNotMatch(documentPreviewUrl("/api/file", "spreadsheet"), /previewFormat/);
  assert.equal(documentPreviewKind("image/png", "file.docx"), null);
});

test("Word frame denies network and scripts and has an application-owned stylesheet", () => {
  const source = wordPreviewFrame("<p>Safe</p>");
  let csp;
  new Parser({ onopentag: (tag, attrs) => { if (tag === "meta" && attrs["http-equiv"] === "Content-Security-Policy") csp = attrs.content; } }).end(source);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /img-src data:/);
});

test("all preview locales explain simplified and overly complex Word previews", () => {
  for (const locale of ["en-US", "pl", "de", "fr", "es", "ar", "he"]) {
    const copy = documentPreviewCopy(locale);
    for (const key of ["word_simplified", "word_text", "word_omitted", "preview_too_complex"]) assert.ok(copy[key], `${locale}:${key}`);
  }
});

test("worker trace includes library modules and their actual transitive dependencies", () => {
  const paths = documentPreviewTracingIncludes();
  for (const name of ["mammoth", "word-extractor", "sanitize-html", "htmlparser2", "jszip", "@xmldom/xmldom", "yauzl", "image-size"]) {
    assert.ok(paths.some(path => path.endsWith(`/node_modules/${name}/**/*`)), name);
  }
});
