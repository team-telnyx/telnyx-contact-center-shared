import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
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
async function listFiles() {
  await mkdir(MEDIA_DIR, { recursive: true });
  const names = await readdir(MEDIA_DIR);
  const rows = [];
  for (const name of names) {
    if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(name)) continue;
    const s = await stat(path.join(MEDIA_DIR, name));
    rows.push({ name, url: `${PUBLIC_PREFIX}/${name}`, size: s.size, updated_at: s.mtime.toISOString() });
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
  return NextResponse.json({ ok: true, media: { name: filename, url: `${PUBLIC_PREFIX}/${filename}`, size: file.size, contentType: file.type }, mediaList: await listFiles() });
}
