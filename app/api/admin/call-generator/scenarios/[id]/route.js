import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


async function GET_handler(_request, { params }, authz) {
  const user = authz.user;
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

async function PUT_handler(request, { params }, authz) {
  const user = authz.user;
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

async function DELETE_handler(_request, { params }, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT id FROM cg_scenarios WHERE id=$1 FOR UPDATE', [id]);
      const active = await db.query(`SELECT 1 FROM cg_runs r WHERE r.scenario_id=$1 AND (r.status IN ('pending','running')
        OR EXISTS(SELECT 1 FROM cg_call_ledger l WHERE l.run_id=r.id AND l.dial_requested_at IS NOT NULL
          AND l.media_ended_at IS NULL AND COALESCE(l.result->>'dial_rejected','false')<>'true')) LIMIT 1`, [id]);
      if (active.rowCount) {
        await db.query('ROLLBACK');
        return NextResponse.json({error:'Stop the scenario and wait for confirmed call cleanup before deleting it'}, {status:409});
      }
      await db.query("DELETE FROM cg_scenarios WHERE id = $1", [id]);
      await db.query('COMMIT');
    } catch(error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("call_generator:read", GET_handler, { route: "/api/admin/call-generator/scenarios/[id]" });
export const PUT = withPermission("call_generator:update", PUT_handler, { route: "/api/admin/call-generator/scenarios/[id]" });
export const DELETE = withPermission("call_generator:delete", DELETE_handler, { route: "/api/admin/call-generator/scenarios/[id]" });
