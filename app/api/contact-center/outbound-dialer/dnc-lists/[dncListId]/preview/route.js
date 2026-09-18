import { NextResponse } from "next/server";
import { getOutboundPool, jsonError } from "@/lib/outbound-dialer/api";
import { withPermission } from "@/lib/authz/guard";

async function GET_handler(request, context, authz) {
  const user = authz.user;
  const { dncListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows: listRows } = await pool.query(`SELECT id, name, metadata FROM outbound_dnc_lists WHERE id=$1 AND status <> 'archived'`, [dncListId]);
  if (!listRows[0]) return jsonError("DNC list not found", 404);
  const { rows } = await pool.query(`SELECT value_type, original_value, normalized_value, source_column, row_data, created_at FROM outbound_dnc_entries WHERE dnc_list_id=$1 ORDER BY created_at ASC LIMIT 10`, [dncListId]);
  const importedColumns = listRows[0].metadata?.csv_import_settings?.selected_columns || [];
  const columns = ["value_type", "original_value", "normalized_value", "source_column", ...importedColumns.filter(Boolean)];
  const records = rows.map((row) => ({
    value_type: row.value_type,
    original_value: row.original_value,
    normalized_value: row.normalized_value,
    source_column: row.source_column || "",
    ...Object.fromEntries(importedColumns.map((column) => [column, row.row_data?.[column] ?? ""])),
  }));
  return NextResponse.json({ ok: true, readOnly: true, source: "database", columns: [...new Set(columns)], records, totalPreviewRows: records.length });
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("dnc_lists:read", GET_handler, { route: "/api/contact-center/outbound-dialer/dnc-lists/[dncListId]/preview" });
