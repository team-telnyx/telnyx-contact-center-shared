import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { randomUUID } from "crypto";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { normalizeSteps } from "@/lib/call-generator/actions.mjs";
import { ensureWorkflowTestingAction } from "@/lib/call-generator/workflow-testing.mjs";
import { withPermission } from "@/lib/authz/guard";


async function GET_handler(_request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    await ensureWorkflowTestingAction(pool);
    const { rows } = await pool.query(`SELECT * FROM cg_actions ORDER BY updated_at DESC LIMIT 200`);
    return NextResponse.json({ actions: rows });
  } catch {
    return NextResponse.json({ error: "Failed to load actions" }, { status: 500 });
  }
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json();
    const name = String(body?.name || "").trim();
    if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
    const steps = normalizeSteps(body?.steps);
    const id = randomUUID();
    await pool.query(
      `INSERT INTO cg_actions (id, name, description, steps, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [id, name, String(body?.description || "").trim() || null, JSON.stringify(steps), String(user.id || "")],
    );
    const action = (await pool.query(`SELECT * FROM cg_actions WHERE id = $1`, [id])).rows[0];
    return NextResponse.json({ action }, { status: 201 });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_action_create_failed", runtimePayload({ error: err, operation: "cg_action_create" }));
    return NextResponse.json({ error: "Failed to create action" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("call_generator:read", GET_handler, { route: "/api/admin/call-generator/actions" });
export const POST = withPermission("call_generator:create", POST_handler, { route: "/api/admin/call-generator/actions" });
