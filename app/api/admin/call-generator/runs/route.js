import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { randomUUID } from "crypto";

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
      `SELECT r.*, s.name AS scenario_name
       FROM cg_runs r
       JOIN cg_scenarios s ON s.id = r.scenario_id
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
    const id = randomUUID();
    await pool.query(
      `INSERT INTO cg_runs (id, scenario_id, status, started_at, config, created_at)
       VALUES ($1, $2, $3, NOW(), $4, NOW())`,
      [id, scenario_id, "running", JSON.stringify(config || {})]
    );
    const run = (await pool.query("SELECT * FROM cg_runs WHERE id = $1", [id])).rows[0];
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    console.error("[CG] POST run error:", err);
    return NextResponse.json({ error: "Failed to start run" }, { status: 500 });
  }
}
