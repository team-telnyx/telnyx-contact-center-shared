import test from "node:test";
import assert from "node:assert/strict";
import { drawAvatarPreview, isAvatarImageFile } from "../lib/ai/avatar-preview.mjs";

test("avatar previews accept only bounded raster files", () => {
  for (const type of ["image/png", "image/jpeg", "image/webp"]) assert(isAvatarImageFile({ type, size: 100 }));
  for (const file of [null, { type: "text/html", size: 100 }, { type: "image/svg+xml", size: 100 }, { type: "image/png", size: 0 }, { type: "image/png", size: 10 * 1024 * 1024 + 1 }]) assert.equal(isAvatarImageFile(file), false);
});

test("raster preview is scaled and releases decoded pixels on success, cancellation and invalid dimensions", async t => {
  const bitmap = { width: 512, height: 256, close: t.mock.fn() };
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => bitmap;
  t.after(() => { if (previous) globalThis.createImageBitmap = previous; else delete globalThis.createImageBitmap; });
  const drawImage = t.mock.fn();
  const canvas = { getContext: () => ({ drawImage }) };
  const file = { type: "image/png", size: 100 };
  assert.equal(await drawAvatarPreview(canvas, file), true);
  assert.equal(canvas.width, 320);
  assert.equal(canvas.height, 160);
  assert.equal(drawImage.mock.callCount(), 1);
  assert.equal(bitmap.close.mock.callCount(), 1);
  assert.equal(await drawAvatarPreview(canvas, file, { signal: AbortSignal.abort() }), false);
  assert.equal(drawImage.mock.callCount(), 1);
  assert.equal(bitmap.close.mock.callCount(), 2);
  bitmap.width = 8193;
  await assert.rejects(drawAvatarPreview(canvas, file), /Invalid image data/);
  assert.equal(bitmap.close.mock.callCount(), 3);
});
