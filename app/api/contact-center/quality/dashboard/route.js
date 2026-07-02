import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { createDiagnosticLogger } from "@/lib/diagnostic-logger.mjs";

const qualityLogger = createDiagnosticLogger("contact-center.quality");

const MAX_RANGE_DAYS = 92;

function clampDateRange(fromIso, toIso) {
  const now = new Date();
  let to = toIso ? new Date(toIso) : now;
  if (Number.isNaN(to.getTime())) to = now;
  let from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 30 * 86400000);
  if (Number.isNaN(from.getTime())) from = new Date(to.getTime() - 30 * 86400000);
  const maxSpan = MAX_RANGE_DAYS * 86400000;
  if (to.getTime() - from.getTime() > maxSpan) {
    from = new Date(to.getTime() - maxSpan);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * GET /api/contact-center/quality/dashboard
 * Quality overview for the supervisor dashboard: totals, averages,
 * per-agent / per-form / per-queue scores, and daily trend.
 */
export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const { from, to } = clampDateRange(searchParams.get("from"), searchParams.get("to"));
    const vals = [from, to];
    const whereSql = "WHERE e.created_at >= $1 AND e.created_at <= $2";

    const totalsQuery = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE e.status = 'final')::int AS finalized,
        COUNT(*) FILTER (WHERE e.status = 'ai_draft')::int AS ai_drafts,
        COUNT(*) FILTER (WHERE e.status IN ('draft', 'reviewed'))::int AS in_progress,
        COUNT(*) FILTER (WHERE e.status = 'disputed')::int AS disputed,
        COUNT(*) FILTER (WHERE e.evaluator_type = 'ai')::int AS ai_evaluations,
        COUNT(*) FILTER (WHERE e.evaluator_type = 'human')::int AS human_evaluations,
        COUNT(*) FILTER (WHERE e.evaluator_type = 'hybrid')::int AS hybrid_evaluations,
        AVG(e.score_percent) FILTER (WHERE e.status IN ('reviewed', 'final'))::NUMERIC(5,2) AS avg_score_percent
      FROM quality_evaluations e
      ${whereSql}
    `;
    const agentsQuery = `
      SELECT
        e.agent_username,
        COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), e.agent_username) AS agent_name,
        COUNT(*)::int AS evaluations,
        AVG(e.score_percent)::NUMERIC(5,2) AS avg_score_percent
      FROM quality_evaluations e
      LEFT JOIN users u ON u.username = e.agent_username
      ${whereSql} AND e.agent_username IS NOT NULL AND e.status IN ('reviewed', 'final')
      GROUP BY e.agent_username, u.first_name, u.last_name
      ORDER BY avg_score_percent DESC NULLS LAST
      LIMIT 12
    `;
    const formsQuery = `
      SELECT
        f.name AS form_name,
        COUNT(*)::int AS evaluations,
        AVG(e.score_percent)::NUMERIC(5,2) AS avg_score_percent
      FROM quality_evaluations e
      JOIN quality_forms f ON f.id = e.form_id
      ${whereSql}
      GROUP BY f.name
      ORDER BY evaluations DESC
      LIMIT 12
    `;
    const queuesQuery = `
      SELECT
        COALESCE(e.queue_name, 'No queue') AS queue_name,
        COUNT(*)::int AS evaluations,
        AVG(e.score_percent)::NUMERIC(5,2) AS avg_score_percent
      FROM quality_evaluations e
      ${whereSql}
      GROUP BY COALESCE(e.queue_name, 'No queue')
      ORDER BY evaluations DESC
      LIMIT 12
    `;
    const dailyQuery = `
      SELECT
        DATE(e.created_at) AS day,
        COUNT(*)::int AS evaluations,
        AVG(e.score_percent)::NUMERIC(5,2) AS avg_score_percent
      FROM quality_evaluations e
      ${whereSql}
      GROUP BY DATE(e.created_at)
      ORDER BY DATE(e.created_at) ASC
    `;

    const [totalsRes, agentsRes, formsRes, queuesRes, dailyRes] = await Promise.all([
      pool.query(totalsQuery, vals),
      pool.query(agentsQuery, vals),
      pool.query(formsQuery, vals),
      pool.query(queuesQuery, vals),
      pool.query(dailyQuery, vals),
    ]);

    const totals = totalsRes.rows[0] || {};

    return NextResponse.json({
      ok: true,
      data: {
        totals: {
          total: Number(totals.total || 0),
          finalized: Number(totals.finalized || 0),
          aiDrafts: Number(totals.ai_drafts || 0),
          inProgress: Number(totals.in_progress || 0),
          disputed: Number(totals.disputed || 0),
          aiEvaluations: Number(totals.ai_evaluations || 0),
          humanEvaluations: Number(totals.human_evaluations || 0),
          hybridEvaluations: Number(totals.hybrid_evaluations || 0),
          avgScorePercent:
            totals.avg_score_percent != null ? Number(totals.avg_score_percent) : null,
        },
        agents: agentsRes.rows.map((row) => ({
          agentUsername: row.agent_username,
          agentName: row.agent_name,
          evaluations: Number(row.evaluations || 0),
          avgScorePercent:
            row.avg_score_percent != null ? Number(row.avg_score_percent) : null,
        })),
        forms: formsRes.rows.map((row) => ({
          formName: row.form_name,
          evaluations: Number(row.evaluations || 0),
          avgScorePercent:
            row.avg_score_percent != null ? Number(row.avg_score_percent) : null,
        })),
        queues: queuesRes.rows.map((row) => ({
          queueName: row.queue_name,
          evaluations: Number(row.evaluations || 0),
          avgScorePercent:
            row.avg_score_percent != null ? Number(row.avg_score_percent) : null,
        })),
        daily: dailyRes.rows.map((row) => ({
          day: row.day,
          label: new Date(row.day).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          evaluations: Number(row.evaluations || 0),
          avgScorePercent:
            row.avg_score_percent != null ? Number(row.avg_score_percent) : null,
        })),
      },
    });
  } catch (error) {
    qualityLogger.error("quality_dashboard_failed", { error: error?.message });
    return NextResponse.json(
      { ok: false, error: "Failed to load quality dashboard" },
      { status: 500 },
    );
  }
}
