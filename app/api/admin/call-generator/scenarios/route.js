import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { randomUUID } from "crypto";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


async function GET_handler(_request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, status, config, created_by, organization_id, created_at, updated_at
       FROM cg_scenarios ORDER BY updated_at DESC`
    );
    return NextResponse.json({ scenarios: rows });
  } catch {
    return NextResponse.json({ error: "Failed to load scenarios" }, { status: 500 });
  }
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json();
    const { name, description, tasks, config } = body;
    if (!name || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO cg_scenarios (id, name, description, status, tasks, config, created_by, organization_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [
        id,
        name.trim(),
        description || null,
        body.status || "draft",
        tasks ? JSON.stringify(tasks) : "[]",
        config ? JSON.stringify(config) : "{}",
        String(user.id || ""),
        String(user.organization_id || ""),
      ]
    );
    const scenario = (await pool.query("SELECT * FROM cg_scenarios WHERE id = $1", [id])).rows[0];
    return NextResponse.json({ scenario }, { status: 201 });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_scenario_create_failed", runtimePayload({ error: err, operation: "cg_scenario_create" }));
    return NextResponse.json({ error: "Failed to create scenario" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("call_generator:read", GET_handler, { route: "/api/admin/call-generator/scenarios" });
export const POST = withPermission("call_generator:create", POST_handler, { route: "/api/admin/call-generator/scenarios" });
