import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { isAdmin } from "@/lib/role-utils";
import { mkdir, readdir, stat, writeFile } from "fs/promises";
import path from "path";

const MEDIA_DIR = path.join(process.cwd(), "public", "media");
const PUBLIC_PREFIX = "/media";
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Map([["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/webp", ".webp"], ["image/gif", ".gif"], ["image/svg+xml", ".svg"]]);

async function requireAdmin() {
  const session = await getServerSession(authOptions); const id = session?.user?.id || null; const email = session?.user?.email || null; if (!id && !email) return null;
  let user = id ? await PgDb.findUserById(id) : null; if (!user && email) user = await PgDb.findUserByUsername(email); return user && isAdmin(user) ? user : null;
}
function safeBase(name = "image") { return String(name).toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "image"; }
function titleFromFilename(name = "") { return String(name).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim(); }
async function readMetadataByUrl() {
  try {
    const pool = getPostgresPool();
    if (!pool) return new Map();
    const { rows } = await pool.query("SELECT filename, url, title, display_name, content_type, size_bytes, metadata, created_at, updated_at FROM form_media_assets");
    return new Map(rows.map((row) => [row.url, row]));
  } catch (err) {
    console.warn("[forms/media] metadata unavailable:", err?.message || err);
    return new Map();
  }
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
     RETURNING filename, url, title, display_name, content_type, size_bytes, created_at, updated_at`,
    [filename, url, title || null, displayName || title || null, contentType || null, Number.isFinite(Number(size)) ? Number(size) : null]
  );
  return rows[0] || null;
}
async function listFiles() {
  await mkdir(MEDIA_DIR, { recursive: true });
  const [names, metadataByUrl] = await Promise.all([readdir(MEDIA_DIR), readMetadataByUrl()]);
  const rows = [];
  for (const name of names) {
    if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(name)) continue;
    const s = await stat(path.join(MEDIA_DIR, name));
    const url = `${PUBLIC_PREFIX}/${name}`;
    const meta = metadataByUrl.get(url) || {};
    rows.push({
      name,
      filename: name,
      url,
      title: meta.title || meta.display_name || titleFromFilename(name),
      display_name: meta.display_name || meta.title || titleFromFilename(name),
      contentType: meta.content_type || null,
      content_type: meta.content_type || null,
      size: Number(meta.size_bytes || s.size || 0),
      size_bytes: Number(meta.size_bytes || s.size || 0),
      created_at: meta.created_at || null,
      updated_at: (meta.updated_at || s.mtime).toISOString ? (meta.updated_at || s.mtime).toISOString() : String(meta.updated_at || s.mtime),
      metadata: meta.metadata || {},
      hasMetadata: Boolean(meta.url),
    });
  }
  return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
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
  await mkdir(MEDIA_DIR, { recursive: true });
  const ext = ALLOWED.get(file.type);
  const filename = `${safeBase(file.name)}-${Date.now().toString(36)}${ext}`;
  const fullPath = path.join(MEDIA_DIR, filename);
  if (!fullPath.startsWith(MEDIA_DIR)) return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  await writeFile(fullPath, Buffer.from(await file.arrayBuffer()));
  const url = `${PUBLIC_PREFIX}/${filename}`;
  await upsertMetadata({ filename, url, title: titleFromFilename(file.name), displayName: titleFromFilename(file.name), contentType: file.type, size: file.size }).catch((err) => console.warn("[forms/media] metadata write failed:", err?.message || err));
  return NextResponse.json({ ok: true, media: { name: filename, filename, url, title: titleFromFilename(file.name), display_name: titleFromFilename(file.name), size: file.size, size_bytes: file.size, contentType: file.type, content_type: file.type }, mediaList: await listFiles() });
}

export async function PATCH(request) {
  const user = await requireAdmin(); if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const url = String(body.url || "").trim();
  const title = String(body.title || body.display_name || "").trim();
  if (!url.startsWith(`${PUBLIC_PREFIX}/`)) return NextResponse.json({ error: "Only local form media can be edited" }, { status: 400 });
  const filename = path.basename(url);
  if (!filename || filename.includes("..")) return NextResponse.json({ error: "Invalid media URL" }, { status: 400 });
  const fullPath = path.join(MEDIA_DIR, filename);
  if (!fullPath.startsWith(MEDIA_DIR)) return NextResponse.json({ error: "Invalid media URL" }, { status: 400 });
  const s = await stat(fullPath).catch(() => null);
  if (!s) return NextResponse.json({ error: "Media file not found" }, { status: 404 });
  try {
    const row = await upsertMetadata({ filename, url, title: title || titleFromFilename(filename), displayName: title || titleFromFilename(filename), size: s.size });
    return NextResponse.json({ ok: true, media: row });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Metadata update failed" }, { status: 500 });
  }
}
