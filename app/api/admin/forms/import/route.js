import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { extractBundleMediaAssets, normalizeImportedForm } from "@/lib/forms/form-bundles";
import { slugifyFormName } from "@/lib/forms/form-schema";

export const dynamic = "force-dynamic";

async function requireAdmin() {
  const session = await getServerSession(authOptions); const id = session?.user?.id || null; const email = session?.user?.email || null; if (!id && !email) return null;
  let user = id ? await PgDb.findUserById(id) : null; if (!user && email) user = await PgDb.findUserByUsername(email); return user && isAdmin(user) ? user : null;
}
function mapRow(row) { return row ? { ...row, queue_ids: row.queue_ids || [], queue_names: row.queue_names || [] } : null; }
function filenameFromUrl(url = "") {
  try { return (/^https?:\/\//i.test(url) ? new URL(url).pathname : String(url).split("?")[0]).split("/").pop() || "image"; }
  catch { return String(url).split("?")[0].split("/").pop() || "image"; }
}
async function makeUniqueSlug(pool, base) {
  const root = slugifyFormName(base || "imported-form") || "imported-form";
  let slug = root;
  for (let i = 2; i < 1000; i += 1) {
    const { rows } = await pool.query("SELECT 1 FROM form_definitions WHERE slug = $1 LIMIT 1", [slug]);
    if (!rows.length) return slug;
    slug = `${root}-${i}`;
  }
  return `${root}-${Date.now().toString(36)}`;
}
async function upsertImportedMedia(pool, mediaAssets = []) {
  const imported = [];
  for (const asset of mediaAssets) {
    const url = String(asset.url || asset.publicUrl || asset.public_url || "").trim();
    if (!url || url.startsWith("data:")) continue;
    const filename = String(asset.filename || filenameFromUrl(url) || "image").slice(0, 240);
    const title = asset.title || asset.displayName || asset.display_name || filename.replace(/\.[^.]+$/, "");
    const contentType = asset.contentType || asset.content_type || null;
    const sizeBytes = Number(asset.sizeBytes ?? asset.size_bytes ?? asset.size ?? 0);
    const metadata = { ...(asset.metadata && typeof asset.metadata === "object" ? asset.metadata : {}), importedFromFormBundle: true, binaryIncluded: false };
    const { rows } = await pool.query(
      `INSERT INTO form_media_assets (filename, url, title, display_name, content_type, size_bytes, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
       ON CONFLICT (url) DO UPDATE SET
         filename = COALESCE(EXCLUDED.filename, form_media_assets.filename),
         title = COALESCE(EXCLUDED.title, form_media_assets.title),
         display_name = COALESCE(EXCLUDED.display_name, form_media_assets.display_name),
         content_type = COALESCE(EXCLUDED.content_type, form_media_assets.content_type),
         size_bytes = COALESCE(EXCLUDED.size_bytes, form_media_assets.size_bytes),
         metadata = form_media_assets.metadata || EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING url`,
      [filename, url, title || null, asset.displayName || asset.display_name || title || null, contentType, Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : null, JSON.stringify(metadata)]
    );
    if (rows[0]?.url) imported.push(rows[0].url);
  }
  return imported;
}

export async function POST(request) {
  const user = await requireAdmin(); if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool(); if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json();
    const sourceName = body?.form?.name || body?.name || "Imported agent form";
    const uniqueSlug = await makeUniqueSlug(pool, `${slugifyFormName(sourceName)}-imported`);
    const { form, validation } = normalizeImportedForm(body, { slug: uniqueSlug });
    if (!validation.ok) return NextResponse.json({ error: "Invalid form import", details: validation.errors }, { status: 400 });
    const username = user.username || user.email || "system";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const importedMediaUrls = await upsertImportedMedia(client, extractBundleMediaAssets(body));
      const { rows } = await client.query(
        `INSERT INTO form_definitions (name, slug, description, category, status, version, schema, layout, theme, bindings, actions, queue_ids, queue_names, auto_open, created_by, updated_by, published_at)
         VALUES ($1,$2,$3,$4,'draft',1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,NULL)
         RETURNING *`,
        [form.name, form.slug, form.description, form.category, JSON.stringify(form.schema), JSON.stringify(form.layout), JSON.stringify(form.theme), JSON.stringify(form.bindings), JSON.stringify(form.actions), form.queue_ids || [], form.queue_names || [], form.auto_open, username]
      );
      await client.query("COMMIT");
      return NextResponse.json({ ok: true, form: mapRow(rows[0]), importedMediaCount: importedMediaUrls.length, mediaBehavior: "Imported media is re-registered as metadata/URL references only; no binary/base64 data is required or stored." });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[Admin Forms] import error:", err);
    return NextResponse.json({ error: err?.message || "Import failed" }, { status: 400 });
  }
}
