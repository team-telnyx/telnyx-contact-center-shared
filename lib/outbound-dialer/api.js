import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isOwner } from "@/lib/role-utils";
import {
  OUTBOUND_CHANNELS,
  OUTBOUND_CONTACT_FIELD_TYPES,
  OUTBOUND_HANDLER_TYPES,
  OUTBOUND_STANDARD_CONTACT_COLUMNS,
  normalizeContactFieldSchema,
} from "@/lib/outbound-dialer/schema";
import { normalizeOutboundDialTimeoutSecs } from "@/lib/outbound-dialer/execution";

export async function requireOutboundSupervisor() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = id ? await PgDb.findUserById(id) : null;
  if (!user && email) user = await PgDb.findUserByUsername(email);
  return user && isOwner(user) ? user : null;
}

export function jsonError(message, status = 400, details) {
  return NextResponse.json({ error: message, details }, { status });
}

export function getOutboundPool() {
  return getPostgresPool();
}

export const outboundSchemaPayload = {
  channels: OUTBOUND_CHANNELS,
  campaignModes: ["preview", "progressive", "power", "predictive", "agentless_ai", "agentless_flow"],
  campaignStatuses: ["draft", "ready", "paused", "running", "stopped", "completed"],
  handlerTypes: OUTBOUND_HANDLER_TYPES,
  contactListStatuses: ["draft", "validating", "validated"],
  dncListStatuses: ["draft", "active", "paused"],
  attemptControlStatuses: ["draft", "active", "paused"],
  dispositionClassifications: ["none", "right_party_contact", "number_uncallable", "contact_uncallable", "retry"],
  dispositionBusinessCategories: ["none", "success", "neutral", "failure"],
  attemptResetPeriods: ["daily", "weekly", "monthly", "campaign", "lifetime"],
  contactFieldTypes: OUTBOUND_CONTACT_FIELD_TYPES,
  standardContactColumns: OUTBOUND_STANDARD_CONTACT_COLUMNS,
};

export function mapCampaign(row) {
  return row ? {
    ...row,
    pacing_config: row.pacing_config || {},
    concurrency_config: row.concurrency_config || {},
    dialing_windows: row.dialing_windows || [],
    retry_policy: row.retry_policy || {},
    amd_config: row.amd_config || {},
    form_variable_mapping: row.form_variable_mapping || [],
    metadata: row.metadata || {},
    contact_list_name: row.contact_list_name || null,
    attached_form_name: row.attached_form_name || null,
  } : null;
}

export function mapContactList(row) {
  return row ? {
    ...row,
    // Source-of-truth is custom_field_schema + metadata.csv_import_settings
    // and record row_data/contact_methods JSONB.
    standard_columns: row.standard_columns || {},
    custom_field_schema: Array.isArray(row.custom_field_schema) ? row.custom_field_schema : [],
    row_data_columns: Array.isArray(row.row_data_columns) ? row.row_data_columns : [],
    metadata: row.metadata || {},
  } : null;
}

const CONTACT_LIST_FIELD_SAMPLE_LIMIT = 100;
export const OUTBOUND_FILTER_PREVIEW_SCAN_LIMIT = 10000;

function normalizeFieldNameList(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((field) => String(field || "").trim()).filter(Boolean))];
}

function metadataContactListFields(list = {}) {
  const metadata = list?.metadata || {};
  const importSettings = metadata.csv_import_settings || metadata.csvImportSettings || {};
  const schemaFields = (Array.isArray(list?.custom_field_schema) ? list.custom_field_schema : []).map((field) => field?.name);
  const importSchema = Array.isArray(importSettings.field_schema) ? importSettings.field_schema : importSettings.fieldSchema || [];
  const metadataSchemaFields = (Array.isArray(importSchema) ? importSchema : []).map((field) => field?.name);
  const selectedColumns = importSettings.selected_columns || importSettings.selectedColumns || [];
  return normalizeFieldNameList([...schemaFields, ...metadataSchemaFields, ...selectedColumns]);
}


async function tableHasColumn(pool, tableName, columnName) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2 LIMIT 1`,
    [tableName, columnName]
  );
  return Boolean(rows.length);
}

async function outboundRecordsHaveRowData(pool) {
  return tableHasColumn(pool, "outbound_contact_records", "row_data");
}

export async function loadSampledRowDataColumns(pool, contactListId, sampleLimit = CONTACT_LIST_FIELD_SAMPLE_LIMIT) {
  if (!(await outboundRecordsHaveRowData(pool))) return [];
  const { rows } = await pool.query(
    `SELECT COALESCE(jsonb_agg(DISTINCT keys.key ORDER BY keys.key), '[]'::jsonb) AS row_data_columns
     FROM (
       SELECT COALESCE(r.row_data, '{}'::jsonb) AS row_data
       FROM outbound_contact_records r
       WHERE r.contact_list_id=$1
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $2
     ) sampled
     CROSS JOIN LATERAL jsonb_object_keys(sampled.row_data) AS keys(key)`,
    [contactListId, sampleLimit]
  );
  return rows[0]?.row_data_columns || [];
}

export async function loadOutboundContactLists(pool, limit = 100) {
  const hasRowDataColumn = await outboundRecordsHaveRowData(pool);
  const hasMetadataColumn = await tableHasColumn(pool, "outbound_contact_lists", "metadata");
  const metadataFieldSources = hasMetadataColumn ? `
         UNION
         SELECT field->>'name' AS field_name
         FROM jsonb_array_elements(COALESCE(l.metadata->'csv_import_settings'->'field_schema', '[]'::jsonb)) field
         UNION
         SELECT jsonb_array_elements_text(COALESCE(l.metadata->'csv_import_settings'->'selected_columns', '[]'::jsonb)) AS field_name` : "";
  return pool.query(
    `SELECT l.*,
       CASE
         WHEN jsonb_array_length(COALESCE(metadata_fields.row_data_columns, '[]'::jsonb)) > 0 THEN metadata_fields.row_data_columns
         ELSE COALESCE(sampled_fields.row_data_columns, '[]'::jsonb)
       END AS row_data_columns
     FROM outbound_contact_lists l
     CROSS JOIN LATERAL (
       SELECT COALESCE(jsonb_agg(DISTINCT field_name ORDER BY field_name), '[]'::jsonb) AS row_data_columns
       FROM (
         SELECT field->>'name' AS field_name
         FROM jsonb_array_elements(COALESCE(l.custom_field_schema, '[]'::jsonb)) field
         ${metadataFieldSources}
       ) fields
       WHERE field_name IS NOT NULL AND btrim(field_name) <> ''
     ) metadata_fields
     LEFT JOIN LATERAL (
       ${hasRowDataColumn ? `
       SELECT jsonb_agg(DISTINCT keys.key ORDER BY keys.key) AS row_data_columns
       FROM (
         SELECT COALESCE(r.row_data, '{}'::jsonb) AS row_data
         FROM outbound_contact_records r
         WHERE r.contact_list_id = l.id
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ${CONTACT_LIST_FIELD_SAMPLE_LIMIT}
       ) sampled
       CROSS JOIN LATERAL jsonb_object_keys(sampled.row_data) AS keys(key)
       WHERE jsonb_array_length(COALESCE(metadata_fields.row_data_columns, '[]'::jsonb)) = 0` : `SELECT '[]'::jsonb AS row_data_columns`}
     ) sampled_fields ON TRUE
     WHERE l.status <> 'archived'
     ORDER BY l.updated_at DESC
     LIMIT $1`,
    [limit]
  );
}

export function mapDncList(row) {
  return row ? {
    ...row,
    metadata: row.metadata || {},
  } : null;
}

export function mapForm(row) {
  return row ? { id: row.id, name: row.name, status: row.status, category: row.category, schema: row.schema || {} } : null;
}

export function mapOutboundFilter(row) {
  return row ? {
    ...row,
    conditions: Array.isArray(row.conditions) ? row.conditions : [],
    metadata: row.metadata || {},
    contact_list_name: row.contact_list_name || null,
  } : null;
}

export function outboundContactListFieldNames(list = {}, rowDataColumns = []) {
  return normalizeFieldNameList([...metadataContactListFields(list), ...(Array.isArray(rowDataColumns) ? rowDataColumns : [])]);
}

const OUTBOUND_FILTER_OPERATORS = new Set(["is present", "equals", "does not equal", "contains", "greater than", "less than", "before", "after"]);

function normalizeComparable(value) {
  return String(value ?? "").trim();
}

function compareNumberOrText(left, right, comparator) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return comparator(leftNumber, rightNumber);
  return comparator(String(left).localeCompare(String(right)), 0);
}

function compareDateOrText(left, right, comparator) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return comparator(leftTime, rightTime);
  return compareNumberOrText(left, right, comparator);
}

function outboundFilterConditionMatches(rowData = {}, condition = {}) {
  const field = String(condition?.field || "").trim();
  const operator = OUTBOUND_FILTER_OPERATORS.has(condition?.operator) ? condition.operator : "is present";
  const actual = normalizeComparable(rowData?.[field]);
  const expected = normalizeComparable(condition?.value);
  if (operator === "is present") return actual.length > 0;
  if (operator === "equals") return actual.toLowerCase() === expected.toLowerCase();
  if (operator === "does not equal") return actual.toLowerCase() !== expected.toLowerCase();
  if (operator === "contains") return actual.toLowerCase().includes(expected.toLowerCase());
  if (operator === "greater than") return compareNumberOrText(actual, expected, (a, b) => a > b);
  if (operator === "less than") return compareNumberOrText(actual, expected, (a, b) => a < b);
  if (operator === "before") return compareDateOrText(actual, expected, (a, b) => a < b);
  if (operator === "after") return compareDateOrText(actual, expected, (a, b) => a > b);
  return false;
}

export function normalizeOutboundFilterConditions(conditions = [], allowedFields = []) {
  const fieldSet = new Set((allowedFields || []).map((field) => String(field || "").trim()).filter(Boolean));
  const normalized = (Array.isArray(conditions) ? conditions : [])
    .map((condition) => ({
      field: String(condition?.field || "").trim(),
      operator: OUTBOUND_FILTER_OPERATORS.has(condition?.operator) ? condition.operator : "is present",
      value: normalizeComparable(condition?.value),
    }))
    .filter((condition) => condition.field);
  const invalid = normalized.filter((condition) => fieldSet.size && !fieldSet.has(condition.field)).map((condition) => condition.field);
  return { conditions: normalized, invalidFields: [...new Set(invalid)] };
}

export function outboundFilterRecordMatches(rowData = {}, conditions = []) {
  return (Array.isArray(conditions) ? conditions : []).every((condition) => outboundFilterConditionMatches(rowData, condition));
}

export async function testOutboundContactFilter(pool, { contactListId, conditions = [], sampleLimit = 10, batchSize = 1000, scanLimit = OUTBOUND_FILTER_PREVIEW_SCAN_LIMIT }) {
  if (!pool) throw new Error("Server not ready");
  const hasMetadataColumn = await tableHasColumn(pool, "outbound_contact_lists", "metadata");
  const hasRowDataColumn = await outboundRecordsHaveRowData(pool);
  const { rows: listRows } = await pool.query(`SELECT id, name, record_count, custom_field_schema, ${hasMetadataColumn ? "metadata" : "'{}'::jsonb AS metadata"} FROM outbound_contact_lists WHERE id=$1 AND status <> 'archived' LIMIT 1`, [contactListId]);
  const contactList = listRows[0];
  const requestedScanLimit = Math.max(1, Number(scanLimit) || OUTBOUND_FILTER_PREVIEW_SCAN_LIMIT);
  const listRecordCount = Math.max(0, Number(contactList?.record_count || 0));
  const emptyPreviewResult = (overrides = {}) => ({
    valid: false,
    validated: false,
    totalRecords: 0,
    totalRecordsConsidered: 0,
    scannedRecords: 0,
    matchingRecords: 0,
    scanLimit: requestedScanLimit,
    limited: false,
    capped: false,
    totalRecordsExact: true,
    sampleRows: [],
    columns: [],
    errors: [],
    contactList: null,
    conditions: [],
    ...overrides,
  });
  if (!contactList) return emptyPreviewResult({ errors: ["Target contact list not found"] });

  if (!hasRowDataColumn) {
    const metadataColumns = metadataContactListFields(contactList);
    const normalized = normalizeOutboundFilterConditions(conditions, metadataColumns);
    return emptyPreviewResult({
      columns: metadataColumns,
      errors: ["Contact list records are not using row_data yet"],
      contactList: { id: contactList.id, name: contactList.name, record_count: listRecordCount },
      conditions: normalized.conditions,
    });
  }

  const metadataColumns = metadataContactListFields(contactList);
  const rowDataColumns = metadataColumns.length ? [] : await loadSampledRowDataColumns(pool, contactListId);
  const columns = outboundContactListFieldNames(contactList, rowDataColumns);
  const normalized = normalizeOutboundFilterConditions(conditions, columns);
  const errors = [];
  if (!columns.length) errors.push("Target contact list has no imported fields yet");
  if (!normalized.conditions.length) errors.push("Add at least one filter condition");
  if (normalized.invalidFields.length) errors.push(`Unknown field(s): ${normalized.invalidFields.join(", ")}`);
  const canEvaluate = columns.length > 0 && normalized.conditions.length > 0 && normalized.invalidFields.length === 0;

  let totalRecords = 0;
  let matchingRecords = 0;
  const sampleRows = [];
  let lastCreatedAt = null;
  let lastId = null;
  const effectiveScanLimit = listRecordCount > 0 ? Math.min(requestedScanLimit, listRecordCount) : requestedScanLimit;
  while (totalRecords < effectiveScanLimit) {
    const remaining = effectiveScanLimit - totalRecords;
    const { rows } = await pool.query(
      `SELECT r.id, COALESCE(r.row_data, '{}'::jsonb) AS row_data, r.created_at
       FROM outbound_contact_records r
       WHERE r.contact_list_id=$1
         AND ($2::timestamptz IS NULL OR (COALESCE(r.created_at, 'epoch'::timestamptz), r.id) > ($2::timestamptz, $3::uuid))
       ORDER BY COALESCE(r.created_at, 'epoch'::timestamptz) ASC, r.id ASC
       LIMIT $4`,
      [contactListId, lastCreatedAt, lastId, Math.min(batchSize, remaining)]
    );
    if (!rows.length) break;
    for (const row of rows) {
      totalRecords += 1;
      if (!canEvaluate || !outboundFilterRecordMatches(row.row_data || {}, normalized.conditions)) continue;
      matchingRecords += 1;
      if (sampleRows.length < sampleLimit) sampleRows.push(Object.fromEntries(columns.map((column) => [column, row.row_data?.[column] ?? ""])));
    }
    const last = rows[rows.length - 1];
    lastCreatedAt = last.created_at || new Date(0).toISOString();
    lastId = last.id;
  }

  const scannedRecords = totalRecords;
  let hasMoreRowsBeyondCap = false;
  if (scannedRecords >= effectiveScanLimit && lastId) {
    const { rows: moreRows } = await pool.query(
      `SELECT 1
       FROM outbound_contact_records r
       WHERE r.contact_list_id=$1
         AND (COALESCE(r.created_at, 'epoch'::timestamptz), r.id) > ($2::timestamptz, $3::uuid)
       LIMIT 1`,
      [contactListId, lastCreatedAt || new Date(0).toISOString(), lastId]
    );
    hasMoreRowsBeyondCap = Boolean(moreRows.length);
  }
  const limited = listRecordCount > 0 ? listRecordCount > requestedScanLimit : hasMoreRowsBeyondCap;
  const errorsWithLimit = [...errors];
  if (limited) errorsWithLimit.push(`Preview scanned the first ${requestedScanLimit.toLocaleString()} records only. Totals are limited estimates; narrow the list or run an offline/export job for exact counts.`);

  return {
    valid: errors.length === 0,
    validated: errors.length === 0,
    totalRecords: listRecordCount || scannedRecords,
    totalRecordsConsidered: scannedRecords,
    scannedRecords,
    matchingRecords,
    scanLimit: requestedScanLimit,
    limited,
    capped: limited,
    totalRecordsExact: !limited,
    sampleRows,
    columns,
    errors: errorsWithLimit,
    contactList: { id: contactList.id, name: contactList.name, record_count: listRecordCount },
    conditions: normalized.conditions,
  };
}

export function mapOutboundTimeSet(row) {
  return row ? {
    ...row,
    windows: Array.isArray(row.windows) ? row.windows : [],
    metadata: row.metadata || {},
  } : null;
}

export function mapOutboundAttemptControl(row) {
  return row ? {
    ...row,
    recall_rules: Array.isArray(row.recall_rules) ? row.recall_rules : [],
    phone_type_rules: Array.isArray(row.phone_type_rules) ? row.phone_type_rules : [],
    metadata: row.metadata || {},
  } : null;
}

export function mapOutboundDispositionCode(row) {
  return row ? {
    ...row,
    metadata: row.metadata || {},
    campaign_id: row.campaign_id || null,
    campaign_name: row.campaign_name || null,
    wrapup_code_name: row.wrapup_code_name || row.name || row.wrapup_code_id,
    wrapup_code_description: row.wrapup_code_description || null,
    wrapup_code_icon: row.wrapup_code_icon || null,
    wrapup_code_color: row.wrapup_code_color || null,
  } : null;
}

const OUTBOUND_SETTINGS_DEFAULT_CALLABLE_DAYS = ["mon", "tue", "wed", "thu", "fri"];
const OUTBOUND_SETTINGS_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function normalizedOutboundCallableDays(settings = {}) {
  const days = settings.callable_days || settings.callableDays || OUTBOUND_SETTINGS_DEFAULT_CALLABLE_DAYS;
  const normalized = (Array.isArray(days) ? days : [])
    .map((day) => String(day || "").trim().toLowerCase())
    .filter((day, idx, list) => OUTBOUND_SETTINGS_WEEKDAYS.includes(day) && list.indexOf(day) === idx);
  return normalized.length ? normalized : OUTBOUND_SETTINGS_DEFAULT_CALLABLE_DAYS;
}

export function mapOutboundSettings(row) {
  const settings = row?.settings || {};
  return {
    id: row?.id || "default",
    max_calls_per_agent: Number(settings.max_calls_per_agent ?? settings.maxCallsPerAgent ?? 1) || 1,
    max_lines: Number(settings.max_lines ?? settings.maxLines ?? 10) || 10,
    max_line_utilization_percent: Number(settings.max_line_utilization_percent ?? settings.maxLineUtilizationPercent ?? 90) || 90,
    max_cps: Number(settings.max_cps ?? settings.maxCps ?? 50) || 50,
    compliance_abandon_threshold_seconds: Number(settings.compliance_abandon_threshold_seconds ?? settings.complianceAbandonThresholdSeconds ?? 2) || 2,
    global_max_attempts: Number(settings.global_max_attempts ?? settings.globalMaxAttempts ?? 5) || 5,
    dial_timeout_secs: normalizeOutboundDialTimeoutSecs(settings.dial_timeout_secs ?? settings.dialTimeoutSecs, 30),
    callable_days: normalizedOutboundCallableDays(settings),
    callable_window: settings.callable_window || settings.callableWindow || { earliest: "09:00", latest: "20:00", timezone: "Europe/Warsaw" },
    allowed_numbers: Array.isArray(settings.allowed_numbers || settings.allowedNumbers) ? (settings.allowed_numbers || settings.allowedNumbers) : [],
    updated_at: row?.updated_at || null,
    updated_by: row?.updated_by || null,
  };
}

export function mapHandlerReference(row, kind) {
  if (!row) return null;
  return {
    id: String(row.id || row.value || row.name),
    name: row.display_name || row.name || row.label || String(row.id || row.value || "Untitled"),
    kind,
    status: row.status || (row.enabled === false || row.active === false ? "inactive" : "active"),
    routing_type: row.routing_type || row.routingType || row.routing_strategy || row.routingStrategy || null,
  };
}

export function usernameFor(user) {
  return user?.username || user?.email || "system";
}

export function requireString(value, label, max = 180) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} is too long`);
  return text;
}

export function requireUuid(value, label) {
  const text = requireString(value, label, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new Error(`${label} must be a valid id`);
  return text;
}

export function optionalString(value, max = 1000) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

export function ensureEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function safeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

export function normalizeFieldSchema(schema = []) {
  return normalizeContactFieldSchema(schema).map((field) => ({
    ...field,
    label: optionalString(field.label, 120) || field.name,
  }));
}

export function isLikelyPhone(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  return digits.length >= 7 && digits.length <= 16;
}

export function parseCsv(csvText, limit = 2000) {
  const rows = [];
  let cell = "";
  let row = [];
  let quoted = false;
  const text = String(csvText || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; if (rows.length > limit) break; }
    else if (char !== "\r") cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = (rows.shift() || []).map((h) => String(h || "").trim());
  const records = rows.filter((r) => r.some((c) => String(c || "").trim())).slice(0, limit).map((r) => Object.fromEntries(headers.map((h, idx) => [h, String(r[idx] || "").trim()])));
  return { headers, records, truncated: rows.length > limit };
}

export function normalizePhoneValue(value) {
  const text = String(value || "").trim();
  const hasPlus = text.startsWith("+");
  const digits = text.replace(/[^0-9]/g, "");
  if (digits.length < 7 || digits.length > 16) return null;
  return `${hasPlus ? "+" : ""}${digits}`;
}

export function isLikelyEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim().toLowerCase());
}

export function normalizeEmailValue(value) {
  const email = String(value || "").trim().toLowerCase();
  return isLikelyEmail(email) ? email : null;
}

export function normalizeDncValue(value, valueType) {
  return valueType === "email" ? normalizeEmailValue(value) : normalizePhoneValue(value);
}

export function classifySuppressionColumn(records = [], column) {
  const samples = (Array.isArray(records) ? records : [])
    .map((record) => String(record?.[column] || "").trim())
    .filter(Boolean)
    .slice(0, 25);
  const phoneMatches = samples.filter((value) => Boolean(normalizePhoneValue(value))).length;
  const emailMatches = samples.filter((value) => Boolean(normalizeEmailValue(value))).length;
  return {
    column,
    sample_count: samples.length,
    phone_matches: phoneMatches,
    email_matches: emailMatches,
    is_phone: samples.length > 0 && phoneMatches > 0 && phoneMatches >= emailMatches && phoneMatches / samples.length >= 0.5,
    is_email: samples.length > 0 && emailMatches > 0 && emailMatches >= phoneMatches && emailMatches / samples.length >= 0.5,
  };
}

export function allowedSuppressionTypesForStrategy(strategy = "phone") {
  if (strategy === "email") return ["email"];
  if (strategy === "phone_or_email") return ["phone", "email"];
  return ["phone"];
}

export function isDncColumnAllowed(classification, strategy = "phone") {
  const allowed = allowedSuppressionTypesForStrategy(strategy);
  return (allowed.includes("phone") && classification?.is_phone) || (allowed.includes("email") && classification?.is_email);
}

export async function findDncSuppression(pool, dncListId, value, preferredType = "phone", allowedTypes = ["phone", "email"]) {
  if (!pool || !dncListId || value == null || value === "") return null;
  const allowed = new Set((Array.isArray(allowedTypes) && allowedTypes.length ? allowedTypes : ["phone", "email"]).filter((type) => ["phone", "email"].includes(type)));
  const candidates = [];
  const add = (type) => {
    if (!allowed.has(type)) return;
    const normalized = normalizeDncValue(value, type);
    if (normalized && !candidates.some((candidate) => candidate.value_type === type && candidate.normalized_value === normalized)) candidates.push({ value_type: type, normalized_value: normalized });
  };
  add(preferredType === "email" ? "email" : "phone");
  add("phone");
  add("email");
  if (!candidates.length) return null;
  const { rows } = await pool.query(
    `SELECT * FROM outbound_dnc_entries
     WHERE dnc_list_id=$1
       AND (value_type, normalized_value) IN (${candidates.map((_, idx) => `($${idx * 2 + 2}, $${idx * 2 + 3})`).join(",")})
     LIMIT 1`,
    [dncListId, ...candidates.flatMap((candidate) => [candidate.value_type, candidate.normalized_value])]
  );
  return rows[0] || null;
}

function inferDncPreferredType(value, strategy = "phone", channel = "voice") {
  if (strategy === "email") return "email";
  if (strategy === "phone") return "phone";
  if (normalizeEmailValue(value)) return "email";
  if (normalizePhoneValue(value)) return "phone";
  if (String(channel || "").toLowerCase() === "email") return "email";
  return "phone";
}

function collectDncCandidateValues(contact, selectedColumns, strategy = "phone", channel = "voice") {
  const rowData = contact?.row_data || {};
  const methods = contact?.contact_methods || {};
  const allowedTypes = allowedSuppressionTypesForStrategy(strategy);
  const candidates = [];
  const seen = new Set();
  const add = (value, preferredType) => {
    if (value == null || value === "" || !allowedTypes.includes(preferredType)) return;
    if (!normalizeDncValue(value, preferredType)) return;
    const key = `${preferredType}:${String(value)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ value, preferredType });
  };

  if (selectedColumns.length) {
    for (const column of selectedColumns) {
      const value = rowData[column];
      if (strategy === "phone_or_email") {
        add(value, inferDncPreferredType(value, strategy, channel));
      } else {
        for (const type of allowedTypes) add(value, type);
      }
    }
    return candidates;
  }

  if (allowedTypes.includes("phone")) {
    for (const value of Object.values(methods.number || {})) add(value, "phone");
    for (const value of Object.values(methods.whatsapp || {})) add(value, "phone");
  }
  if (allowedTypes.includes("email")) {
    for (const value of Object.values(methods.email || {})) add(value, "email");
  }
  return candidates;
}

export async function annotateCampaignDncScaffold(pool, campaignRow, username = "system") {
  const dncListId = campaignRow?.metadata?.dnc_list_id;
  const contactListId = campaignRow?.contact_list_id;
  if (!pool || !dncListId || !contactListId) return { campaign: campaignRow, suppressedCount: 0 };
  const selectedNumbers = Array.isArray(campaignRow?.metadata?.contact_list_numbers) ? campaignRow.metadata.contact_list_numbers : [];
  const { rows: dncLists } = await pool.query(`SELECT match_strategy FROM outbound_dnc_lists WHERE id=$1 LIMIT 1`, [dncListId]);
  const matchStrategy = dncLists[0]?.match_strategy || "phone";
  const campaignChannel = campaignRow?.channel || "voice";
  const batchSize = 1000;
  let lastCreatedAt = null;
  let lastId = null;
  let checkedRecords = 0;
  let suppressedCount = 0;
  const events = [];

  // Scan every record in stable keyset batches. The old fixed LIMIT could silently skip
  // large contact lists while reporting the scaffold pass as complete.
  for (;;) {
    const { rows: contacts } = await pool.query(
      `SELECT id, row_data, contact_methods, created_at
       FROM outbound_contact_records
       WHERE contact_list_id=$1
         AND ($2::timestamptz IS NULL OR (COALESCE(created_at, 'epoch'::timestamptz), id) > ($2::timestamptz, $3::uuid))
       ORDER BY COALESCE(created_at, 'epoch'::timestamptz) ASC, id ASC
       LIMIT $4`,
      [contactListId, lastCreatedAt, lastId, batchSize]
    );
    if (!contacts.length) break;
    checkedRecords += contacts.length;

    for (const contact of contacts) {
      const values = collectDncCandidateValues(contact, selectedNumbers, matchStrategy, campaignChannel);
      let hit = null;
      for (const { value, preferredType } of values) {
        hit = await findDncSuppression(pool, dncListId, value, preferredType, allowedSuppressionTypesForStrategy(matchStrategy));
        if (hit) break;
      }
      if (!hit) continue;
      suppressedCount += 1;
      await pool.query(`UPDATE outbound_contact_records SET validation_status='suppressed', updated_at=NOW() WHERE id=$1`, [contact.id]);
      if (events.length < 25) events.push({ type: "dnc_suppressed", at: new Date().toISOString(), contact_record_id: contact.id, dnc_list_id: dncListId, value_type: hit.value_type, normalized_value: hit.normalized_value, annotation: `${hit.value_type === "email" ? "Email" : "Number"} was on assigned DNC list and was not dialed.` });
    }

    const lastContact = contacts[contacts.length - 1];
    lastCreatedAt = lastContact.created_at || new Date(0).toISOString();
    lastId = lastContact.id;
  }

  const metadata = {
    ...(campaignRow.metadata || {}),
    dnc_scaffold: { dnc_list_id: dncListId, match_strategy: matchStrategy, checked_records: checkedRecords, suppressed_records: suppressedCount, updated_at: new Date().toISOString(), note: "Scaffold check only; no outbound dialer worker was started." },
    event_timeline: [...events, ...((campaignRow.metadata?.event_timeline || campaignRow.metadata?.events || []).slice(0, Math.max(0, 25 - events.length)))],
  };
  const { rows } = await pool.query(`UPDATE outbound_campaigns SET metadata=$1, updated_by=$2, updated_at=NOW() WHERE id=$3 RETURNING *`, [JSON.stringify(metadata), username, campaignRow.id]);
  return { campaign: rows[0] || campaignRow, suppressedCount };
}
