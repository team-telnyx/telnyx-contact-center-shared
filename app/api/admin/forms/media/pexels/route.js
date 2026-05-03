import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { isAdmin } from "@/lib/role-utils";

const PEXELS_API = "https://api.pexels.com/v1";
const MEDIA_DIR = path.join(process.cwd(), "public", "media");
const PUBLIC_PREFIX = "/media";
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = id ? await PgDb.findUserById(id) : null;
  if (!user && email) user = await PgDb.findUserByUsername(email);
  return user && isAdmin(user) ? user : null;
}

function apiKey() {
  return process.env.PEXELS_API_KEY || "";
}

function safeBase(name = "pexels-image") {
  return String(name)
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "pexels-image";
}

function normalizePhoto(photo) {
  return {
    id: photo.id,
    title: photo.alt || `Pexels photo ${photo.id}`,
    alt: photo.alt || "",
    photographer: photo.photographer || "Pexels photographer",
    photographer_url: photo.photographer_url || "",
    pexels_url: photo.url || "",
    width: photo.width,
    height: photo.height,
    src: {
      tiny: photo.src?.tiny,
      small: photo.src?.small,
      medium: photo.src?.medium,
      large: photo.src?.large,
      original: photo.src?.original,
    },
  };
}

async function pexelsFetch(pathname) {
  const key = apiKey();
  if (!key) return { response: null, error: NextResponse.json({ ok: false, error: "PEXELS_API_KEY is not configured" }, { status: 503 }) };
  const response = await fetch(`${PEXELS_API}${pathname}`, {
    headers: { Authorization: key },
    cache: "no-store",
  });
  return { response };
}

async function upsertMetadata({ filename, url, title, displayName, contentType, size, metadata }) {
  const pool = getPostgresPool();
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO form_media_assets (filename, url, title, display_name, content_type, size_bytes, metadata, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
     ON CONFLICT (url) DO UPDATE SET
       filename = EXCLUDED.filename,
       title = COALESCE(EXCLUDED.title, form_media_assets.title),
       display_name = COALESCE(EXCLUDED.display_name, form_media_assets.display_name),
       content_type = COALESCE(EXCLUDED.content_type, form_media_assets.content_type),
       size_bytes = COALESCE(EXCLUDED.size_bytes, form_media_assets.size_bytes),
       metadata = form_media_assets.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING filename, url, title, display_name, content_type, size_bytes, metadata, created_at, updated_at`,
    [filename, url, title || null, displayName || title || null, contentType || null, Number.isFinite(Number(size)) ? Number(size) : null, JSON.stringify(metadata || {})]
  );
  return rows[0] || null;
}

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const query = String(searchParams.get("query") || "").trim();
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const perPage = Math.max(1, Math.min(80, Number(searchParams.get("perPage") || 40)));
  if (query.length < 2) return NextResponse.json({ ok: false, error: "Search query must be at least 2 characters" }, { status: 400 });

  try {
    const { response, error } = await pexelsFetch(`/search?query=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}&orientation=landscape`);
    if (error) return error;
    if (!response.ok) {
      const status = response.status === 429 ? 429 : 502;
      return NextResponse.json({ ok: false, error: response.status === 429 ? "Pexels rate limit reached. Please try again later." : "Pexels search failed" }, { status });
    }
    const data = await response.json();
    return NextResponse.json({ ok: true, photos: (data.photos || []).map(normalizePhoto), page: data.page, per_page: data.per_page, total_results: data.total_results, next_page: data.next_page || null });
  } catch (err) {
    console.error("[forms/media/pexels] search error:", err);
    return NextResponse.json({ ok: false, error: "Pexels search failed" }, { status: 500 });
  }
}

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const photoId = Number(body.photoId || body.id);
  if (!Number.isFinite(photoId) || photoId <= 0) return NextResponse.json({ ok: false, error: "A valid Pexels photoId is required" }, { status: 400 });

  try {
    const { response, error } = await pexelsFetch(`/photos/${photoId}`);
    if (error) return error;
    if (!response.ok) {
      const status = response.status === 429 ? 429 : 502;
      return NextResponse.json({ ok: false, error: response.status === 429 ? "Pexels rate limit reached. Please try again later." : "Pexels photo lookup failed" }, { status });
    }
    const photo = normalizePhoto(await response.json());
    const imageUrl = photo.src.large || photo.src.medium || photo.src.small;
    if (!imageUrl || !/^https:\/\/images\.pexels\.com\//.test(imageUrl)) {
      return NextResponse.json({ ok: false, error: "Pexels photo does not include a downloadable image URL" }, { status: 502 });
    }

    const imageResponse = await fetch(imageUrl, { cache: "no-store" });
    if (!imageResponse.ok) return NextResponse.json({ ok: false, error: "Pexels image download failed" }, { status: 502 });
    const contentType = String(imageResponse.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (!ALLOWED.has(contentType)) return NextResponse.json({ ok: false, error: "Pexels returned an unsupported image type" }, { status: 502 });
    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    if (buffer.length > MAX_BYTES) return NextResponse.json({ ok: false, error: "Pexels image is larger than the 5MB media limit" }, { status: 413 });

    await mkdir(MEDIA_DIR, { recursive: true });
    const ext = ALLOWED.get(contentType);
    const filename = `${safeBase(`${photo.title}-${photo.id}`)}-${Date.now().toString(36)}${ext}`;
    const fullPath = path.join(MEDIA_DIR, filename);
    if (!fullPath.startsWith(MEDIA_DIR)) return NextResponse.json({ ok: false, error: "Invalid filename" }, { status: 400 });
    await writeFile(fullPath, buffer);

    const url = `${PUBLIC_PREFIX}/${filename}`;
    const title = photo.title || `Pexels photo ${photo.id}`;
    const metadata = {
      source: "pexels",
      pexels_photo_id: photo.id,
      pexels_url: photo.pexels_url,
      photographer: photo.photographer,
      photographer_url: photo.photographer_url,
      downloaded_from: imageUrl,
      license_url: "https://www.pexels.com/license/",
    };
    const row = await upsertMetadata({ filename, url, title, displayName: title, contentType, size: buffer.length, metadata });
    const media = { name: filename, filename, url, title, display_name: title, size: buffer.length, size_bytes: buffer.length, contentType, content_type: contentType, metadata: row?.metadata || metadata };
    return NextResponse.json({ ok: true, media, photo });
  } catch (err) {
    console.error("[forms/media/pexels] download error:", err);
    return NextResponse.json({ ok: false, error: "Pexels download failed" }, { status: 500 });
  }
}
