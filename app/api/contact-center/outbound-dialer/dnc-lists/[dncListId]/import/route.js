import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapDncList, parseCsv, requireOutboundSupervisor, usernameFor } from "@/lib/outbound-dialer/api";
import { applyCsvImportRules, normalizeCsvImportRules } from "@/lib/outbound-dialer/csv-import-rules";

export async function POST(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { dncListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const { headers, records, truncated } = parseCsv(body.csv || "", 10000);
    if (!headers.length) return jsonError("CSV header row is required", 400);
    if (!records.length) return jsonError("CSV contains no records", 400);

    const requestedColumns = Array.isArray(body.metadata?.selected_columns) ? body.metadata.selected_columns : [];
    const selectedColumns = requestedColumns.map((column) => String(column || "").trim()).filter((column) => headers.includes(column));
    if (!selectedColumns.length) return jsonError("Select at least one DNC CSV column before importing", 400);

    const rules = normalizeCsvImportRules(headers, body.metadata || {});
    const applied = applyCsvImportRules(records, headers, body.metadata || {});
    const selectedRecords = applied.records
      .map((record) => Object.fromEntries(selectedColumns.map((column) => [column, record[column] || ""])))
      .filter((record) => selectedColumns.some((column) => String(record[column] || "").trim()));
    if (!selectedRecords.length) return jsonError("Selected DNC columns contain no importable values after filters and duplicate rules", 400);

    const metadata = {
      csv_import_settings: {
        ...(body.metadata || {}),
        selected_columns: selectedColumns,
        no_duplicate_columns: rules.no_duplicate_columns,
        column_filters: rules.column_filters,
        source_file_name: body.metadata?.source_file_name || null,
        updated_at: new Date().toISOString(),
      },
      last_import_at: new Date().toISOString(),
      last_import_headers: headers,
      last_import_selected_columns: selectedColumns,
      last_import_preview: selectedRecords.slice(0, 3),
      last_import_original_rows: records.length,
      last_import_filtered_rows: applied.filteredRows,
      last_import_duplicate_rows_rejected: applied.duplicateRowsRejected,
      last_import_truncated: truncated,
    };
    const { rows } = await pool.query(`UPDATE outbound_dnc_lists SET record_count=$1, metadata=COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_by=$3, updated_at=NOW() WHERE id=$4 AND status <> 'archived' RETURNING *`, [selectedRecords.length, JSON.stringify(metadata), usernameFor(user), dncListId]);
    if (!rows[0]) return jsonError("DNC list not found", 404);
    return NextResponse.json({ ok: true, totalRows: selectedRecords.length, originalRows: records.length, filteredRows: applied.filteredRows, duplicateRowsRejected: applied.duplicateRowsRejected, dncList: mapDncList(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] DNC CSV import error:", err); return jsonError(err.message || "Failed to import DNC CSV", 400); }
}
