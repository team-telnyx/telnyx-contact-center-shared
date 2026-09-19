import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildFormExportBundle, collectFormMediaReferences, formExportFilename } from "@/lib/forms/form-bundles";
import { withPermission } from "@/lib/authz/guard";

function mapRow(row) { return row ? { ...row, queue_ids: row.queue_ids || [], queue_names: row.queue_names || [] } : null; }

async function GET_handler(request, context, authz) {
  const user = authz.user;
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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("forms:export", GET_handler, { route: "/api/admin/forms/[id]/export" });
