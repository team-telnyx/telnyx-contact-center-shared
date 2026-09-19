import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { createDefaultForm, normalizeFormDefinition, slugifyFormName, validateFormDefinition } from "@/lib/forms/form-schema";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

function mapRow(row) { return row ? { ...row, queue_ids: row.queue_ids || [], queue_names: row.queue_names || [] } : null; }

async function GET_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool(); if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const { searchParams } = new URL(request.url); const status = searchParams.get("status"); const q = searchParams.get("q");
  const where = []; const args = []; let i = 1;
  if (status && status !== "all") { where.push(`status = $${i++}`); args.push(status); }
  else if (status !== "all") { where.push("status <> 'archived'"); }
  if (q) { where.push(`(name ILIKE $${i} OR slug ILIKE $${i} OR description ILIKE $${i})`); args.push(`%${q}%`); i++; }
  const { rows } = await pool.query(`SELECT * FROM form_definitions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC`, args);
  return NextResponse.json({ ok: true, forms: rows.map(mapRow), count: rows.length });
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool(); if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json(); const form = normalizeFormDefinition(createDefaultForm({ ...body, slug: body.slug || slugifyFormName(body.name) })); const validation = validateFormDefinition(form);
    if (!validation.ok) return NextResponse.json({ error: "Invalid form", details: validation.errors }, { status: 400 });
    if (form.status === "published" && !authz.can("forms:publish")) return NextResponse.json({ error: "Forbidden", permission: "forms:publish" }, { status: 403 });
    const username = user.username || user.email || "system";
    const { rows } = await pool.query(`INSERT INTO form_definitions (name, slug, description, category, status, version, schema, layout, theme, bindings, actions, queue_ids, queue_names, auto_open, created_by, updated_by, published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15, CASE WHEN $5 = 'published' THEN NOW() ELSE NULL END) RETURNING *`, [form.name, form.slug, form.description, form.category, form.status, form.version, JSON.stringify(form.schema), JSON.stringify(form.layout), JSON.stringify(form.theme), JSON.stringify(form.bindings), JSON.stringify(form.actions), form.queue_ids, form.queue_names, form.auto_open, username]);
    return NextResponse.json({ ok: true, form: mapRow(rows[0]) });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) }); const msg = err.code === "23505" ? "A form with this slug already exists" : "Failed to create form"; return NextResponse.json({ error: msg }, { status: 400 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("forms:read", GET_handler, { route: "/api/admin/forms" });
export const POST = withPermission("forms:create", POST_handler, { route: "/api/admin/forms" });
