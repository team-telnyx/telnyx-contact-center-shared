export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { createDefaultForm, normalizeFormDefinition, slugifyFormName, validateFormDefinition } from "@/lib/forms/form-schema";

async function requireAdmin() {
  const session = await getServerSession(authOptions); const id = session?.user?.id || null; const email = session?.user?.email || null; if (!id && !email) return null;
  let user = id ? await PgDb.findUserById(id) : null; if (!user && email) user = await PgDb.findUserByUsername(email); return user && isAdmin(user) ? user : null;
}
function mapRow(row) { return row ? { ...row, queue_ids: row.queue_ids || [], queue_names: row.queue_names || [] } : null; }

export async function GET(request) {
  const user = await requireAdmin(); if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool(); if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const { searchParams } = new URL(request.url); const status = searchParams.get("status"); const q = searchParams.get("q");
  const where = []; const args = []; let i = 1;
  if (status && status !== "all") { where.push(`status = $${i++}`); args.push(status); }
  else if (status !== "all") { where.push("status <> 'archived'"); }
  if (q) { where.push(`(name ILIKE $${i} OR slug ILIKE $${i} OR description ILIKE $${i})`); args.push(`%${q}%`); i++; }
  const { rows } = await pool.query(`SELECT * FROM form_definitions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC`, args);
  return NextResponse.json({ ok: true, forms: rows.map(mapRow), count: rows.length });
}

export async function POST(request) {
  const user = await requireAdmin(); if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool(); if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json(); const form = normalizeFormDefinition(createDefaultForm({ ...body, slug: body.slug || slugifyFormName(body.name) })); const validation = validateFormDefinition(form);
    if (!validation.ok) return NextResponse.json({ error: "Invalid form", details: validation.errors }, { status: 400 });
    const username = user.username || user.email || "system";
    const { rows } = await pool.query(`INSERT INTO form_definitions (name, slug, description, category, status, version, schema, layout, theme, bindings, actions, queue_ids, queue_names, auto_open, created_by, updated_by, published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15, CASE WHEN $5 = 'published' THEN NOW() ELSE NULL END) RETURNING *`, [form.name, form.slug, form.description, form.category, form.status, form.version, JSON.stringify(form.schema), JSON.stringify(form.layout), JSON.stringify(form.theme), JSON.stringify(form.bindings), JSON.stringify(form.actions), form.queue_ids, form.queue_names, form.auto_open, username]);
    return NextResponse.json({ ok: true, form: mapRow(rows[0]) });
  } catch (err) {
    console.error("[Admin Forms] POST error:", err); const msg = err.code === "23505" ? "A form with this slug already exists" : "Failed to create form"; return NextResponse.json({ error: msg }, { status: 400 });
  }
}
