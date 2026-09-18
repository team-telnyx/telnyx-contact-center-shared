import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentAccept, isAttachmentTypeAllowed, normalizeAttachmentMimeType } from "../lib/widgets/attachment-types.mjs";
import { withStreamedAttachment, withStreamedChatMessage } from "../lib/widgets/multipart-upload.js";
import { validateAttachment, attachmentResponse } from "../lib/widgets/attachments.js";
import { documentPreviewKind } from "../lib/documents/preview-types.mjs";
import { parseDocumentPreview, PREVIEW_LIMITS } from "../lib/documents/parse-preview.mjs";
import { DEFAULT_WIDGET_CONFIG } from "../lib/widgets/config.js";

const markdown = "# Zażółć gęślą jaźń\n\n- **First**\n- Second\n\n| Code | Value |\n| --- | --- |\n| 00123 | 42 |\n";
const variants = ["text/markdown", "text/x-markdown", "text/plain", "application/octet-stream", ""];
function request(file, batch) {
  const form = new FormData();
  form.append("file", file);
  form.append(batch ? "message" : "messageId", batch ? JSON.stringify({ body: "Notes" }) : "test-id");
  return new Request("https://test.local", { method: "POST", body: form });
}

test("Markdown names and browser MIME variants use one policy type and preview kind", () => {
  for (const name of ["notes.md", "NOTES.MD", "notes.markdown"]) for (const type of variants) {
    assert.equal(normalizeAttachmentMimeType(type, name), "text/markdown");
    assert.equal(documentPreviewKind(type, name), "markdown");
    assert.equal(isAttachmentTypeAllowed(type, name, ["text/markdown"]), true);
    assert.equal(isAttachmentTypeAllowed(type, name, ["text/plain"]), false);
  }
  assert.equal(normalizeAttachmentMimeType("TEXT/MARKDOWN; charset=UTF-8"), "text/markdown");
  assert.equal(isAttachmentTypeAllowed("text/markdown", "notes.md", ["text/x-markdown"]), true);
  assert.equal(documentPreviewKind("image/png", "notes.md"), null);
  assert.equal(documentPreviewKind("text/plain", "notes.md.txt"), "text");
  assert.equal(isAttachmentTypeAllowed("application/octet-stream", "notes.bin", ["text/markdown"]), false);
});

test("Markdown is configurable in both directions and file pickers include filename extensions", () => {
  for (const direction of ["inboundMimeTypes", "outboundMimeTypes"]) {
    const types = DEFAULT_WIDGET_CONFIG.features.attachmentPolicy[direction];
    assert.ok(types.includes("text/markdown"));
    const accept = attachmentAccept(types).split(",");
    for (const value of ["text/markdown", "text/x-markdown", ".md", ".markdown"]) assert.ok(accept.includes(value));
    assert.ok(!attachmentAccept(types.filter(type => type !== "text/markdown")).includes(".md"));
  }
});

test("both multipart readers normalize Markdown before policy and content validation", async () => {
  for (const batch of [false, true]) for (const type of variants) {
    const receive = batch ? withStreamedChatMessage : withStreamedAttachment;
    await receive(request(new File([markdown], "notes.md", { type }), batch), { mimeTypes: ["text/markdown"], maximumBytes: 1024 }, async result => {
      const file = batch ? result.files[0] : result.file;
      assert.equal(file.type, "text/markdown");
      const bytes = Buffer.from(await file.arrayBuffer());
      validateAttachment(bytes, file.type);
      assert.equal(bytes.toString(), markdown);
    });
    await assert.rejects(receive(request(new File([markdown], "notes.md", { type }), batch), { mimeTypes: ["text/plain"], maximumBytes: 1024 }, () => assert.fail("Disabled Markdown admitted")), { status: 403 });
  }
});

test("Markdown validation rejects binary, invalid UTF-8 and empty uploads", () => {
  validateAttachment(Buffer.from(markdown), "text/markdown");
  for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe]), Buffer.alloc(0)]) assert.throws(() => validateAttachment(bytes, "text/markdown"), /content does not match/);
});

test("Markdown parser preserves source and bounds preview length", () => {
  assert.deepEqual(parseDocumentPreview(Buffer.from(markdown), "markdown"), { kind: "markdown", text: markdown, truncated: false });
  const result = parseDocumentPreview(Buffer.from("# " + "x".repeat(PREVIEW_LIMITS.textCharacters)), "markdown");
  assert.equal(result.text.length, PREVIEW_LIMITS.textCharacters);
  assert.equal(result.truncated, true);
  assert.throws(() => parseDocumentPreview(Buffer.from([0xff]), "markdown"));
});

test("Markdown endpoint uses private worker previews and preserves the original download", async () => {
  const file = { id: "md-fixture", conversation_id: "md-test", name: "notes.md", content_type: "text/markdown", bytes: Buffer.from(markdown), byte_size: Buffer.byteLength(markdown) };
  const response = await attachmentResponse(new Request("https://test.local/file?access=token&preview=1"), file);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { kind: "markdown", text: markdown, truncated: false });
  const original = attachmentResponse(new Request("https://test.local/file"), file);
  assert.equal(original.headers.get("content-type"), "text/markdown");
  assert.match(original.headers.get("content-disposition"), /^attachment;/);
  assert.equal(await original.text(), markdown);
});
