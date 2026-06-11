import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { panicStop } from "@/lib/call-generator/engine.mjs";
import { stopRunLoop } from "@/lib/call-generator/runner.mjs";
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
  params = await params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
export async function PATCH(request, { params }) {
  params = await params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
