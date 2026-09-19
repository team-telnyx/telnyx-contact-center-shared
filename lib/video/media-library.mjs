import { randomUUID } from "node:crypto";
import { getStorage } from "../storage/index.mjs";
import { parseAttachmentByteRange } from "../widgets/attachment-ranges.js";

// Video media library for the widget's waiting playlist
// (the internal documentation §3). Metadata in cc_video_media,
// bytes in the storage driver so multi-node deployments share them.
export const MAX_VIDEO_MEDIA_BYTES = 64 * 1024 * 1024;
// The library is listed whole (no paging); uploads stop at this size.
export const MAX_VIDEO_MEDIA_ITEMS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = { "video/mp4": "mp4", "video/webm": "webm" };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// mp4: an ISO base media file has "ftyp" at offset 4; webm starts with the EBML magic.
export function sniffVideoType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return null;
}

const view = (row) => ({ id: row.id, name: row.name, contentType: row.content_type, byteSize: Number(row.byte_size), createdAt: row.created_at, url: `/api/video/media/${row.id}` });

export async function listVideoMedia(pool) {
  return (await pool.query("SELECT id,name,content_type,byte_size,created_at FROM cc_video_media WHERE deleted_at IS NULL ORDER BY created_at DESC")).rows.map(view);
}

export async function storeVideoMedia(pool, { name, bytes, actor = null, storage = null }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw fail("File is required");
  if (bytes.length > MAX_VIDEO_MEDIA_BYTES) throw fail("Video files are limited to 64 MB", 413);
  const contentType = sniffVideoType(bytes);
  if (!contentType) throw fail("Upload an mp4 or webm video", 415);
  const id = randomUUID();
  const key = `video-${id}.${TYPES[contentType]}`;
  const driver = storage || await getStorage();
  const cleanName = String(name || key).replace(/[\r\n\t]/g, " ").trim().slice(0, 200) || key;
  // The size check and the insert run under one advisory lock so parallel
  // uploads cannot overshoot the library limit.
  const tx = await pool.connect();
  let stored = false;
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(741901,6)");
    const count = Number((await tx.query("SELECT count(*)::int AS n FROM cc_video_media WHERE deleted_at IS NULL")).rows[0].n);
    if (count >= MAX_VIDEO_MEDIA_ITEMS) throw fail(`The media library holds at most ${MAX_VIDEO_MEDIA_ITEMS} videos; delete some first`, 409);
    await driver.put(key, bytes, contentType);
    stored = true;
    const row = (await tx.query(`INSERT INTO cc_video_media(id,name,content_type,byte_size,storage_key,created_by)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,content_type,byte_size,created_at`, [id, cleanName, contentType, bytes.length, key, actor])).rows[0];
    await tx.query("COMMIT");
    return view(row);
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    // No metadata, no file: an orphan on disk would never be listed or deleted.
    if (stored) await driver.remove(key).catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}

// The file goes first: a storage failure leaves the entry listed so the
// deletion can be retried instead of orphaning up to 64 MB.
export async function deleteVideoMedia(pool, id, { storage = null } = {}) {
  if (!UUID.test(String(id || ""))) return false;
  const row = (await pool.query("SELECT storage_key FROM cc_video_media WHERE id=$1 AND deleted_at IS NULL", [id])).rows[0];
  if (!row) return false;
  const driver = storage || await getStorage();
  await driver.remove(row.storage_key);
  const marked = await pool.query("UPDATE cc_video_media SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id", [id]);
  return marked.rowCount > 0;
}

// Reads the file, or only the requested byte range when the storage driver
// can (local disk, S3 and Azure all can), so a seek never pulls the whole
// video. `unsatisfiable` marks a range outside the file.
export async function readVideoMedia(pool, id, { storage = null, rangeHeader = null } = {}) {
  if (!UUID.test(String(id || ""))) return null;
  const row = (await pool.query("SELECT id,name,content_type,byte_size,storage_key FROM cc_video_media WHERE id=$1 AND deleted_at IS NULL", [id])).rows[0];
  if (!row) return null;
  const total = Number(row.byte_size);
  const range = rangeHeader ? parseAttachmentByteRange(rangeHeader, total) : null;
  if (rangeHeader && !range) return { ...view(row), body: null, range: null, unsatisfiable: true };
  const driver = storage || await getStorage();
  let body = null;
  if (range && typeof driver.getRange === "function") body = (await driver.getRange(row.storage_key, range.start, range.end))?.body || null;
  else {
    const stored = await driver.get(row.storage_key, row.content_type);
    body = stored?.body ? (range ? stored.body.subarray(range.start, range.end + 1) : stored.body) : null;
  }
  if (!body) return null;
  return { ...view(row), body, range, unsatisfiable: false };
}

// Range-aware response for <video>: the player seeks and preloads in chunks.
export function videoMediaResponse(media, { cacheControl = "public, max-age=3600" } = {}) {
  const total = media.byteSize;
  if (media.unsatisfiable) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
  const headers = { "Content-Type": media.contentType, "Accept-Ranges": "bytes", "Cache-Control": cacheControl, "X-Content-Type-Options": "nosniff", "Content-Length": String(media.body.length) };
  if (!media.range) return new Response(media.body, { status: 200, headers });
  return new Response(media.body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${media.range.start}-${media.range.end}/${total}` } });
}
