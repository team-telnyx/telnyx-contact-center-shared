/**
 * Workflow Test - Analyze API
 * POST - Analyze transcript for workflow item completion using the same LLM
 * as live agent desktop (intent recognition, slot extraction).
 * Used when running workflow tests - no DB session required.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { analyzeWorkflowTranscript } from "@/lib/agent-assist/workflow-analyzer";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import { planTestWorkflowAnalysis, applyTestWorkflowAnalysis } from "@/lib/agent-assist/test-workflow-analysis.mjs";

import { withPermission } from "@/lib/authz/guard";
import { resolveTestModel } from "@/lib/agent-assist/test-model-override.mjs";
import { resolveOperationModel } from "@/lib/ai-operations/runtime.mjs";
import { chatCopilotCatalog } from "@/lib/contact-center/chat-copilot";
function normalizeConfidenceThreshold(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 1) {
    return 0.95;
  }
  return Math.round(numericValue * 100) / 100;
}

// POST /api/admin/workflows/[id]/analyze-test
async function POST_handler(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    const { id: workflowId } = await params;
    const body = await request.json();
    const { transcript, speaker, itemStatuses = {}, slotsFilled = {}, recentContext = [] } = body;

    if (!transcript?.trim()) {
      return NextResponse.json(
        { error: "transcript is required" },
        { status: 400 }
      );
    }

    // Fetch workflow (includes LLM model and confidence threshold for analysis)
    const { rows: [workflow] } = await pool.query(
      `SELECT id, llm_model, llm_fallback_model, llm_confidence_threshold, llm_reasoning_enabled, llm_max_output_tokens FROM aa_workflows WHERE id = $1`,
      [workflowId]
    );

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Per-test override (Test AI Agent model picker) > workflow model > the
    // Admin → AI Copilot "Workflow analysis" default > built-in default. The
    // last two are resolved by the analyzer through the AI operation runtime.
    const override = await resolveTestModel(body.model, { workflowModel: workflow.llm_model, loadCatalog: chatCopilotCatalog });
    const analysisModel = await resolveOperationModel("workflow-analysis", {
      preferredModel: override.model || workflow.llm_model,
      preferredSource: override.source === "test" ? "test" : "workflow",
    });
    const llmModel = analysisModel.model;
    const fallbackModel = workflow.llm_fallback_model || null;
    const reasoningEnabled = workflow.llm_reasoning_enabled === true;
    const maxOutputTokens = Number.isInteger(workflow.llm_max_output_tokens)
      ? workflow.llm_max_output_tokens
      : 1200;
    const confidenceThreshold = normalizeConfidenceThreshold(workflow.llm_confidence_threshold);

    const { rows: stages } = await pool.query(
      `SELECT * FROM aa_workflow_stages WHERE workflow_id = $1 ORDER BY order_index`,
      [workflowId]
    );

    const stageIds = stages.map((s) => s.id);
    let items = [];
    if (stageIds.length > 0) {
      const { rows } = await pool.query(
        `SELECT i.*, s.name as stage_name, s.order_index as stage_order 
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON i.stage_id = s.id
         WHERE i.stage_id = ANY($1)
         ORDER BY s.order_index, i.order_index`,
        [stageIds]
      );
      items = rows;
    }

    // Which items the analyzer sees: open items, completed notes slots, and
    // completed slots as correction candidates at read-back or behind an
    // explicit correction (mirrors the live analyze route, an earlier fix).
    const plan = planTestWorkflowAnalysis({
      items,
      itemStatuses,
      slotsFilled,
      transcript,
      recentContext,
    });

    if (plan.analyzerItems.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "All items completed",
        updates: [],
        slotsFilled: { ...slotsFilled },
      });
    }

    const { currentTarget, isReadBackStage, allowCorrections, correctionInProgress } = plan;

    // Call same LLM analyzer as live agent desktop (using workflow's configured model)
    const analysisResult = await analyzeWorkflowTranscript({
      transcript,
      speaker: speaker || "unknown",
      pendingItems: plan.analyzerItems,
      slotsFilled: { ...slotsFilled },
      model: llmModel,
      fallbackModel,
      reasoningEnabled,
      maxOutputTokens,
      confidenceThreshold,
      currentTarget,
      isReadBackStage,
      allowCorrections,
      correctionInProgress,
      recentContext: Array.isArray(recentContext) ? recentContext.slice(-6) : [],
    });

    // A correction comes back "suggested" with is_correction; slotsFilled keeps
    // the old value until it is confirmed.
    const { updates, slotsFilled: newSlotsFilled } = applyTestWorkflowAnalysis({
      plan,
      analysisResult,
      speaker,
      slotsFilled,
      itemStatuses,
      confidenceThreshold,
      transcript,
    });

    return NextResponse.json({
      ok: true,
      updates,
      slotsFilled: newSlotsFilled,
      model: llmModel,
      modelSource: analysisModel.source,
    });
  } catch (error) {
    workflowLogger.error("admin_workflow_error", { ...agentAssistRuntimePayload({ workflowId: typeof workflowId !== "undefined" ? workflowId : undefined, stageId: typeof stageId !== "undefined" ? stageId : undefined, itemId: typeof itemId !== "undefined" ? itemId : undefined, error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof syncErr !== "undefined" ? syncErr : undefined }) });
    return NextResponse.json(
      { error: error.message || "Failed to analyze transcript" },
      { status: error?.status === 400 ? 400 : 500 }
    );
  }
}

// Phase 0 hardening: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("workflows:ai", POST_handler, { route: "/api/admin/workflows/[id]/analyze-test" });
