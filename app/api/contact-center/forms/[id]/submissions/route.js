import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildFormContext } from "@/lib/forms/form-context";
import { createFormSubmission } from "@/lib/forms/form-submissions";
export async function GET(request, context) {
  const user = await getAuthenticatedUser(); if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params; const pool = getPostgresPool(); if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
  const { searchParams } = new URL(request.url); const interactionId = searchParams.get("interactionId"); const args = [id]; let where = "form_id=$1"; if (interactionId) { args.push(interactionId); where += ` AND interaction_id=$2`; }
  const { rows } = await pool.query(`SELECT * FROM form_submissions WHERE ${where} ORDER BY created_at DESC LIMIT 50`, args); return NextResponse.json({ ok: true, submissions: rows });
}
export async function POST(request, context) {
  const user = await getAuthenticatedUser(); if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params; const pool = getPostgresPool(); if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
  const body = await request.json(); const { rows } = await pool.query(`SELECT * FROM form_definitions WHERE id=$1 AND status='published'`, [id]); const form = rows[0]; if (!form) return NextResponse.json({ ok: false, error: "Form not found" }, { status: 404 });
  let interaction = null; if (body.interactionId) { const res = await pool.query(`SELECT * FROM cc_interactions WHERE id=$1`, [body.interactionId]); interaction = res.rows[0] || null; }
  const contextObj = body.context || buildFormContext(interaction || {}); const result = await createFormSubmission(pool, { form, data: body.data || {}, context: contextObj, interaction: interaction || { agent_username: user.username || user.email }, status: body.status || "submitted" });
  return NextResponse.json({ ok: result.validation.ok, ...result }, { status: result.validation.ok ? 200 : 400 });
}
