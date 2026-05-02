import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildFormContext, getContextValue } from "@/lib/forms/form-context";
export async function GET(request, context) {
  const user = await getAuthenticatedUser(); if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params; const pool = getPostgresPool(); if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
  const { searchParams } = new URL(request.url); const interactionId = searchParams.get("interactionId");
  const { rows } = await pool.query(`SELECT * FROM form_definitions WHERE id=$1 AND status='published'`, [id]); const form = rows[0]; if (!form) return NextResponse.json({ ok: false, error: "Form not found" }, { status: 404 });
  let interaction = null; if (interactionId) { const res = await pool.query(`SELECT * FROM cc_interactions WHERE id=$1`, [interactionId]); interaction = res.rows[0] || null; }
  const contextObj = buildFormContext(interaction || {}); const initialValues = {};
  for (const field of form.schema?.fields || []) { if (field.defaultValue !== undefined) initialValues[field.id] = field.defaultValue; const binding = form.bindings?.[field.id]; if (binding?.contextPath) initialValues[field.id] = getContextValue(contextObj, binding.contextPath); }
  return NextResponse.json({ ok: true, form, context: contextObj, initialValues });
}
