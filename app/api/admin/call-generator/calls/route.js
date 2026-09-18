import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { disconnectActiveCalls } from "@/lib/call-generator/engine.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


// POST { action: "disconnect_all", run_id? } — gracefully hang up every
// active generated call (optionally scoped to one run). Unlike panic, runs
// keep their status; ledger rows finalize through the normal webhook flow.
async function POST_handler(request, _context, authz) {
  const user = authz.user;
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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("call_generator:create", POST_handler, { route: "/api/admin/call-generator/calls" });
