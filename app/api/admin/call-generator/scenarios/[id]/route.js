import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) return null;
  if (!isAdmin(user)) return null;
  return user;
}

export async function GET(_request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const { rows } = await pool.query("SELECT * FROM cg_scenarios WHERE id = $1", [id]);
    if (!rows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ scenario: rows[0] });
  } catch {
    return NextResponse.json({ error: "Failed to load scenario" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, description, status, tasks, config } = body;
    const columns = [];
    const values = [];
    let idx = 1;
    if (name !== undefined) { columns.push(`name = $${idx++}`); values.push(name.trim()); }
    if (description !== undefined) { columns.push(`description = $${idx++}`); values.push(description || null); }
    if (status !== undefined) { columns.push(`status = $${idx++}`); values.push(status); }
    if (tasks !== undefined) { columns.push(`tasks = $${idx++}`); values.push(JSON.stringify(tasks)); }
    if (config !== undefined) { columns.push(`config = $${idx++}`); values.push(JSON.stringify(config)); }
    if (columns.length === 0) return NextResponse.json({ error: "No changes" }, { status: 400 });
    values.push(id);
    await pool.query(`UPDATE cg_scenarios SET ${columns.join(", ")} WHERE id = $${idx}`, values);
    const { rows } = await pool.query("SELECT * FROM cg_scenarios WHERE id = $1", [id]);
    return NextResponse.json({ scenario: rows[0] });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_scenario_update_failed", runtimePayload({ error: err, operation: "cg_scenario_update" }));
    return NextResponse.json({ error: "Failed to update scenario" }, { status: 500 });
  }
}

export async function DELETE(_request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    await pool.query("DELETE FROM cg_scenarios WHERE id = $1", [id]);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}
