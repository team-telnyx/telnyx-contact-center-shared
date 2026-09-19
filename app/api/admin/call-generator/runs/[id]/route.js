import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { panicStop } from "@/lib/call-generator/engine.mjs";
import { stopRunLoop } from "@/lib/call-generator/runner.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


async function GET_handler(_request, { params }, authz) {
  params = await params;
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { rows } = await pool.query(
      `SELECT r.*, s.name AS scenario_name FROM cg_runs r JOIN cg_scenarios s ON s.id = r.scenario_id WHERE r.id = $1`,
      [params.id],
    );
    if (!rows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { rows: ledger } = await pool.query(
      `SELECT id, call_control_id, call_session_id, to_number, status, started_at, answered_at, ended_at, duration_ms, result
       FROM cg_call_ledger WHERE run_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [params.id],
    );
    const { rows: statRows } = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM cg_call_ledger WHERE run_id = $1 GROUP BY status`,
      [params.id],
    );
    const stats = Object.fromEntries(statRows.map((r) => [r.status, r.count]));
    return NextResponse.json({ run: rows[0], ledger, stats });
  } catch {
    return NextResponse.json({ error: "Failed to load run" }, { status: 500 });
  }
}

// PATCH { action: "stop" | "panic" }
async function PATCH_handler(request, { params }, authz) {
  params = await params;
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json();
    const action = String(body?.action || "");
    if (action === "stop") {
      stopRunLoop(params.id);
      await pool.query(`UPDATE cg_runs SET status = 'stopped', stopped_at = NOW() WHERE id = $1 AND status IN ('pending','running')`, [params.id]);
      return NextResponse.json({ ok: true, action: "stop" });
    }
    if (action === "panic") {
      stopRunLoop(params.id);
      const stopped = await panicStop(pool, params.id);
      return NextResponse.json({ ok: true, action: "panic", stoppedCalls: stopped });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_run_update_failed", runtimePayload({ error: err, operation: "cg_run_patch" }));
    return NextResponse.json({ error: "Failed to update run" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("call_generator:read", GET_handler, { route: "/api/admin/call-generator/runs/[id]" });
export const PATCH = withPermission("call_generator:update", PATCH_handler, { route: "/api/admin/call-generator/runs/[id]" });
