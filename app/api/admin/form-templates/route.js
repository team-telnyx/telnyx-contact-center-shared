import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getFormTemplates } from "@/lib/forms/form-templates";
import { normalizeFormDefinition } from "@/lib/forms/form-schema";

export const dynamic = "force-dynamic";

async function requireAdmin() {
  const session = await getServerSession(authOptions); const id = session?.user?.id || null; const email = session?.user?.email || null; if (!id && !email) return null;
  let user = id ? await PgDb.findUserById(id) : null; if (!user && email) user = await PgDb.findUserByUsername(email); return user && isAdmin(user) ? user : null;
}

function mapTemplate(row) {
  return normalizeFormDefinition({ id: row.slug, slug: row.slug, name: row.name, description: row.description || "", category: row.category || "General", schema: row.schema, layout: row.layout, theme: row.theme, bindings: row.bindings, actions: row.actions, queue_names: row.queue_names || [], queue_ids: [], auto_open: row.auto_open });
}

export async function GET() {
  const user = await requireAdmin(); if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (pool) {
    try {
      const { rows } = await pool.query("SELECT * FROM form_templates WHERE active = true ORDER BY sort_order ASC, name ASC");
      if (rows.length) return NextResponse.json({ ok: true, templates: rows.map(mapTemplate), count: rows.length });
    } catch (err) {
      console.warn("[Form Templates] Falling back to bundled templates:", err.message);
    }
  }
  const templates = getFormTemplates();
  return NextResponse.json({ ok: true, templates, count: templates.length });
}
