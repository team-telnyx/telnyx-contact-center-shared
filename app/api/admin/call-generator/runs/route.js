import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { randomUUID } from "crypto";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { startRunLoop } from "@/lib/call-generator/runner.mjs";
import { isCallGeneratorEnabled } from "@/lib/call-generator/engine.mjs";

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

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const url = new URL(request.url);
    // scope=historical → runs that are no longer live (used by the Logs view).
    // scope=active → live runs only. Anything else returns all runs (legacy).
    const scope = String(url.searchParams.get("scope") || "").toLowerCase();

    let where = "";
    if (scope === "historical") {
      where = `WHERE r.status NOT IN ('pending','running')`;
    } else if (scope === "active") {
      where = `WHERE r.status IN ('pending','running')`;
    }

    // Optional pagination. When page/pageSize are supplied (Logs view) we return
    // a window plus the total count so the client can render a pager. Without
    // them we keep the legacy behaviour (single LIMIT 200 list).
    const hasPaging = url.searchParams.has("page") || url.searchParams.has("pageSize");
    if (hasPaging) {
      const allowedSizes = [10, 25, 50];
      let pageSize = parseInt(url.searchParams.get("pageSize"), 10);
      if (!allowedSizes.includes(pageSize)) pageSize = 25;
      let page = parseInt(url.searchParams.get("page"), 10);
      if (!Number.isInteger(page) || page < 1) page = 1;
      const offset = (page - 1) * pageSize;

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM cg_runs r ${where}`
      );
      const total = countRows[0]?.total || 0;
      const { rows } = await pool.query(
        `SELECT r.*, s.name AS scenario_name
         FROM cg_runs r
         JOIN cg_scenarios s ON s.id = r.scenario_id
         ${where}
         ORDER BY r.created_at DESC
         LIMIT $1 OFFSET $2`,
        [pageSize, offset]
      );
      return NextResponse.json({ runs: rows, total, page, pageSize });
    }

    const { rows } = await pool.query(
      `SELECT r.*, s.name AS scenario_name
       FROM cg_runs r
       JOIN cg_scenarios s ON s.id = r.scenario_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT 200`
    );
    return NextResponse.json({ runs: rows });
  } catch {
    return NextResponse.json({ error: "Failed to load runs" }, { status: 500 });
  }
}

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json();
    const { scenario_id, config } = body;
    if (!scenario_id) {
      return NextResponse.json({ error: "scenario_id is required" }, { status: 400 });
    }
    if (!(await isCallGeneratorEnabled(pool))) {
      return NextResponse.json({ error: "Call Generator is disabled — enable it in Settings first" }, { status: 409 });
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO cg_runs (id, scenario_id, status, config, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [id, scenario_id, "pending", JSON.stringify(config || {})]
    );
    const startResult = await startRunLoop(pool, id);
    if (!startResult.ok) {
      await pool.query(`UPDATE cg_runs SET status = 'failed', stopped_at = NOW(), stats = $2 WHERE id = $1`, [id, JSON.stringify({ error: startResult.reason })]);
      return NextResponse.json({ error: `Run could not start: ${startResult.reason}` }, { status: 409 });
    }
    const run = (await pool.query("SELECT * FROM cg_runs WHERE id = $1", [id])).rows[0];
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_run_create_failed", runtimePayload({ error: err, operation: "cg_run_create" }));
    return NextResponse.json({ error: "Failed to start run" }, { status: 500 });
  }
}
