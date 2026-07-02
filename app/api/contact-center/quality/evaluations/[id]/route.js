import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { createDiagnosticLogger } from "@/lib/diagnostic-logger.mjs";
import { computeEvaluationScore } from "@/lib/quality/scoring.mjs";

const qualityLogger = createDiagnosticLogger("contact-center.quality");

async function guard() {
  const user = await getAuthenticatedUser();
  if (!user) {
    return { error: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }) };
  }
  if (!isSupervisorOrAdmin(user)) {
    return { error: NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 }) };
  }
  const pool = getPostgresPool();
  if (!pool) {
    return { error: NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 }) };
  }
  return { user, pool };
}

async function loadEvaluationBundle(pool, id) {
  const result = await pool.query(
    `SELECT
       e.*,
       f.name AS form_name,
       f.schema AS form_schema,
       f.scoring_config AS form_scoring_config,
       j.id AS ai_job_id,
       j.status AS ai_job_status,
       j.error_message AS ai_job_error
     FROM quality_evaluations e
     JOIN quality_forms f ON f.id = e.form_id
     LEFT JOIN LATERAL (
       SELECT id, status, error_message
       FROM quality_ai_jobs
       WHERE evaluation_id = e.id
       ORDER BY created_at DESC
       LIMIT 1
     ) j ON true
     WHERE e.id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

/**
 * GET /api/contact-center/quality/evaluations/[id]
 * Returns evaluation + form schema + interaction (with recording/transcript info).
 */
export async function GET(request, { params }) {
  try {
    const { error, pool } = await guard();
    if (error) return error;

    const { id } = (await params) || {};
    const evaluation = await loadEvaluationBundle(pool, id);
    if (!evaluation) {
      return NextResponse.json({ ok: false, error: "Evaluation not found" }, { status: 404 });
    }

    const interactionRes = await pool.query(
      `SELECT i.*, u.first_name, u.last_name
       FROM cc_interactions i
       LEFT JOIN users u ON i.agent_username = u.username
       WHERE i.id = $1`,
      [evaluation.interaction_id],
    );
    const interaction = interactionRes.rows[0] || null;
    if (interaction && typeof interaction.metadata === "string") {
      try {
        interaction.metadata = JSON.parse(interaction.metadata);
      } catch {
        interaction.metadata = {};
      }
    }

    return NextResponse.json({ ok: true, evaluation, interaction });
  } catch (error) {
    qualityLogger.error("quality_evaluation_get_failed", { error: error?.message });
    return NextResponse.json({ ok: false, error: "Failed to load evaluation" }, { status: 500 });
  }
}

/**
 * PATCH /api/contact-center/quality/evaluations/[id]
 * Save answers / notes / status transitions. Recomputes scores from answers.
 * body: { answers?, review_notes?, action?: "save" | "finalize" | "dispute" }
 */
export async function PATCH(request, { params }) {
  try {
    const { error, user, pool } = await guard();
    if (error) return error;

    const { id } = (await params) || {};
    const body = await request.json().catch(() => ({}));

    const evaluation = await loadEvaluationBundle(pool, id);
    if (!evaluation) {
      return NextResponse.json({ ok: false, error: "Evaluation not found" }, { status: 404 });
    }
    if (evaluation.status === "final" && body.action !== "dispute") {
      return NextResponse.json(
        { ok: false, error: "Evaluation is finalized" },
        { status: 409 },
      );
    }

    const answers =
      body.answers && typeof body.answers === "object"
        ? body.answers
        : evaluation.answers || {};
    const schema = evaluation.form_schema || { sections: [] };
    const scoringConfig = evaluation.form_scoring_config || {};
    const score = computeEvaluationScore(schema, answers, scoringConfig);

    let status = evaluation.status;
    let evaluatorType = evaluation.evaluator_type;
    const action = body.action || "save";
    if (action === "finalize") {
      status = "final";
      if (evaluation.evaluator_type === "ai" || evaluation.status === "ai_draft") {
        evaluatorType = "hybrid";
      }
    } else if (action === "dispute") {
      status = "disputed";
    } else if (evaluation.status === "ai_draft" && body.answers) {
      status = "reviewed";
      evaluatorType = "hybrid";
    } else if (evaluation.status === "draft" && body.answers) {
      status = "draft";
    }

    const result = await pool.query(
      `UPDATE quality_evaluations
       SET answers = $2,
           review_notes = COALESCE($3, review_notes),
           status = $4,
           evaluator_type = $5,
           evaluator_username = $6,
           score_total = $7,
           score_max = $8,
           score_percent = $9,
           finalized_at = CASE WHEN $4 = 'final' THEN NOW() ELSE finalized_at END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        JSON.stringify(answers),
        body.review_notes !== undefined ? body.review_notes : null,
        status,
        evaluatorType,
        user.username || user.email || "unknown",
        score.scoreTotal,
        score.scoreMax,
        score.scorePercent,
      ],
    );

    return NextResponse.json({ ok: true, evaluation: result.rows[0], score });
  } catch (error) {
    qualityLogger.error("quality_evaluation_update_failed", { error: error?.message });
    return NextResponse.json(
      { ok: false, error: "Failed to update evaluation" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/contact-center/quality/evaluations/[id]
 * Deletes a non-final evaluation draft.
 */
export async function DELETE(request, { params }) {
  try {
    const { error, pool } = await guard();
    if (error) return error;

    const { id } = (await params) || {};
    const result = await pool.query(
      `DELETE FROM quality_evaluations WHERE id = $1 AND status <> 'final' RETURNING id`,
      [id],
    );
    if (!result.rows[0]) {
      return NextResponse.json(
        { ok: false, error: "Evaluation not found or already finalized" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    qualityLogger.error("quality_evaluation_delete_failed", { error: error?.message });
    return NextResponse.json(
      { ok: false, error: "Failed to delete evaluation" },
      { status: 500 },
    );
  }
}
