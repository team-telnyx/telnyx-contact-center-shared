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
  let from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 7 * 86400000);
  if (Number.isNaN(from.getTime())) from = new Date(to.getTime() - 7 * 86400000);
  const maxSpan = MAX_RANGE_DAYS * 86400000;
  if (to.getTime() - from.getTime() > maxSpan) {
    from = new Date(to.getTime() - maxSpan);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * GET /api/contact-center/quality/evaluations
 * Lists completed interactions in range with their evaluation state, plus
 * range metrics. Filters: from, to, queue, agent, status, recordedOnly.
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
    const page = Math.max(1, Number(searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("pageSize") || 25)));
    const { from, to } = clampDateRange(searchParams.get("from"), searchParams.get("to"));
    const queueName = searchParams.get("queue");
    const agentUsername = searchParams.get("agent");
    const statusFilter = searchParams.get("status");
    const recordedOnly = searchParams.get("recordedOnly") === "true";

    const where = [
      "i.is_contact_center = true",
      "COALESCE(i.metadata->>'is_transfer_leg', 'false') <> 'true'",
      "COALESCE(i.metadata->>'is_consult_call', 'false') <> 'true'",
      "(i.completed_at IS NOT NULL OR i.abandoned_at IS NOT NULL)",
    ];
    const vals = [from, to];
    where.push("COALESCE(i.completed_at, i.abandoned_at, i.created_at) >= $1");
    where.push("COALESCE(i.completed_at, i.abandoned_at, i.created_at) <= $2");
    let idx = 3;

    if (queueName && queueName !== "all") {
      where.push(`i.queue_name = $${idx++}`);
      vals.push(queueName);
    }
    if (agentUsername && agentUsername !== "all") {
      where.push(`i.agent_username = $${idx++}`);
      vals.push(agentUsername);
    }
    if (recordedOnly) {
      where.push(
        "(i.recording_url IS NOT NULL OR i.metadata->'recording'->>'recording_id' IS NOT NULL)",
      );
    }
    if (statusFilter && statusFilter !== "all") {
      if (statusFilter === "not_evaluated") {
        where.push("e.id IS NULL");
      } else {
        where.push(`e.status = $${idx++}`);
        vals.push(statusFilter);
      }
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const joinSql = `
      LEFT JOIN LATERAL (
        SELECT qe.id, qe.status, qe.score_percent, qe.evaluator_type, qe.form_id, qe.updated_at
        FROM quality_evaluations qe
        WHERE qe.interaction_id = i.id
        ORDER BY qe.updated_at DESC
        LIMIT 1
      ) e ON true
    `;

    const offset = (page - 1) * pageSize;
    const rowsQuery = `
      SELECT
        i.id, i.queue_name, i.agent_username, i.direction, i.state,
        i.from_number, i.to_number, i.from_name, i.to_name,
        i.completed_at, i.abandoned_at, i.created_at,
        i.handle_time_seconds, i.talk_time_seconds,
        i.recording_url,
        i.metadata->'recording'->>'recording_id' AS recording_id,
        (i.metadata->>'transcription_text' IS NOT NULL) AS has_transcript,
        u.first_name, u.last_name,
        e.id AS evaluation_id,
        e.status AS evaluation_status,
        e.score_percent AS evaluation_score_percent,
        e.evaluator_type AS evaluation_evaluator_type,
        e.form_id AS evaluation_form_id
      FROM cc_interactions i
      LEFT JOIN users u ON i.agent_username = u.username
      ${joinSql}
      ${whereSql}
      ORDER BY COALESCE(i.completed_at, i.abandoned_at, i.created_at) DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    const countQuery = `
      SELECT COUNT(*) AS c
      FROM cc_interactions i
      ${joinSql}
      ${whereSql}
    `;
    const metricsQuery = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE i.recording_url IS NOT NULL OR i.metadata->'recording'->>'recording_id' IS NOT NULL)::int AS recorded,
        COUNT(*) FILTER (WHERE e.id IS NOT NULL)::int AS evaluated,
        COUNT(*) FILTER (WHERE e.status = 'ai_draft')::int AS ai_drafts,
        COUNT(*) FILTER (WHERE e.status = 'final')::int AS finalized,
        AVG(e.score_percent) FILTER (WHERE e.status IN ('reviewed', 'final'))::NUMERIC(5,2) AS avg_score_percent
      FROM cc_interactions i
      ${joinSql}
      ${whereSql}
    `;

    const [rowsRes, countRes, metricsRes, queuesRes, agentsRes] = await Promise.all([
      pool.query(rowsQuery, [...vals, pageSize, offset]),
      pool.query(countQuery, vals),
      pool.query(metricsQuery, vals),
      pool.query(
        `SELECT DISTINCT queue_name FROM cc_interactions WHERE queue_name IS NOT NULL ORDER BY queue_name ASC`,
      ),
      pool.query(
        `SELECT DISTINCT u.username, u.first_name, u.last_name
         FROM users u
         JOIN cc_interactions i ON i.agent_username = u.username
         ORDER BY u.username ASC`,
      ),
    ]);

    const metrics = metricsRes.rows[0] || {};

    return NextResponse.json({
      ok: true,
      rows: rowsRes.rows.map((row) => ({
        ...row,
        agent_name:
          row.first_name || row.last_name
            ? `${row.first_name || ""} ${row.last_name || ""}`.trim()
            : row.agent_username || null,
      })),
      count: Number(countRes.rows?.[0]?.c || 0),
      metrics: {
        total: Number(metrics.total || 0),
        recorded: Number(metrics.recorded || 0),
        evaluated: Number(metrics.evaluated || 0),
        aiDrafts: Number(metrics.ai_drafts || 0),
        finalized: Number(metrics.finalized || 0),
        avgScorePercent: metrics.avg_score_percent != null ? Number(metrics.avg_score_percent) : null,
      },
      filters: {
        queues: queuesRes.rows.map((row) => row.queue_name),
        agents: agentsRes.rows.map((row) => ({
          username: row.username,
          name:
            row.first_name || row.last_name
              ? `${row.first_name || ""} ${row.last_name || ""}`.trim()
              : row.username,
        })),
      },
    });
  } catch (error) {
    qualityLogger.error("quality_evaluations_list_failed", { error: error?.message });
    return NextResponse.json(
      { ok: false, error: "Failed to list evaluations" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/contact-center/quality/evaluations
 * Create (or return existing draft) evaluation for an interaction + form.
 */
export async function POST(request) {
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

    const body = await request.json().catch(() => ({}));
    const interactionId = body.interaction_id;
    const formId = body.form_id;
    if (!interactionId || !formId) {
      return NextResponse.json(
        { ok: false, error: "interaction_id and form_id are required" },
        { status: 400 },
      );
    }

    const [interactionRes, formRes] = await Promise.all([
      pool.query(
        "SELECT id, agent_username, queue_name FROM cc_interactions WHERE id = $1",
        [interactionId],
      ),
      pool.query("SELECT id, version, status FROM quality_forms WHERE id = $1", [formId]),
    ]);
    const interaction = interactionRes.rows[0];
    const form = formRes.rows[0];
    if (!interaction) {
      return NextResponse.json({ ok: false, error: "Interaction not found" }, { status: 404 });
    }
    if (!form) {
      return NextResponse.json({ ok: false, error: "Form not found" }, { status: 404 });
    }

    // Reuse an open evaluation for the same interaction+form when present.
    const existing = await pool.query(
      `SELECT * FROM quality_evaluations
       WHERE interaction_id = $1 AND form_id = $2 AND status NOT IN ('final')
       ORDER BY updated_at DESC LIMIT 1`,
      [interactionId, formId],
    );
    if (existing.rows[0]) {
      return NextResponse.json({ ok: true, evaluation: existing.rows[0], existing: true });
    }

    const result = await pool.query(
      `INSERT INTO quality_evaluations
         (interaction_id, form_id, form_version, evaluator_type, evaluator_username, agent_username, queue_name, status)
       VALUES ($1, $2, $3, 'human', $4, $5, $6, 'draft')
       RETURNING *`,
      [
        interactionId,
        formId,
        form.version || 1,
        user.username || user.email || "unknown",
        interaction.agent_username || null,
        interaction.queue_name || null,
      ],
    );

    return NextResponse.json({ ok: true, evaluation: result.rows[0] });
  } catch (error) {
    qualityLogger.error("quality_evaluation_create_failed", { error: error?.message });
    return NextResponse.json(
      { ok: false, error: "Failed to create evaluation" },
      { status: 500 },
    );
  }
}
