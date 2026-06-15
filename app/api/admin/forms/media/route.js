import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { isAdmin } from "@/lib/role-utils";
import path from "path";
import { getStorage } from "@/lib/storage/index.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

const PUBLIC_PREFIX = "/media";
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Map([["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/webp", ".webp"], ["image/gif", ".gif"], ["image/svg+xml", ".svg"]]);

async function requireAdmin() {
  const session = await getServerSession(authOptions); const id = session?.user?.id || null; const email = session?.user?.email || null; if (!id && !email) return null;
  let user = id ? await PgDb.findUserById(id) : null; if (!user && email) user = await PgDb.findUserByUsername(email); return user && isAdmin(user) ? user : null;
}
function safeBase(name = "image") { return String(name).toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "image"; }
function titleFromFilename(name = "") { return String(name).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim(); }
function iso(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.toISOString === "function") return value.toISOString();
  return String(value);
}
function filenameFromUrl(url = "") {
  try {
    const parsed = /^https?:\/\//i.test(url) ? new URL(url) : null;
    return path.basename(parsed ? parsed.pathname : String(url).split("?")[0]) || "image";
  } catch {
    return path.basename(String(url).split("?")[0]) || "image";
  }
}
function isImageAsset(row = {}) {
  const contentType = String(row.content_type || row.contentType || "").toLowerCase();
  const value = String(row.filename || row.url || "").toLowerCase().split("?")[0];
  return contentType.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg)$/.test(value);
}
function normalizeAsset(row = {}, stats = null) {
  const url = String(row.url || "").trim();
  if (!url) return null;
  const filename = row.filename || filenameFromUrl(url);
  const title = row.title || row.display_name || titleFromFilename(filename);
  const size = Number(row.size_bytes || stats?.size || row.metadata?.size_bytes || row.metadata?.size || 0);
  return {
    name: filename,
    filename,
    url,
    src: url,
    title,
    display_name: row.display_name || row.title || title,
    displayName: row.display_name || row.title || title,
    contentType: row.content_type || null,
    content_type: row.content_type || null,
    size,
    size_bytes: size,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at || stats?.mtime),
    metadata: row.metadata || {},
    hasMetadata: Boolean(row.url),
    fileExists: Boolean(stats),
  };
}
async function readMetadataRows() {
  try {
    const pool = getPostgresPool();
    if (!pool) return [];
    const { rows } = await pool.query("SELECT filename, url, title, display_name, content_type, size_bytes, metadata, created_at, updated_at FROM form_media_assets");
    return rows || [];
  } catch (err) {
    adminRuntimeLogger.warn("runtime_warning", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return [];
  }
}

async function deleteMetadata(url) {
  const pool = getPostgresPool();
  if (!pool) return;
  await pool.query("DELETE FROM form_media_assets WHERE url = $1", [url]);
}

async function upsertMetadata({ filename, url, title, displayName, contentType, size }) {
  const pool = getPostgresPool();
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO form_media_assets (filename, url, title, display_name, content_type, size_bytes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (url) DO UPDATE SET
       filename = EXCLUDED.filename,
       title = COALESCE(EXCLUDED.title, form_media_assets.title),
       display_name = COALESCE(EXCLUDED.display_name, form_media_assets.display_name),
       content_type = COALESCE(EXCLUDED.content_type, form_media_assets.content_type),
       size_bytes = COALESCE(EXCLUDED.size_bytes, form_media_assets.size_bytes),
       updated_at = NOW()
     RETURNING filename, url, title, display_name, content_type, size_bytes, metadata, created_at, updated_at`,
    [filename, url, title || null, displayName || title || null, contentType || null, Number.isFinite(Number(size)) ? Number(size) : null]
  );
  return rows[0] || null;
}
async function listFiles() {
  const storage = await getStorage();
  const [names, metadataRows] = await Promise.all([storage.list(), readMetadataRows()]);
  const byUrl = new Map();
  const metadataByUrl = new Map(metadataRows.filter(isImageAsset).map((row) => [row.url, row]));
  for (const name of names) {
    if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(name)) continue;
    const head = await storage.head(name).catch(() => null);
    const s = head ? { size: head.size, mtime: head.updatedAt } : null;
    const url = `${PUBLIC_PREFIX}/${name}`;
    const item = normalizeAsset({ ...(metadataByUrl.get(url) || {}), filename: name, url }, s);
    if (item) byUrl.set(url, item);
  }
  for (const row of metadataRows) {
    if (!isImageAsset(row) || !row.url || byUrl.has(row.url)) continue;
    let fileStat = null;
    if (String(row.url).startsWith(`${PUBLIC_PREFIX}/`)) {
      const head = await storage.head(path.basename(row.url)).catch(() => null);
      fileStat = head ? { size: head.size, mtime: head.updatedAt } : null;
    }
    const item = normalizeAsset(row, fileStat);
    if (item) byUrl.set(item.url, item);
  }
  return [...byUrl.values()].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

export async function GET() {
  const user = await requireAdmin(); if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, media: await listFiles() });
}

export async function POST(request) {
  const user = await requireAdmin(); if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  if (!ALLOWED.has(file.type)) return NextResponse.json({ error: "Only PNG, JPG, WEBP, GIF, and SVG images are allowed" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Image must be 5MB or smaller" }, { status: 400 });
  const ext = ALLOWED.get(file.type);
  const filename = `${safeBase(file.name)}-${Date.now().toString(36)}${ext}`;
  const storage = await getStorage();
  const buffer = Buffer.from(await file.arrayBuffer());
  const saved = await storage.put(filename, buffer, file.type);
  const url = saved.url;
  await upsertMetadata({ filename: saved.filename || filename, url, title: titleFromFilename(file.name), displayName: titleFromFilename(file.name), contentType: file.type, size: file.size }).catch((err) => adminRuntimeLogger.warn("runtime_warning", { ...runtimePayload({ error: err }) }));
  return NextResponse.json({ ok: true, media: { name: filename, filename, url, src: url, title: titleFromFilename(file.name), display_name: titleFromFilename(file.name), size: file.size, size_bytes: file.size, contentType: file.type, content_type: file.type }, mediaList: await listFiles() });
}

export async function PATCH(request) {
  const user = await requireAdmin(); if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const url = String(body.url || "").trim();
  const title = String(body.title || body.display_name || "").trim();
  const isLocal = url.startsWith(`${PUBLIC_PREFIX}/`);
  const isRemote = /^https?:\/\//i.test(url);
  if (!isLocal && !isRemote) return NextResponse.json({ error: "Invalid media URL" }, { status: 400 });
  const filename = filenameFromUrl(url);
  if (!filename || filename.includes("..")) return NextResponse.json({ error: "Invalid media URL" }, { status: 400 });
  let s = null;
  if (isLocal) {
    const storage = await getStorage();
    const head = await storage.head(filename).catch(() => null);
    s = head ? { size: head.size, mtime: head.updatedAt } : null;
  }
  try {
    const row = await upsertMetadata({ filename, url, title: title || titleFromFilename(filename), displayName: title || titleFromFilename(filename), size: s?.size });
    return NextResponse.json({ ok: true, media: normalizeAsset(row || { filename, url, title }, s) });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Metadata update failed" }, { status: 500 });
  }
}

export async function DELETE(request) {
  const user = await requireAdmin(); if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const url = String(body.url || "").trim();
  if (!url) return NextResponse.json({ error: "Media URL is required" }, { status: 400 });
  const isLocal = url.startsWith(`${PUBLIC_PREFIX}/`);
  const isRemote = /^https?:\/\//i.test(url);
  if (!isLocal && !isRemote) return NextResponse.json({ error: "Invalid media URL" }, { status: 400 });

  const filename = filenameFromUrl(url);
  if (!filename || filename.includes("..")) return NextResponse.json({ error: "Invalid media URL" }, { status: 400 });
  if (isLocal) {
    const storage = await getStorage();
    await storage.remove(filename);
  }
  await deleteMetadata(url);
  return NextResponse.json({ ok: true, mediaList: await listFiles() });
}
