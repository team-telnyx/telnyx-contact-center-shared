import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { randomUUID } from "crypto";
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

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
