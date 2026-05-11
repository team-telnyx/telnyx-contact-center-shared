import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapDncList, parseCsv, requireOutboundSupervisor, usernameFor } from "@/lib/outbound-dialer/api";

export async function POST(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { dncListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const { headers, records, truncated } = parseCsv(body.csv || "", 10000);
    if (!headers.length) return jsonError("CSV header row is required", 400);
    if (!records.length) return jsonError("CSV contains no records", 400);
    const metadata = {
      import_scaffold: true,
      last_import_at: new Date().toISOString(),
      last_import_headers: headers,
      last_import_preview: records.slice(0, 3),
      last_import_truncated: truncated,
      note: "DNC row-level suppression enforcement is scaffolded; this import persists metadata and row count only.",
    };
    const { rows } = await pool.query(`UPDATE outbound_dnc_lists SET record_count=$1, metadata=COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_by=$3, updated_at=NOW() WHERE id=$4 AND status <> 'archived' RETURNING *`, [records.length, JSON.stringify(metadata), usernameFor(user), dncListId]);
    if (!rows[0]) return jsonError("DNC list not found", 404);
    return NextResponse.json({ ok: true, totalRows: records.length, dncList: mapDncList(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] DNC CSV import error:", err); return jsonError(err.message || "Failed to import DNC CSV", 400); }
}
