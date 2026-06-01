/**
 * Agent Assist Workflow - Analyze API
 * POST - Analyze transcript for workflow item completion and slot extraction
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  analyzeWorkflowTranscript,
  analyzeWorkflowTranscriptBatch,
} from "@/lib/agent-assist/workflow-analyzer";

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
    const {
      sessionId,
      interactionId,
      transcript,
      speaker,
      confidence: transcriptionConfidence,
      recentTranscripts,
    } = body;
    const normalizedTranscriptionConfidence =
      typeof transcriptionConfidence === "number" &&
      Number.isFinite(transcriptionConfidence) &&
      transcriptionConfidence >= 0 &&
      transcriptionConfidence <= 1
        ? transcriptionConfidence
        : null;

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

    // Get workflow's LLM model and STT confidence threshold
    const { rows: [workflow] } = await pool.query(
      `SELECT llm_model, COALESCE(stt_confidence_threshold, 0.95)::float AS stt_confidence_threshold
       FROM aa_workflows WHERE id = $1`,
      [workflowSession.workflow_id]
    );
    const llmModel = workflow?.llm_model || "moonshotai/Kimi-K2.5";
    const sttConfidenceThreshold =
      typeof workflow?.stt_confidence_threshold === "number"
        ? workflow.stt_confidence_threshold
        : 0.95;

    const normalizedRecentTranscripts = Array.isArray(recentTranscripts)
      ? recentTranscripts
          .map((item) => ({
            transcript: typeof item?.transcript === "string" ? item.transcript.trim() : "",
            speaker: item?.speaker || "unknown",
            timestamp: item?.timestamp || null,
          }))
          .filter((item) => item.transcript)
          .slice(-8)
      : [];

    const transcriptAlreadyIncluded = normalizedRecentTranscripts.some(
      (item) => item.transcript === transcript.trim() && item.speaker === (speaker || "unknown"),
    );
    const analysisTranscripts = transcriptAlreadyIncluded
      ? normalizedRecentTranscripts
      : [
          ...normalizedRecentTranscripts,
          { transcript: transcript.trim(), speaker: speaker || "unknown", timestamp: null },
        ].slice(-8);

    // Call LLM analyzer (using workflow's configured model). Use recent context
    // so slots split across utterances, e.g. first name then last name, can fill
    // a single workflow item.
    const analysisResult = analysisTranscripts.length > 1
      ? await analyzeWorkflowTranscriptBatch({
          transcripts: analysisTranscripts,
          pendingItems: relevantPendingItems,
          slotsFilled,
          model: llmModel,
          includeIntent: assistConfig.enable_intent_recognition === true,
          includeSentiment: assistConfig.enable_sentiment_analysis === true,
        })
      : await analyzeWorkflowTranscript({
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
        
        // Determine if we should complete based on trigger.
        // Slot extraction is data capture, so it can be filled from either leg even when
        // old workflow items still have the default completion_trigger='agent'.
        let shouldComplete = item.type === "slot";
        if (completionTrigger === "either") {
          shouldComplete = true;
        } else if (completionTrigger === "customer" && speakerType === "customer") {
          shouldComplete = true;
        } else if (completionTrigger === "agent" && speakerType === "agent") {
          shouldComplete = true;
        }
        
        const llmConfidence =
          typeof completed.confidence === "number" && Number.isFinite(completed.confidence)
            ? completed.confidence
            : 0;
        const workflowConfidenceThreshold = 0.85;
        const belowThreshold = llmConfidence < workflowConfidenceThreshold;
        const sttBelowThreshold =
          normalizedTranscriptionConfidence !== null &&
          normalizedTranscriptionConfidence < sttConfidenceThreshold;

        // Auto-fill when LLM confidence is high enough and trigger matches.
        // Keep workflow confidence_score as the LLM extraction confidence. STT
        // confidence is returned as a separate display/review signal only — it
        // must not change the pre-confidence slot recognition/completion behavior.
        if (shouldComplete && llmConfidence >= workflowConfidenceThreshold) {
          const nextStatus = "completed";
          const completedBy = speakerType || "auto";

          // Update item status
          await client.query(
            `UPDATE aa_workflow_item_status 
             SET status = $1,
                 completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE NULL END,
                 completed_by = $2,
                 extracted_value = $3,
                 confidence_score = $4,
                 source_transcript = $5,
                 updated_at = NOW()
             WHERE session_id = $6 AND item_id = $7`,
            [
              nextStatus,
              completedBy,
              completed.extracted_value || null,
              llmConfidence,
              transcript,
              workflowSession.id,
              completed.item_id,
            ]
          );

          // If this is a slot item with a value, update slots_filled even when it needs agent verification.
          if (item?.slot_name && completed.extracted_value) {
            slotsFilled[item.slot_name] = completed.extracted_value;
          }

          updates.push({
            item_id: completed.item_id,
            status: nextStatus,
            confidence: llmConfidence,
            llm_confidence: llmConfidence,
            transcription_confidence: normalizedTranscriptionConfidence,
            below_threshold: belowThreshold,
            stt_below_threshold: sttBelowThreshold,
            threshold: workflowConfidenceThreshold,
            stt_threshold: sttConfidenceThreshold,
            completed_by: completedBy,
            extracted_value: completed.extracted_value,
            source_text: completed.source_text,
          });
        } else if (llmConfidence >= 0.60) {
          // Add as suggestion (don't auto-complete)
          updates.push({
            item_id: completed.item_id,
            status: "suggested",
            confidence: llmConfidence,
            llm_confidence: llmConfidence,
            transcription_confidence: normalizedTranscriptionConfidence,
            below_threshold: belowThreshold,
            stt_below_threshold: sttBelowThreshold,
            threshold: workflowConfidenceThreshold,
            stt_threshold: sttConfidenceThreshold,
            extracted_value: completed.extracted_value,
            source_text: completed.source_text,
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
        sttConfidenceThreshold,
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
