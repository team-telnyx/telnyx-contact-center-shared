import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getFormTemplates } from "@/lib/forms/form-templates";
import { normalizeFormDefinition } from "@/lib/forms/form-schema";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


function mapTemplate(row) {
  return normalizeFormDefinition({ id: row.slug, slug: row.slug, name: row.name, description: row.description || "", category: row.category || "General", schema: row.schema, layout: row.layout, theme: row.theme, bindings: row.bindings, actions: row.actions, queue_names: row.queue_names || [], queue_ids: [], auto_open: row.auto_open });
}

async function GET_handler(_request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (pool) {
    try {
      const { rows } = await pool.query("SELECT * FROM form_templates WHERE active = true ORDER BY sort_order ASC, name ASC");
      if (rows.length) return NextResponse.json({ ok: true, templates: rows.map(mapTemplate), count: rows.length });
    } catch (err) {
      adminRuntimeLogger.warn("runtime_warning", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    }
  }
  const templates = getFormTemplates();
  return NextResponse.json({ ok: true, templates, count: templates.length });
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("forms:read", GET_handler, { route: "/api/admin/form-templates" });
