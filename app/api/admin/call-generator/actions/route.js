import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { randomUUID } from "crypto";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { normalizeSteps } from "@/lib/call-generator/actions.mjs";
import { ensureWorkflowTestingAction } from "@/lib/call-generator/workflow-testing.mjs";

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

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
