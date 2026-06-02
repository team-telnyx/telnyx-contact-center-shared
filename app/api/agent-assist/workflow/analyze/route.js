/**
 * Agent Assist Workflow - Analyze API
 * POST - Analyze transcript for workflow item completion and slot extraction
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { analyzeWorkflowTranscript } from "@/lib/agent-assist/workflow-analyzer";

function normalizeConfidenceThreshold(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 1) {
    return 0.95;
  }
  return Math.round(numericValue * 100) / 100;
}

// POST /api/agent-assist/workflow/analyze - Analyze transcript
export async function POST(request) {
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

    const body = await request.json();
    const { sessionId, interactionId, transcript, speaker } = body;

    if (!transcript?.trim()) {
      return NextResponse.json(
        { error: "transcript is required" },
        { status: 400 }
      );
    }

    // Find session
    let workflowSession;
    if (sessionId) {
      const { rows: [s] } = await pool.query(
        `SELECT * FROM aa_workflow_sessions WHERE id = $1 AND status = 'in_progress'`,
        [sessionId]
      );
      workflowSession = s;
    } else if (interactionId) {
      const { rows: [s] } = await pool.query(
        `SELECT * FROM aa_workflow_sessions WHERE interaction_id = $1 AND status = 'in_progress'`,
        [interactionId]
      );
      workflowSession = s;
    }

    if (!workflowSession) {
      return NextResponse.json({
        ok: true,
        message: "No active workflow session found",
        updates: [],
      });
    }

    let assistConfig = {};
    if (workflowSession.interaction_id) {
      const { rows: [interaction] } = await pool.query(
        `SELECT metadata FROM cc_interactions WHERE id = $1`,
        [workflowSession.interaction_id]
      );
      assistConfig = interaction?.metadata?.agent_assist_config || {};
    }

    if (assistConfig.auto_detect_completion === false) {
      return NextResponse.json({
        ok: true,
        message: "Auto-detect completion is disabled",
        updates: [],
      });
    }

    // Get pending items for current and upcoming stages
    const { rows: pendingItems } = await pool.query(
      `SELECT 
        i.id as item_id,
        i.type,
        i.label,
        i.prompt_hint,
        i.slot_name,
        i.slot_type,
        i.slot_validation,
        i.completion_trigger,
        s.name as stage_name,
        s.order_index as stage_order,
        ist.status as current_status
       FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
       JOIN aa_workflow_item_status ist ON ist.item_id = i.id AND ist.session_id = $1
       WHERE s.workflow_id = $2 
         AND ist.status = 'pending'
       ORDER BY s.order_index, i.order_index`,
      [workflowSession.id, workflowSession.workflow_id]
    );

    const speakerType = speaker === "inbound" ? "customer" : speaker === "outbound" ? "agent" : null;
    const relevantPendingItems = pendingItems
      .filter((item) => {
        const completionTrigger = item.completion_trigger || "agent";
        return (
          item.type === "slot" ||
          completionTrigger === "either" ||
          !speakerType ||
          completionTrigger === speakerType
        );
      })
      .slice(0, 12);

    if (relevantPendingItems.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "No pending items to analyze",
        updates: [],
      });
    }

    // Get current slots filled
    const slotsFilled = workflowSession.slots_filled || {};

    // Get workflow's LLM model and confidence threshold
    const { rows: [workflow] } = await pool.query(
      `SELECT llm_model, llm_confidence_threshold FROM aa_workflows WHERE id = $1`,
      [workflowSession.workflow_id]
    );
    const llmModel = workflow?.llm_model || "moonshotai/Kimi-K2.5";
    const confidenceThreshold = normalizeConfidenceThreshold(workflow?.llm_confidence_threshold);

    // Call LLM analyzer (using workflow's configured model)
    const analysisResult = await analyzeWorkflowTranscript({
      transcript,
      speaker: speaker || "unknown",
      pendingItems: relevantPendingItems,
      slotsFilled,
      model: llmModel,
      includeIntent: assistConfig.enable_intent_recognition === true,
      includeSentiment: assistConfig.enable_sentiment_analysis === true,
    });

    // Process completed items
    const updates = [];
    const client = await pool.connect();
    
    try {
      await client.query("BEGIN");

      for (const completed of analysisResult.completed_items || []) {
        // Get item details including completion_trigger
        const item = relevantPendingItems.find(p => p.item_id === completed.item_id);
        if (!item) continue;
        
        // Check if completion_trigger matches speaker
        const completionTrigger = item.completion_trigger || "agent";
        
        // Determine if we should complete based on trigger
        let shouldComplete = false;
        if (completionTrigger === "either") {
          shouldComplete = true;
        } else if (completionTrigger === "customer" && speakerType === "customer") {
          shouldComplete = true;
        } else if (completionTrigger === "agent" && speakerType === "agent") {
          shouldComplete = true;
        }
        
        // Only auto-complete if confidence is high enough AND trigger matches
        if (shouldComplete && completed.confidence >= confidenceThreshold) {
          // Update item status
          await client.query(
            `UPDATE aa_workflow_item_status 
             SET status = 'completed',
                 completed_at = NOW(),
                 completed_by = $1,
                 extracted_value = $2,
                 confidence_score = $3,
                 source_transcript = $4,
                 updated_at = NOW()
             WHERE session_id = $5 AND item_id = $6`,
            [
              speakerType || "auto",
              completed.extracted_value || null,
              completed.confidence,
              transcript,
              workflowSession.id,
              completed.item_id,
            ]
          );

          // If this is a slot item with a value, update slots_filled
          if (item?.slot_name && completed.extracted_value) {
            slotsFilled[item.slot_name] = completed.extracted_value;
          }

          updates.push({
            item_id: completed.item_id,
            status: "completed",
            confidence: completed.confidence,
            extracted_value: completed.extracted_value,
            source_text: completed.source_text,
          });
        } else if (completed.confidence >= 0.60) {
          // Persist as suggestion (don't auto-complete) so the agent can confirm or correct it
          await client.query(
            `UPDATE aa_workflow_item_status
             SET status = $1::varchar,
                 completed_at = NULL,
                 completed_by = 'ai',
                 extracted_value = $2,
                 confidence_score = $3,
                 source_transcript = $4,
                 updated_at = NOW()
             WHERE session_id = $5 AND item_id = $6`,
            [
              'suggested',
              completed.extracted_value || null,
              completed.confidence,
              transcript,
              workflowSession.id,
              completed.item_id,
            ]
          );

          updates.push({
            item_id: completed.item_id,
            status: "suggested",
            confidence: completed.confidence,
            extracted_value: completed.extracted_value,
            source_text: completed.source_text,
            completed_by: "ai",
            low_confidence: shouldComplete && completed.confidence < confidenceThreshold,
            confidence_threshold: confidenceThreshold,
            completion_trigger_pending: !shouldComplete,
          });
        }
      }

      // Update slots_filled in session
      if (Object.keys(slotsFilled).length > 0) {
        await client.query(
          `UPDATE aa_workflow_sessions 
           SET slots_filled = $1, updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify(slotsFilled), workflowSession.id]
        );
      }

      // Recalculate completion percentage
      const { rows: [stats] } = await client.query(
        `SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'completed') as completed
         FROM aa_workflow_item_status
         WHERE session_id = $1`,
        [workflowSession.id]
      );

      const completionPercentage = stats.total > 0 
        ? Math.round((stats.completed / stats.total) * 100)
        : 0;

      await client.query(
        `UPDATE aa_workflow_sessions 
         SET completion_percentage = $1, updated_at = NOW()
         WHERE id = $2`,
        [completionPercentage, workflowSession.id]
      );

      // Check if workflow is complete
      if (completionPercentage === 100) {
        await client.query(
          `UPDATE aa_workflow_sessions 
           SET status = 'completed', completed_at = NOW()
           WHERE id = $1`,
          [workflowSession.id]
        );
      }

      await client.query("COMMIT");

      return NextResponse.json({
        ok: true,
        updates,
        slotsFilled,
        completionPercentage,
        intent: analysisResult.detected_intent,
        sentiment: analysisResult.sentiment,
        sentimentScore: analysisResult.sentiment_score,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("[Agent Assist Workflow] Analyze error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to analyze transcript" },
      { status: 500 }
    );
  }
}
