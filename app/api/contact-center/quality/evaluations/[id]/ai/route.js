import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { createDiagnosticLogger } from "@/lib/diagnostic-logger.mjs";
import { PgDb } from "@/lib/pgdb";
import { evaluateTranscriptWithAi } from "@/lib/quality/ai-evaluator.mjs";
import {
  getExistingTranscript,
  resolveRecordingId,
  transcribeInteractionRecording,
} from "@/lib/quality/transcription.mjs";
import { DEFAULT_TRANSCRIPTION_MODEL } from "@/config/transcription-models";

const qualityLogger = createDiagnosticLogger("contact-center.quality");

async function setJobStatus(pool, jobId, status, extra = {}) {
  const sets = ["status = $2", "updated_at = NOW()"];
  const vals = [jobId, status];
  let idx = 3;
  if (extra.errorMessage !== undefined) {
    sets.push(`error_message = $${idx++}`);
    vals.push(extra.errorMessage);
  }
  if (status === "transcribing" || status === "evaluating") {
    sets.push("started_at = COALESCE(started_at, NOW())");
  }
  if (status === "completed" || status === "failed") {
    sets.push("completed_at = NOW()");
  }
  await pool.query(`UPDATE quality_ai_jobs SET ${sets.join(", ")} WHERE id = $1`, vals);
}

/**
 * POST /api/contact-center/quality/evaluations/[id]/ai
 *
 * Runs the AI evaluation pipeline for an evaluation:
 * 1. Creates a quality_ai_jobs record (status tracking).
 * 2. Ensures the interaction has a transcript (transcribes the recording when missing).
 * 3. Scores the configured quality form with the Telnyx AI chat API.
 * 4. Stores the AI draft on the evaluation (status: ai_draft).
 *
 * The request is synchronous: the UI shows phase via the job record if it polls,
 * and receives the full draft in this response when done.
 */
export async function POST(request, { params }) {
  let pool = null;
  let jobId = null;
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
    pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    }

    const { id } = (await params) || {};
    const body = await request.json().catch(() => ({}));

    const evaluationRes = await pool.query(
      `SELECT e.*, f.schema AS form_schema, f.scoring_config AS form_scoring_config, f.ai_prompt_config AS form_ai_prompt_config
       FROM quality_evaluations e
       JOIN quality_forms f ON f.id = e.form_id
       WHERE e.id = $1`,
      [id],
    );
    const evaluation = evaluationRes.rows[0];
    if (!evaluation) {
      return NextResponse.json({ ok: false, error: "Evaluation not found" }, { status: 404 });
    }
    if (evaluation.status === "final") {
      return NextResponse.json(
        { ok: false, error: "Evaluation is finalized" },
        { status: 409 },
      );
    }

    const runningJob = await pool.query(
      `SELECT id FROM quality_ai_jobs
       WHERE evaluation_id = $1 AND status IN ('queued', 'transcribing', 'evaluating')
       LIMIT 1`,
      [id],
    );
    if (runningJob.rows[0]) {
      return NextResponse.json(
        { ok: false, error: "An AI evaluation is already running for this evaluation" },
        { status: 409 },
      );
    }

    const interaction = await PgDb.findInteractionById(evaluation.interaction_id);
    if (!interaction) {
      return NextResponse.json({ ok: false, error: "Interaction not found" }, { status: 404 });
    }

    const recordingId = resolveRecordingId(interaction);
    let transcript = getExistingTranscript(interaction);
    if (!transcript && !recordingId) {
      return NextResponse.json(
        { ok: false, error: "Interaction has no transcript and no recording to transcribe" },
        { status: 422 },
      );
    }

    const transcriptionModel = body.transcription_model || DEFAULT_TRANSCRIPTION_MODEL;
    const jobRes = await pool.query(
      `INSERT INTO quality_ai_jobs (evaluation_id, interaction_id, recording_id, status, transcription_model)
       VALUES ($1, $2, $3, 'queued', $4)
       RETURNING id`,
      [id, evaluation.interaction_id, recordingId, transcriptionModel],
    );
    jobId = jobRes.rows[0].id;

    await pool.query(
      `UPDATE quality_evaluations SET status = 'ai_processing', updated_at = NOW() WHERE id = $1`,
      [id],
    );

    // Phase 1: transcription (only when the interaction has none yet).
    if (!transcript) {
      await setJobStatus(pool, jobId, "transcribing");
      transcript = await transcribeInteractionRecording({
        interaction,
        recordingId,
        model: transcriptionModel,
      });
    }

    // Phase 2: AI scoring against the form.
    await setJobStatus(pool, jobId, "evaluating");
    const aiOutcome = await evaluateTranscriptWithAi({
      schema: evaluation.form_schema || { sections: [] },
      scoringConfig: evaluation.form_scoring_config || {},
      aiPromptConfig: evaluation.form_ai_prompt_config || {},
      transcriptText: transcript.text,
      context: {
        agentName: interaction.agent_username,
        queueName: interaction.queue_name,
        direction: interaction.direction,
      },
      model: body.model,
    });

    const aiResult = {
      summary: aiOutcome.summary,
      strengths: aiOutcome.strengths,
      coachingTips: aiOutcome.coachingTips,
      risks: aiOutcome.risks,
      model: aiOutcome.model,
      transcription_model: transcript.details?.model || transcriptionModel,
      score: aiOutcome.score,
      generated_at: new Date().toISOString(),
    };

    const updated = await pool.query(
      `UPDATE quality_evaluations
       SET answers = $2,
           ai_result = $3,
           evaluator_type = 'ai',
           status = 'ai_draft',
           score_total = $4,
           score_max = $5,
           score_percent = $6,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        JSON.stringify(aiOutcome.answers),
        JSON.stringify(aiResult),
        aiOutcome.score.scoreTotal,
        aiOutcome.score.scoreMax,
        aiOutcome.score.scorePercent,
      ],
    );

    await pool.query(
      `UPDATE quality_ai_jobs SET model = $2, status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [jobId, aiOutcome.model],
    );

    return NextResponse.json({
      ok: true,
      evaluation: updated.rows[0],
      job_id: jobId,
    });
  } catch (error) {
    qualityLogger.error("quality_ai_evaluation_failed", { error: error?.message });
    try {
      if (pool && jobId) {
        await setJobStatus(pool, jobId, "failed", {
          errorMessage: String(error?.message || error),
        });
      }
      if (pool) {
        const { id } = (await params) || {};
        if (id) {
          await pool.query(
            `UPDATE quality_evaluations
             SET status = CASE WHEN ai_result IS NULL THEN 'draft' ELSE 'ai_draft' END,
                 updated_at = NOW()
             WHERE id = $1 AND status = 'ai_processing'`,
            [id],
          );
        }
      }
    } catch {
      // Best-effort cleanup; the original error is what matters.
    }
    return NextResponse.json(
      { ok: false, error: String(error?.message || "AI evaluation failed") },
      { status: 500 },
    );
  }
}

/**
 * GET /api/contact-center/quality/evaluations/[id]/ai
 * Returns the latest AI job for the evaluation (status polling).
 */
export async function GET(request, { params }) {
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

    const { id } = (await params) || {};
    const result = await pool.query(
      `SELECT * FROM quality_ai_jobs WHERE evaluation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    return NextResponse.json({ ok: true, job: result.rows[0] || null });
  } catch (error) {
    qualityLogger.error("quality_ai_job_get_failed", { error: error?.message });
    return NextResponse.json({ ok: false, error: "Failed to load AI job" }, { status: 500 });
  }
}
