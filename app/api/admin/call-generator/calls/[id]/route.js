import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { disconnectGeneratedCall } from "@/lib/call-generator/engine.mjs";
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

// PATCH { action: "disconnect" } — gracefully hang up a single generated
// call identified by its cg_call_ledger id. Status finalization happens via
// the call.hangup webhook so the call keeps its normal lifecycle.
export async function PATCH(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "");
    if (action !== "disconnect") {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    const result = await disconnectGeneratedCall(pool, id);
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : 409;
      return NextResponse.json({ error: `Disconnect failed: ${result.reason}` }, { status });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    adminRuntimeLogger.error("call_generator_disconnect_failed", runtimePayload({ error: err, operation: "cg_call_disconnect" }));
    return NextResponse.json({ error: "Failed to disconnect call" }, { status: 500 });
  }
}
