export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
export async function POST(request, context) {
  const session = await getServerSession(authOptions); if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params; const pool = getPostgresPool(); if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 }); const client = await pool.connect();
  try { await client.query("BEGIN"); const { rows } = await client.query(`UPDATE form_definitions SET status='published', version=version+1, published_at=NOW(), updated_at=NOW(), updated_by=$1 WHERE id=$2 RETURNING *`, [session.user.email || session.user.name || session.user.id, id]); const form = rows[0]; if (!form) { await client.query("ROLLBACK"); return NextResponse.json({ error: "Not found" }, { status: 404 }); } await client.query(`INSERT INTO form_versions (form_id, version, schema, layout, theme, bindings, actions, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (form_id, version) DO NOTHING`, [form.id, form.version, JSON.stringify(form.schema), JSON.stringify(form.layout), JSON.stringify(form.theme), JSON.stringify(form.bindings), JSON.stringify(form.actions), session.user.email || session.user.id]); await client.query("COMMIT"); return NextResponse.json({ ok: true, form }); } catch (err) { await client.query("ROLLBACK"); console.error("[Admin Forms] publish error:", err); return NextResponse.json({ error: "Failed to publish form" }, { status: 500 }); } finally { client.release(); }
}
