import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { buildFormExportBundle, collectFormMediaReferences, formExportFilename } from "@/lib/forms/form-bundles";

async function requireAdmin() {
  const session = await getServerSession(authOptions); const id = session?.user?.id || null; const email = session?.user?.email || null; if (!id && !email) return null;
  let user = id ? await PgDb.findUserById(id) : null; if (!user && email) user = await PgDb.findUserByUsername(email); return user && isAdmin(user) ? user : null;
}
function mapRow(row) { return row ? { ...row, queue_ids: row.queue_ids || [], queue_names: row.queue_names || [] } : null; }

export async function GET(request, context) {
  const user = await requireAdmin(); if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params; const pool = getPostgresPool(); if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const { rows } = await pool.query("SELECT * FROM form_definitions WHERE id = $1", [id]);
  const form = mapRow(rows[0]);
  if (!form) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const refs = collectFormMediaReferences(form);
  let mediaRows = [];
  if (refs.length) {
    const { rows: assets } = await pool.query(
      "SELECT filename, url, title, display_name, content_type, size_bytes, metadata, created_at, updated_at FROM form_media_assets WHERE url = ANY($1::text[])",
      [refs.map((ref) => ref.url)]
    );
    mediaRows = assets || [];
  }
  const bundle = buildFormExportBundle(form, mediaRows, { metadata: { exportedBy: user.username || user.email || user.id || null } });
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${formExportFilename(form)}"`,
      "Cache-Control": "no-store",
    },
  });
}
