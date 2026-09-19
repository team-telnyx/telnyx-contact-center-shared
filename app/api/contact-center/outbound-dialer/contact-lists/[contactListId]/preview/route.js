import { NextResponse } from "next/server";
import { getOutboundPool, jsonError } from "@/lib/outbound-dialer/api";
import { withPermission } from "@/lib/authz/guard";

async function GET_handler(request, context, authz) {
  const user = authz.user;
  const { contactListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows: listRows } = await pool.query(`SELECT id, name, custom_field_schema, metadata FROM outbound_contact_lists WHERE id=$1 AND status <> 'archived'`, [contactListId]);
  if (!listRows[0]) return jsonError("Contact list not found", 404);
  const { rows } = await pool.query(`SELECT row_data FROM outbound_contact_records WHERE contact_list_id=$1 ORDER BY created_at ASC LIMIT 10`, [contactListId]);
  const metadataColumns = listRows[0].metadata?.csv_import_settings?.selected_columns || [];
  const schemaColumns = Array.isArray(listRows[0].custom_field_schema) ? listRows[0].custom_field_schema.map((field) => field?.name).filter(Boolean) : [];
  const rowColumns = [...new Set(rows.flatMap((row) => Object.keys(row.row_data || {})))];
  const columns = (metadataColumns.length ? metadataColumns : schemaColumns.length ? schemaColumns : rowColumns).filter((column) => rowColumns.includes(column) || metadataColumns.includes(column) || schemaColumns.includes(column));
  const records = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row.row_data?.[column] ?? ""])));
  return NextResponse.json({ ok: true, readOnly: true, source: "database", columns, records, totalPreviewRows: records.length });
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("contact_lists:read", GET_handler, { route: "/api/contact-center/outbound-dialer/contact-lists/[contactListId]/preview" });
