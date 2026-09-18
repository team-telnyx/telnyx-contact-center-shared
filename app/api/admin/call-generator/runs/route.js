import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { randomUUID } from "crypto";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { startRunLoop } from "@/lib/call-generator/runner.mjs";
import { isCallGeneratorEnabled } from "@/lib/call-generator/engine.mjs";
import { withPermission } from "@/lib/authz/guard";


async function GET_handler(request, _context, authz) {
  const user = authz.user;
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

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json();
    const { scenario_id, config } = body;
    const requestKey = body.request_key || null;
    if (requestKey && !/^[a-zA-Z0-9:_.-]{1,160}$/.test(requestKey)) {
      return NextResponse.json({ error: "Invalid request_key" }, { status: 400 });
    }
    if (!scenario_id) {
      return NextResponse.json({ error: "scenario_id is required" }, { status: 400 });
    }
    if (requestKey) {
      const existing = (await pool.query(`SELECT *, (scenario_id=$2::uuid AND request_config=$3::jsonb) AS matches
        FROM cg_runs WHERE request_key=$1`, [requestKey,scenario_id,JSON.stringify(config || {})])).rows[0];
      if (existing && !existing.matches) return NextResponse.json({ error: "request_key belongs to a different request" }, { status: 409 });
      if (existing) return NextResponse.json({ run: existing });
    }
    if (!(await isCallGeneratorEnabled(pool))) {
      return NextResponse.json({ error: "Call Generator is disabled — enable it in Settings first" }, { status: 409 });
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO cg_runs (id, scenario_id, status, config, created_at,request_key,request_config)
       VALUES ($1, $2, $3, $4, NOW(),$5,$4::jsonb)
       ON CONFLICT (request_key) WHERE request_key IS NOT NULL DO NOTHING`,
      [id, scenario_id, "pending", JSON.stringify(config || {}),requestKey]
    );
    if (requestKey) {
      const existing = (await pool.query(`SELECT *, (scenario_id=$2::uuid AND request_config=$3::jsonb) AS matches
        FROM cg_runs WHERE request_key=$1`,[requestKey,scenario_id,JSON.stringify(config || {})])).rows[0];
      if (existing.id !== id) {
        if (!existing.matches) return NextResponse.json({error:"request_key conflict"},{status:409});
        return NextResponse.json({run:existing});
      }
    }
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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("call_generator:read", GET_handler, { route: "/api/admin/call-generator/runs" });
export const POST = withPermission("call_generator:create", POST_handler, { route: "/api/admin/call-generator/runs" });
