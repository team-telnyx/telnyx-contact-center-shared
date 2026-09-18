import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { resolveReportingScope } from "@/lib/acd/reporting-scope.mjs";
import {
  readHandoffReport,
  readSkillsReport,
} from "@/lib/acd/interaction-analytics.mjs";
import { readInteractionReport } from "@/lib/acd/interaction-reporting.mjs";
import {
  agentAdherenceReport,
  outboundCampaignsReport,
} from "@/lib/acd/workforce-reports.mjs";
import { transfersHoldsReport } from "@/lib/acd/transfer-hold-report.mjs";
import { withPermission } from "@/lib/authz/guard";
import { agentUsernamesInScope, campaignInScope, describeScope } from "@/lib/authz/scope.mjs";
const reports = [
  "queue-performance",
  "agent-performance",
  "abandonment",
  "wrapup-codes",
  "dashboard-today",
  "agent-adherence",
  "outbound-campaigns",
  "ai-handoffs",
  "skills-gap",
  "transfers-holds",
];
export const dynamic = "force-dynamic";
async function GET_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const params = new URL(request.url).searchParams,
      report = params.get("report");
    if (!reports.includes(report))
      throw Object.assign(new Error("Unknown report"), { status: 400 });
    const scope = await resolveReportingScope(db, params, authz.scope),
      queueName = params.get("queue");
    if (queueName)
      scope.queueId =
        (await db.query("SELECT id FROM cc_queues WHERE name=$1", [queueName]))
          .rows[0]?.id || "__missing_queue__";
    let data,
      applicability = null;
    if (report === "agent-adherence") {
      data = await agentAdherenceReport(db, scope);
      // Agent-level rows follow the caller's team/queue scope (Phase 3a).
      const usernames = await agentUsernamesInScope(db, authz.scope);
      if (usernames) {
        data.agents = data.agents.filter((row) => usernames.includes(row.username));
        if (Array.isArray(data.recentTransitions)) data.recentTransitions = data.recentTransitions.filter((row) => usernames.includes(row.agentUsername));
        // The aggregates follow the rows that remain (RBAC review fix).
        const statusTotals = {};
        for (const agent of data.agents) {
          for (const [status, value] of Object.entries(agent.statuses || {})) {
            if (!statusTotals[status]) statusTotals[status] = { changes: 0, durationSeconds: 0 };
            statusTotals[status].changes += Number(value?.changes || 0);
            statusTotals[status].durationSeconds += Number(value?.durationSeconds || 0);
          }
        }
        data.statusMix = Object.entries(statusTotals).map(([status, value]) => ({ status, ...value })).sort((a, b) => b.durationSeconds - a.durationSeconds).slice(0, 12);
        data.totals = {
          agents: data.agents.length,
          statusChanges: data.agents.reduce((sum, agent) => sum + Number(agent.statusChanges || 0), 0),
          logins: data.agents.reduce((sum, agent) => sum + Number(agent.logins || 0), 0),
        };
      }
    } else if (report === "outbound-campaigns") {
      if (scope.channel && scope.channel !== "voice")
        applicability = "Outbound campaign analytics apply to Voice.";
      else {
        data = await outboundCampaignsReport(db, { ...scope, campaignIds: authz.scope?.restricted ? authz.scope.campaignIds : null });
        if (Array.isArray(data?.campaigns)) data.campaigns = data.campaigns.filter((row) => campaignInScope(authz.scope, row.id ?? row.campaignId));
      }
    } else if (report === "ai-handoffs")
      data = await readHandoffReport(db, scope);
    else if (report === "skills-gap") data = await readSkillsReport(db, scope);
    else if (report === "transfers-holds")
      data = await transfersHoldsReport(db, { ...scope, queueName });
    else data = await readInteractionReport(db, scope, report);
    await db.query("COMMIT");
    return NextResponse.json(
      {
        ok: true,
        report,
        range: { from: scope.from, to: scope.to },
        scope: { ...scope, restriction: describeScope(authz.scope) },
        data,
        applicability,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    await db.query("ROLLBACK");
    return NextResponse.json(
      { error: error.status ? error.message : "Report unavailable" },
      { status: error.status || 500 },
    );
  } finally {
    db.release();
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("reports:read", GET_handler, { route: "/api/contact-center/analytics" });
