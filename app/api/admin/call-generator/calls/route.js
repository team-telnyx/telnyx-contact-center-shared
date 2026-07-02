import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { disconnectActiveCalls } from "@/lib/call-generator/engine.mjs";
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

// POST { action: "disconnect_all", run_id? } — gracefully hang up every
// active generated call (optionally scoped to one run). Unlike panic, runs
// keep their status; ledger rows finalize through the normal webhook flow.
export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "");
    if (action !== "disconnect_all") {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    const runId = body?.run_id ? String(body.run_id) : null;
    const disconnected = await disconnectActiveCalls(pool, runId);
    return NextResponse.json({ ok: true, disconnected });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_disconnect_all_failed", runtimePayload({ error: err, operation: "cg_calls_disconnect_all" }));
    return NextResponse.json({ error: "Failed to disconnect calls" }, { status: 500 });
  }
}
