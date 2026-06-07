import { NextResponse } from "next/server";
import {
  allowedSuppressionTypesForStrategy,
  classifySuppressionColumn,
  getOutboundPool,
  isDncColumnAllowed,
  jsonError,
  mapDncList,
  normalizeDncValue,
  parseCsv,
  requireOutboundSupervisor,
  usernameFor,
} from "@/lib/outbound-dialer/api";
import { applyCsvImportRules, normalizeCsvImportRules } from "@/lib/outbound-dialer/csv-import-rules";
import { importsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";

function valueTypesForColumn(classification, strategy) {
  const allowed = allowedSuppressionTypesForStrategy(strategy);
  return allowed.filter((type) => (type === "phone" ? classification.is_phone : classification.is_email));
}

export async function POST(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { dncListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const { headers, records, truncated } = parseCsv(body.csv || "", 10000);
    if (!headers.length) return jsonError("CSV header row is required", 400);
    if (!records.length) return jsonError("CSV contains no records", 400);

    const { rows: listRows } = await pool.query(`SELECT * FROM outbound_dnc_lists WHERE id=$1 AND status <> 'archived'`, [dncListId]);
    const dncList = listRows[0];
    if (!dncList) return jsonError("DNC list not found", 404);
    const strategy = dncList.match_strategy || "phone";

    const requestedColumns = Array.isArray(body.metadata?.selected_columns) ? body.metadata.selected_columns : [];
    const selectedColumns = requestedColumns.map((column) => String(column || "").trim()).filter((column) => headers.includes(column));
    if (!selectedColumns.length) return jsonError("Select at least one DNC CSV column before importing", 400);

    const rules = normalizeCsvImportRules(headers, body.metadata || {});
    const applied = applyCsvImportRules(records, headers, body.metadata || {});
    const classifications = Object.fromEntries(headers.map((column) => [column, classifySuppressionColumn(applied.records, column)]));
    const invalidColumns = selectedColumns.filter((column) => !isDncColumnAllowed(classifications[column], strategy));
    if (invalidColumns.length) return jsonError(`Selected DNC columns are not valid for ${strategy}: ${invalidColumns.join(", ")}`, 400, { invalidColumns, classifications });

    const seen = new Set();
    const entries = [];
    const valueTypeCounts = { phone: 0, email: 0 };
    let rawValuesSeen = 0;
    let duplicateValuesRejected = 0;
    for (const record of applied.records) {
      for (const column of selectedColumns) {
        const original = String(record[column] || "").trim();
        if (!original) continue;
        rawValuesSeen += 1;
        for (const valueType of valueTypesForColumn(classifications[column], strategy)) {
          const normalized = normalizeDncValue(original, valueType);
          if (!normalized) continue;
          const key = `${valueType}\u001f${normalized}`;
          if (seen.has(key)) { duplicateValuesRejected += 1; continue; }
          seen.add(key);
          valueTypeCounts[valueType] += 1;
          entries.push({ valueType, original, normalized, sourceColumn: column, rowData: Object.fromEntries(selectedColumns.map((key) => [key, record[key] ?? ""])), sourceSnapshot: record });
        }
      }
    }
    if (!entries.length) return jsonError("Selected DNC columns contain no valid phone/email values after filters and duplicate rules", 400, { classifications });

    const metadata = {
      csv_import_settings: {
        ...(body.metadata || {}),
        selected_columns: selectedColumns,
        no_duplicate_columns: rules.no_duplicate_columns,
        column_filters: rules.column_filters,
        source_file_name: body.metadata?.source_file_name || null,
        match_strategy: strategy,
        column_classifications: classifications,
        updated_at: new Date().toISOString(),
      },
      last_import_at: new Date().toISOString(),
      last_import_source_file_name: body.metadata?.source_file_name || null,
      last_import_selected_columns: selectedColumns,
      last_import_filters: rules.column_filters,
      last_import_no_duplicate_columns: rules.no_duplicate_columns,
      last_import_original_rows: records.length,
      last_import_filtered_rows: applied.filteredRows,
      last_import_duplicate_rows_rejected: applied.duplicateRowsRejected,
      last_import_duplicate_values_rejected: duplicateValuesRejected,
      last_import_raw_values_seen: rawValuesSeen,
      last_import_unique_entries: entries.length,
      last_import_value_type_counts: valueTypeCounts,
      last_import_truncated: truncated,
    };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM outbound_dnc_entries WHERE dnc_list_id=$1`, [dncListId]);
      for (const entry of entries) {
        await client.query(
          `INSERT INTO outbound_dnc_entries (dnc_list_id, value_type, original_value, normalized_value, source_column, row_data, source_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (dnc_list_id, value_type, normalized_value) DO NOTHING`,
          [dncListId, entry.valueType, entry.original, entry.normalized, entry.sourceColumn, JSON.stringify(entry.rowData), JSON.stringify(entry.sourceSnapshot)]
        );
      }
      const { rows } = await client.query(`UPDATE outbound_dnc_lists SET record_count=$1, metadata=COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_by=$3, updated_at=NOW() WHERE id=$4 AND status <> 'archived' RETURNING *`, [entries.length, JSON.stringify(metadata), usernameFor(user), dncListId]);
      await client.query("COMMIT");
      return NextResponse.json({ ok: true, totalRows: entries.length, originalRows: records.length, filteredRows: applied.filteredRows, duplicateRowsRejected: applied.duplicateRowsRejected, duplicateValuesRejected, valueTypeCounts, dncList: mapDncList(rows[0]) });
    } catch (err) { await client.query("ROLLBACK"); throw err; }
    finally { client.release(); }
  } catch (err) { importsLogger.error("dnc_import_failed", { dncListId, ...outboundErrorPayload(err) }); return jsonError(err.message || "Failed to import DNC CSV", 400); }
}
