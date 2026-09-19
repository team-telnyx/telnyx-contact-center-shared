import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { resolveReportingScope } from "@/lib/acd/reporting-scope.mjs";
import {
  readInteractionReport,
  readLiveWorkload,
} from "@/lib/acd/interaction-reporting.mjs";
import { agentAdherenceReport } from "@/lib/acd/workforce-reports.mjs";
import { withPermission } from "@/lib/authz/guard";
export const dynamic = "force-dynamic";
async function GET_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const scope = await resolveReportingScope(
      db,
      new URL(request.url).searchParams,
      authz.scope,
    );
    scope.agentId = String(user.id);
    const report = await readInteractionReport(db, scope);
    report.workforce = await agentAdherenceReport(db, scope);
    report.workload = await readLiveWorkload(db, scope.agentId);
    for (const row of report.channels) {
      const live = report.workload.interactions.filter(
        (item) =>
          item.channel === row.channel &&
          !item.terminal_at &&
          !item.release_requested_at &&
          (!scope.queueId ||
            item.queue_id === scope.queueId ||
            (scope.queueId === "none" && !item.queue_id)),
      );
      row.waiting = live.filter((item) =>
        ["open", "queued"].includes(item.state),
      ).length;
      row.offered = live.filter((item) =>
        ["reserved", "ringing"].includes(item.reservation_state),
      ).length;
      row.active = live.filter(
        (item) =>
          item.state === "active" &&
          item.reservation_state === "active" &&
          item.assignment_state !== "wrapup",
      ).length;
    }
    for (const key of ["waiting", "offered", "active"])
      report.totals[key] = report.channels.reduce(
        (sum, row) => sum + row[key],
        0,
      );
    report.filters = {
      queues: (
        await db.query(
          `SELECT DISTINCT q.id,q.name,q.display_name FROM cc_queues q
      WHERE EXISTS(SELECT 1 FROM acd_segments s WHERE s.queue_id=q.id AND s.agent_id=$1)
      OR EXISTS(SELECT 1 FROM cc_queue_user_assignments a WHERE a.queue_id=q.id AND a.user_id=$1) ORDER BY q.name`,
          [scope.agentId],
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
      { error: error.status ? error.message : "Dashboard unavailable" },
      { status: error.status || 500 },
    );
  } finally {
    db.release();
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission(["reports:read","agent:self"], GET_handler, { route: "/api/dashboard/stats" });
