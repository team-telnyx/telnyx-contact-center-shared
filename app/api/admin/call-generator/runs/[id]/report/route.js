import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildRunReport } from "@/lib/call-generator/correlation.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


// GET — build (or rebuild) the correlation report for a run and return it
// together with the per-call correlation rows.
async function GET_handler(_request, { params }, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const result = await buildRunReport(pool, id);
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (err) {
    adminRuntimeLogger.error("call_generator_report_failed", runtimePayload({ error: err, operation: "cg_run_report" }));
    return NextResponse.json({ error: "Failed to build report" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("call_generator:read", GET_handler, { route: "/api/admin/call-generator/runs/[id]/report" });
