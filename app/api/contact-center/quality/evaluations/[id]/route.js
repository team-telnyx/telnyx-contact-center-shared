import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { createDiagnosticLogger } from "@/lib/diagnostic-logger.mjs";
import { computeEvaluationScore } from "@/lib/quality/scoring.mjs";
import { findWorkItemWithArtifacts } from "@/lib/acd/work-item-repository.mjs";
import { withPermission } from "@/lib/authz/guard";
import { workItemInScope } from "@/lib/authz/scope.mjs";

const qualityLogger = createDiagnosticLogger("contact-center.quality");

function guard(authz) {
  const pool = getPostgresPool();
  if (!pool) {
    return { error: NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 }) };
  }
  return { user: authz.user, pool };
}

// An evaluation is reachable only when its interaction is within the caller's data scope (Phase 3a).
async function evaluationInScope(pool, scope, evaluation) {
  if (!scope?.restricted) return true;
  if (!evaluation?.work_item_id) return false;
  const row = (await pool.query("SELECT queue_id, channel FROM acd_work_items WHERE id = $1", [evaluation.work_item_id])).rows[0];
  return workItemInScope(pool, scope, evaluation.work_item_id, { queueId: row?.queue_id, channel: row?.channel });
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
async function GET_handler(request, { params }, authz) {
  try {
    const { error, pool } = guard(authz);
    if (error) return error;

    const { id } = (await params) || {};
    const evaluation = await loadEvaluationBundle(pool, id);
    if (!evaluation || !(await evaluationInScope(pool, authz.scope, evaluation))) {
      return NextResponse.json({ ok: false, error: "Evaluation not found" }, { status: 404 });
    }

    const interaction = evaluation.work_item_id
      ? await findWorkItemWithArtifacts(pool, evaluation.work_item_id)
      : null;
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
async function PATCH_handler(request, { params }, authz) {
  try {
    const { error, user, pool } = guard(authz);
    if (error) return error;

    const { id } = (await params) || {};
    const body = await request.json().catch(() => ({}));

    const evaluation = await loadEvaluationBundle(pool, id);
    if (!evaluation || !(await evaluationInScope(pool, authz.scope, evaluation))) {
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
async function DELETE_handler(request, { params }, authz) {
  try {
    const { error, pool } = guard(authz);
    if (error) return error;

    const { id } = (await params) || {};
    if (authz.scope.restricted) {
      const existing = (await pool.query("SELECT work_item_id FROM quality_evaluations WHERE id = $1", [id])).rows[0];
      if (!existing || !(await evaluationInScope(pool, authz.scope, existing))) {
        return NextResponse.json({ ok: false, error: "Evaluation not found or already finalized" }, { status: 404 });
      }
    }
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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("quality_evaluations:read", GET_handler, { route: "/api/contact-center/quality/evaluations/[id]" });
export const PATCH = withPermission("quality_evaluations:update", PATCH_handler, { route: "/api/contact-center/quality/evaluations/[id]" });
export const DELETE = withPermission("quality_evaluations:delete", DELETE_handler, { route: "/api/contact-center/quality/evaluations/[id]" });
