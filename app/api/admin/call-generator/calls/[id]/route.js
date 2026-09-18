import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { disconnectGeneratedCall } from "@/lib/call-generator/engine.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


// PATCH { action: "disconnect" } — gracefully hang up a single generated
// call identified by its cg_call_ledger id. Status finalization happens via
// the call.hangup webhook so the call keeps its normal lifecycle.
async function PATCH_handler(request, { params }, authz) {
  const user = authz.user;
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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const PATCH = withPermission("call_generator:update", PATCH_handler, { route: "/api/admin/call-generator/calls/[id]" });
