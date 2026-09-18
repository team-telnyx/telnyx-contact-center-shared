import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildFormContext, getContextValue } from "@/lib/forms/form-context";
import { findWorkItemByReference } from "@/lib/acd/work-item-repository.mjs";
import { withPermission } from "@/lib/authz/guard";
async function GET_handler(request, context, authz) {
  const user = authz.user;
  const { id } = await context.params; const pool = getPostgresPool(); if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
  const { searchParams } = new URL(request.url); const interactionId = searchParams.get("interactionId");
  const { rows } = await pool.query(`SELECT * FROM form_definitions WHERE id=$1 AND status='published'`, [id]); const form = rows[0]; if (!form) return NextResponse.json({ ok: false, error: "Form not found" }, { status: 404 });
  let interaction = null; if (interactionId) interaction = await findWorkItemByReference(pool, interactionId);
  const contextObj = buildFormContext(interaction || {}); const initialValues = {};
  for (const field of form.schema?.fields || []) { if (field.defaultValue !== undefined) initialValues[field.id] = field.defaultValue; const binding = form.bindings?.[field.id]; if (binding?.contextPath) initialValues[field.id] = getContextValue(contextObj, binding.contextPath); }
  return NextResponse.json({ ok: true, form, context: contextObj, initialValues });
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("forms:read", GET_handler, { route: "/api/contact-center/forms/[id]/render" });
