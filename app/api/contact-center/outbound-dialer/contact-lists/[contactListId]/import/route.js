import { NextResponse } from "next/server";
import { getOutboundPool, isLikelyPhone, jsonError, normalizeFieldSchema, parseCsv, requireOutboundSupervisor, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { OUTBOUND_CONTACT_FIELD_TYPES } from "@/lib/outbound-dialer/schema";
import { applyCsvImportRules, normalizeCsvImportRules } from "@/lib/outbound-dialer/csv-import-rules";
const CONTACT_MAPPING_PREFIXES = ["number:", "email:", "whatsapp:"];
const CALLABLE_MAPPING_PREFIXES = ["number:", "whatsapp:"];

function isValidContactMapping(value) {
  return CONTACT_MAPPING_PREFIXES.some((prefix) => String(value || "").startsWith(prefix));
}

function selectedMappedColumns(selectedColumns, columnMappings, prefixes = CONTACT_MAPPING_PREFIXES) {
  return selectedColumns.filter((column) => (columnMappings[column] || []).some((value) => prefixes.some((prefix) => String(value || "").startsWith(prefix))));
}

function inferFieldType(name, mappedValues = [], explicitType) {
  if (OUTBOUND_CONTACT_FIELD_TYPES.includes(explicitType)) return explicitType;
  if (mappedValues.some((value) => String(value).startsWith("email:"))) return "email";
  if (mappedValues.some((value) => String(value).startsWith("number:") || String(value).startsWith("whatsapp:"))) return "phone";
  const lower = String(name || "").toLowerCase();
  if (lower.includes("email")) return "email";
  if (lower.includes("phone") || lower.includes("mobile") || lower.includes("number") || lower.includes("whatsapp")) return "phone";
  if (lower.includes("date")) return "date";
  return "text";
}

function buildImportSchema(selectedColumns, columnMappings, importSettings) {
  const explicit = new Map(normalizeFieldSchema(importSettings.field_schema || importSettings.custom_field_schema || []).map((field) => [field.name, field]));
  return normalizeFieldSchema(selectedColumns.map((name) => ({
    name,
    type: inferFieldType(name, columnMappings[name] || [], explicit.get(name)?.type),
    required: Boolean(explicit.get(name)?.required),
    label: explicit.get(name)?.label || name,
  })));
}

function firstMappedPhone(record, selectedColumns, columnMappings) {
  for (const column of selectedMappedColumns(selectedColumns, columnMappings, CALLABLE_MAPPING_PREFIXES)) {
    const value = record[column];
    if (isLikelyPhone(value)) return value;
  }
  return null;
}

function emptyContactMethods() {
  return { number: {}, email: {}, whatsapp: {} };
}

function buildContactMethods(record, selectedColumns, columnMappings) {
  const methods = emptyContactMethods();
  for (const column of selectedColumns) {
    const value = record[column];
    if (value == null || value === "") continue;
    for (const mapping of columnMappings[column] || []) {
      const [group, slot] = String(mapping).split(":");
      if (["number", "email", "whatsapp"].includes(group) && slot) methods[group][slot] = value;
    }
  }
  return Object.fromEntries(Object.entries(methods).filter(([, values]) => Object.keys(values).length));
}

export async function POST(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { contactListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    let csv = "";
    const contentType = request.headers.get("content-type") || "";
    let importSettings = {};
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      csv = file && typeof file.text === "function" ? await file.text() : String(form.get("csv") || "");
      importSettings = safeJson(form.get("metadata") || form.get("importSettings"), {});
    } else {
      const body = await request.json();
      csv = body.csv || body.text || "";
      importSettings = safeJson(body.metadata || body.importSettings || {}, {});
    }
    const { headers, records, truncated } = parseCsv(csv, 5000);
    if (!headers.length) return jsonError("CSV header row is required", 400);
    if (!records.length) return jsonError("CSV contains no records", 400);
    const selectedColumns = Array.isArray(importSettings.selected_columns) ? importSettings.selected_columns.filter((column) => headers.includes(column)) : [];
    if (!selectedColumns.length) return jsonError("Select at least one CSV column before importing", 400);
    const columnMappings = Object.fromEntries(Object.entries(importSettings.column_mappings || {})
      .filter(([column, values]) => selectedColumns.includes(column) && Array.isArray(values))
      .map(([column, values]) => [column, [...new Set(values.filter(isValidContactMapping))]]));
    if (!selectedMappedColumns(selectedColumns, columnMappings).length) return jsonError("Map at least one selected CSV column to Number, Email, or WhatsApp before importing", 400);

    const rules = normalizeCsvImportRules(headers, importSettings);
    const applied = applyCsvImportRules(records, headers, importSettings);
    const importRecords = applied.records;
    if (!importRecords.length) return jsonError("CSV filters and duplicate rules rejected all records", 400);

    // Data model note: every selected CSV column is preserved once in row_data JSONB.
    // List-level metadata.csv_import_settings.column_mappings is the source of truth for
    // which row_data keys are contact methods; contact_methods stores the resolved per-row values.
    // Contact methods are stored in JSONB from explicit mappings, not from header-name heuristics.
    const inferredSchema = buildImportSchema(selectedColumns, columnMappings, importSettings);
    const validPhones = importRecords.filter((record) => Boolean(firstMappedPhone(record, selectedColumns, columnMappings))).length;
    const importMetadata = {
      csv_import_settings: {
        selected_columns: selectedColumns,
        column_mappings: columnMappings,
        no_duplicate_columns: rules.no_duplicate_columns,
        column_filters: rules.column_filters,
        field_schema: inferredSchema,
        source_file_name: importSettings.source_file_name || null,
        updated_at: importSettings.updated_at || new Date().toISOString(),
      },
    };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM outbound_contact_records WHERE contact_list_id=$1`, [contactListId]);
      for (const record of importRecords) {
        const rowData = Object.fromEntries(selectedColumns.map((key) => [key, record[key] ?? ""]));
        const contactMethods = buildContactMethods(record, selectedColumns, columnMappings);
        const phoneValue = firstMappedPhone(record, selectedColumns, columnMappings);
        await client.query(`INSERT INTO outbound_contact_records (contact_list_id, row_data, contact_methods, validation_status) VALUES ($1,$2,$3,$4)`, [contactListId, JSON.stringify(rowData), JSON.stringify(contactMethods), isLikelyPhone(phoneValue) ? "valid" : "needs_review"]);
      }
      const { rows } = await client.query(`UPDATE outbound_contact_lists SET status='validated', custom_field_schema=$1, record_count=$2, valid_phone_count=$3, metadata=COALESCE(metadata, '{}'::jsonb) || $4::jsonb, updated_by=$5, updated_at=NOW() WHERE id=$6 RETURNING *`, [JSON.stringify(inferredSchema), importRecords.length, validPhones, JSON.stringify(importMetadata), usernameFor(user), contactListId]);
      await client.query("COMMIT");
      if (!rows[0]) return jsonError("Contact list not found", 404);
      return NextResponse.json({ ok: true, contactList: rows[0], preview: importRecords.slice(0, 10), headers, inferredSchema, validPhones, totalRows: importRecords.length, originalRows: records.length, duplicateRowsRejected: applied.duplicateRowsRejected, filteredRows: applied.filteredRows, truncated });
    } catch (err) { await client.query("ROLLBACK"); throw err; }
    finally { client.release(); }
  } catch (err) { console.error("[Outbound Dialer] CSV import error:", err); return jsonError(err.message || "Failed to import CSV", 400); }
}
