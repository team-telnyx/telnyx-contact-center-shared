import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import {
  OUTBOUND_CAMPAIGN_MODES,
  OUTBOUND_CHANNELS,
  OUTBOUND_CONTACT_FIELD_TYPES,
  OUTBOUND_HANDLER_TYPES,
  OUTBOUND_STANDARD_CONTACT_COLUMNS,
} from "@/lib/outbound-dialer/schema";

export async function requireOutboundSupervisor() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = id ? await PgDb.findUserById(id) : null;
  if (!user && email) user = await PgDb.findUserByUsername(email);
  return user && isSupervisorOrAdmin(user) ? user : null;
}

export function jsonError(message, status = 400, details) {
  return NextResponse.json({ error: message, details }, { status });
}

export function getOutboundPool() {
  return getPostgresPool();
}

export const outboundSchemaPayload = {
  channels: OUTBOUND_CHANNELS,
  campaignModes: OUTBOUND_CAMPAIGN_MODES,
  campaignStatuses: ["draft", "ready", "paused", "running", "completed"],
  handlerTypes: OUTBOUND_HANDLER_TYPES,
  contactListStatuses: ["draft", "validating", "validated"],
  dncListStatuses: ["draft", "active", "paused"],
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
    standard_columns: row.standard_columns || {},
    custom_field_schema: Array.isArray(row.custom_field_schema) ? row.custom_field_schema : [],
    custom_fields: row.custom_fields || {},
  } : null;
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

export function usernameFor(user) {
  return user?.username || user?.email || "system";
}

export function requireString(value, label, max = 180) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} is too long`);
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
  const seen = new Set();
  return (Array.isArray(schema) ? schema : [])
    .map((field) => ({
      name: String(field?.name || "").trim().replace(/[^a-zA-Z0-9_]/g, "_"),
      type: ensureEnum(field?.type, OUTBOUND_CONTACT_FIELD_TYPES, "text"),
      required: Boolean(field?.required),
      label: optionalString(field?.label, 120),
    }))
    .filter((field) => field.name && !seen.has(field.name) && seen.add(field.name));
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
