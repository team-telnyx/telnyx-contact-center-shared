import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { resolveReportingScope } from "@/lib/acd/reporting-scope.mjs";
import { DETAIL_REPORTS } from "@/lib/acd/supervisor-report-details.mjs";
import {
  readInteractionReport,
  readLiveWorkload,
} from "@/lib/acd/interaction-reporting.mjs";
import { withPermission } from "@/lib/authz/guard";
import { interactionInScope, queueScopeSql } from "@/lib/authz/scope.mjs";
export const dynamic = "force-dynamic";
async function GET_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const params = new URL(request.url).searchParams;
    const section = params.get("report") || "overview";
    if (section !== "overview" && !DETAIL_REPORTS.includes(section))
      throw Object.assign(new Error("Unknown report"), { status: 400 });
    const scope = await resolveReportingScope(db, params, authz.scope);
    const report = await readInteractionReport(db, scope, section);
    report.workload = await readLiveWorkload(db, scope.agentId);
    if (authz.scope.restricted) {
      report.workload.interactions = report.workload.interactions.filter((item) =>
        interactionInScope(authz.scope, { channel: item.channel, queueIds: [item.queue_id], agentIds: [item.agent_id] }));
    }
    const queueVals = [];
    const queueWhere = queueScopeSql(authz.scope, "id", queueVals);
    report.filters = {
      queues: (
        await db.query(
          `SELECT id,name,display_name FROM cc_queues ${queueWhere.length ? `WHERE ${queueWhere.join(" AND ")}` : ""} ORDER BY name`,
          queueVals,
        )
      ).rows,
    };
    await db.query("COMMIT");
    return NextResponse.json(report, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    await db.query("ROLLBACK");
    return NextResponse.json(
      { error: error.status ? error.message : "Reporting unavailable" },
      { status: error.status || 500 },
    );
  } finally {
    db.release();
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("reports:read", GET_handler, { route: "/api/contact-center/reporting" });
