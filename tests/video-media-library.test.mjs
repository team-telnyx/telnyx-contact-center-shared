import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAcdTestPool } from "./helpers/acd-test-db.mjs";
import { __resetStorageForTests } from "../lib/storage/index.mjs";
import { deleteVideoMedia, listVideoMedia, readVideoMedia, sniffVideoType, storeVideoMedia, videoMediaResponse } from "../lib/video/media-library.mjs";
import { ROUTE_EXEMPTIONS } from "../lib/authz/route-exemptions.mjs";

const pool = await prepareAcdTestPool("acd_core_test_video_media");
const cwd = process.cwd();
let tmp;
before(async () => { tmp = await mkdtemp(join(tmpdir(), "cc-video-media-")); process.chdir(tmp); __resetStorageForTests(); });
after(async () => { process.chdir(cwd); __resetStorageForTests(); await rm(tmp, { recursive: true, force: true }); await pool.end(); });

const mp4 = (size = 4096) => { const bytes = Buffer.alloc(size, 7); bytes.write("ftyp", 4, "ascii"); return bytes; };
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);

test("only mp4 and webm files enter the library; storage holds the bytes, the table the metadata", async () => {
  assert.equal(sniffVideoType(mp4()), "video/mp4"); assert.equal(sniffVideoType(webm()), "video/webm"); assert.equal(sniffVideoType(Buffer.from("GIF89a....")), null);
  await assert.rejects(storeVideoMedia(pool, { name: "x.gif", bytes: Buffer.from("GIF89a..........") }), (error) => error.status === 415);
  await assert.rejects(storeVideoMedia(pool, { name: "empty.mp4", bytes: Buffer.alloc(0) }), (error) => error.status === 400);
  const stored = await storeVideoMedia(pool, { name: "Promo\nspring.mp4", bytes: mp4(), actor: "admin-1" });
  assert.equal(stored.contentType, "video/mp4"); assert.equal(stored.byteSize, 4096); assert.equal(stored.name, "Promo spring.mp4"); assert.equal(stored.url, `/api/video/media/${stored.id}`);
  const listed = await listVideoMedia(pool);
  assert.ok(listed.some((item) => item.id === stored.id));
  const read = await readVideoMedia(pool, stored.id);
  assert.equal(read.body.length, 4096); assert.equal(read.body.subarray(4, 8).toString("ascii"), "ftyp");
  assert.equal(await readVideoMedia(pool, "not-a-uuid"), null);
  assert.equal(await readVideoMedia(pool, "------------------------------------"), null, "a malformed uuid never reaches Postgres");
});

test("the media response supports byte ranges for the visitor's player and rejects bad ranges", async () => {
  const stored = await storeVideoMedia(pool, { name: "clip.webm", bytes: webm() });
  const full = videoMediaResponse(await readVideoMedia(pool, stored.id));
  assert.equal(full.status, 200); assert.equal(full.headers.get("Content-Type"), "video/webm"); assert.equal(full.headers.get("Accept-Ranges"), "bytes"); assert.equal(full.headers.get("Content-Length"), "68");
  // Only the requested bytes are read from storage.
  const partial = await readVideoMedia(pool, stored.id, { rangeHeader: "bytes=4-11" });
  assert.equal(partial.body.length, 8); assert.deepEqual(partial.range, { start: 4, end: 11 });
  const part = videoMediaResponse(partial);
  assert.equal(part.status, 206); assert.equal(part.headers.get("Content-Range"), "bytes 4-11/68"); assert.equal(part.headers.get("Content-Length"), "8");
  assert.equal(Buffer.from(await part.arrayBuffer()).length, 8);
  const tail = videoMediaResponse(await readVideoMedia(pool, stored.id, { rangeHeader: "bytes=60-" }));
  assert.equal(tail.headers.get("Content-Range"), "bytes 60-67/68"); assert.equal(tail.headers.get("Content-Length"), "8");
  assert.equal(videoMediaResponse(await readVideoMedia(pool, stored.id, { rangeHeader: "bytes=700-800" })).status, 416);
  // A driver without ranged reads still serves the slice from a full read.
  const plain = { get: async () => ({ body: webm() }) };
  const sliced = await readVideoMedia(pool, stored.id, { rangeHeader: "bytes=0-3", storage: plain });
  assert.deepEqual([...sliced.body], [0x1a, 0x45, 0xdf, 0xa3]);
});

test("the library limit holds under parallel uploads", async () => {
  const lib = await import("../lib/video/media-library.mjs");
  const before = (await listVideoMedia(pool)).length;
  const room = lib.MAX_VIDEO_MEDIA_ITEMS - before;
  const attempts = Array.from({ length: room + 3 }, (_, index) => storeVideoMedia(pool, { name: `bulk-${index}.mp4`, bytes: mp4(64) }));
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, room);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.status === 409));
  assert.equal((await listVideoMedia(pool)).length, lib.MAX_VIDEO_MEDIA_ITEMS);
  for (const item of await listVideoMedia(pool)) if (item.name.startsWith("bulk-")) await deleteVideoMedia(pool, item.id);
});

test("deleting removes the file and hides the entry; the public route is a documented exemption", async () => {
  const stored = await storeVideoMedia(pool, { name: "old.mp4", bytes: mp4(1024) });
  // A storage failure keeps the entry so the deletion can be retried.
  const flaky = { remove: async () => { throw new Error("storage down"); } };
  await assert.rejects(deleteVideoMedia(pool, stored.id, { storage: flaky }), /storage down/);
  assert.ok((await listVideoMedia(pool)).some((item) => item.id === stored.id), "still listed after a failed delete");
  assert.equal(await deleteVideoMedia(pool, stored.id), true);
  assert.equal(await deleteVideoMedia(pool, stored.id), false);
  assert.equal(await readVideoMedia(pool, stored.id), null);
  assert.equal((await listVideoMedia(pool)).some((item) => item.id === stored.id), false);
  assert.match(ROUTE_EXEMPTIONS["video/media/[id]"], /unguessable id/);
});
