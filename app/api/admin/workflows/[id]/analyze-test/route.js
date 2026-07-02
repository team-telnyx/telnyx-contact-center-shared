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

function normalizeConfidenceThreshold(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 1) {
    return 0.95;
  }
  return Math.round(numericValue * 100) / 100;
}

function normalizeSpeakerType(speaker) {
  if (speaker === "inbound" || speaker === "customer") return "customer";
  if (speaker === "outbound" || speaker === "agent") return "agent";
  return null;
}

function hasMeaningfulExtractedValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

// POST /api/admin/workflows/[id]/analyze-test
export async function POST(request, { params }) {
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
    const { transcript, speaker, itemStatuses = {}, slotsFilled = {} } = body;

    if (!transcript?.trim()) {
      return NextResponse.json(
        { error: "transcript is required" },
        { status: 400 }
      );
    }

    // Fetch workflow (includes LLM model and confidence threshold for analysis)
    const { rows: [workflow] } = await pool.query(
      `SELECT id, llm_model, llm_confidence_threshold FROM aa_workflows WHERE id = $1`,
      [workflowId]
    );

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const llmModel = workflow.llm_model || "openai/gpt-4o";
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

    // Build pending items (not yet completed)
    const completedIds = new Set(
      Object.entries(itemStatuses)
        .filter(([, s]) => s?.status === "completed")
        .map(([id]) => id)
    );

    // Slot items default to "customer" - customer provides the value; others default to "agent"
    const getDefaultCompletionTrigger = (type) =>
      type === "slot" ? "customer" : "agent";

    const pendingItems = items
      .filter((item) => !completedIds.has(item.id))
      .map((item) => ({
        item_id: item.id,
        type: item.type,
        label: item.label,
        prompt_hint: item.prompt_hint,
        slot_name: item.slot_name,
        slot_type: item.slot_type,
        slot_validation: item.slot_validation,
        completion_trigger: item.completion_trigger || getDefaultCompletionTrigger(item.type),
        stage_name: item.stage_name,
        stage_order: item.stage_order,
      }));

    if (pendingItems.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "All items completed",
        updates: [],
        slotsFilled: { ...slotsFilled },
      });
    }

    // Call same LLM analyzer as live agent desktop (using workflow's configured model)
    const analysisResult = await analyzeWorkflowTranscript({
      transcript,
      speaker: speaker || "unknown",
      pendingItems,
      slotsFilled: { ...slotsFilled },
      model: llmModel,
    });

    // Apply completion_trigger and confidence threshold (same logic as live API)
    const speakerType = normalizeSpeakerType(speaker);

    const updates = [];
    const newSlotsFilled = { ...slotsFilled };

    for (const completed of analysisResult.completed_items || []) {
      const item = pendingItems.find((p) => p.item_id === completed.item_id);
      if (!item) continue;

      const completionTrigger = item.completion_trigger || getDefaultCompletionTrigger(item.type);
      const shouldComplete =
        Boolean(speakerType) &&
        (completionTrigger === "either" ||
          (completionTrigger === "customer" && speakerType === "customer") ||
          (completionTrigger === "agent" && speakerType === "agent"));
      const hasExtractedSlotValue = item.type !== "slot" || hasMeaningfulExtractedValue(completed.extracted_value);

      if (!shouldComplete || !hasExtractedSlotValue) {
        continue;
      }

      if (completed.confidence >= confidenceThreshold) {
        updates.push({
          item_id: completed.item_id,
          status: "completed",
          confidence: completed.confidence,
          extracted_value: completed.extracted_value,
          source_text: completed.source_text,
        });
        if (item.slot_name && completed.extracted_value) {
          newSlotsFilled[item.slot_name] = completed.extracted_value;
        }
      } else {
        updates.push({
          item_id: completed.item_id,
          status: "suggested",
          confidence: completed.confidence,
          extracted_value: completed.extracted_value,
          source_text: completed.source_text,
          low_confidence: shouldComplete && completed.confidence < confidenceThreshold,
          confidence_threshold: confidenceThreshold,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      updates,
      slotsFilled: newSlotsFilled,
      intent: analysisResult.detected_intent,
      sentiment: analysisResult.sentiment,
      sentimentScore: analysisResult.sentiment_score,
    });
  } catch (error) {
    workflowLogger.error("admin_workflow_error", { ...agentAssistRuntimePayload({ workflowId: typeof workflowId !== "undefined" ? workflowId : undefined, stageId: typeof stageId !== "undefined" ? stageId : undefined, itemId: typeof itemId !== "undefined" ? itemId : undefined, error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof syncErr !== "undefined" ? syncErr : undefined }) });
    return NextResponse.json(
      { error: error.message || "Failed to analyze transcript" },
      { status: 500 }
    );
  }
}
