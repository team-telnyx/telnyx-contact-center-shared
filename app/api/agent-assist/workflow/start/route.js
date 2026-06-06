/**
 * Agent Assist Workflow - Start Session API
 * POST - Start a new workflow session for an interaction
 * 
 * Also checks for pending AI handoff data and applies it to the session.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { applyPendingAiHandoff, broadcastAiHandoffToAgent, recalculateCurrentStage } from "@/lib/agent-assist/ai-handoff-processor";
import { buildWorkflowPrefillFromClientState } from "@/lib/agent-assist/workflow-prefill";

// POST /api/agent-assist/workflow/start - Start workflow session
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
    const { interactionId, workflowId } = body;

    if (!interactionId) {
      return NextResponse.json(
        { error: "interactionId is required" },
        { status: 400 }
      );
    }

    if (!workflowId) {
      return NextResponse.json(
        { error: "workflowId is required" },
        { status: 400 }
      );
    }

    // Verify interaction exists and check for AI call control ID
    const { rows: [interaction] } = await pool.query(
      `SELECT id, metadata, agent_username FROM cc_interactions WHERE id = $1`,
      [interactionId]
    );

    if (!interaction) {
      return NextResponse.json(
        { error: "Interaction not found" },
        { status: 404 }
      );
    }

    // Check if this interaction has AI call control ID (came from AI assistant)
    const aiCallControlId = interaction.metadata?.ai_call_control_id;
    const hasAiHandoff = Boolean(aiCallControlId);

    // Check if session already exists for this interaction
    const { rows: [existingSession] } = await pool.query(
      `SELECT id FROM aa_workflow_sessions WHERE interaction_id = $1`,
      [interactionId]
    );

    if (existingSession) {
      return NextResponse.json(
        { error: "Workflow session already exists for this interaction" },
        { status: 409 }
      );
    }

    // Verify workflow exists and is active
    const { rows: [workflow] } = await pool.query(
      `SELECT id, name, is_active FROM aa_workflows WHERE id = $1`,
      [workflowId]
    );

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    if (!workflow.is_active) {
      return NextResponse.json(
        { error: "Workflow is not active" },
        { status: 400 }
      );
    }

    // Get first stage of workflow
    const { rows: [firstStage] } = await pool.query(
      `SELECT id FROM aa_workflow_stages 
       WHERE workflow_id = $1 
       ORDER BY order_index 
       LIMIT 1`,
      [workflowId]
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Read the previous session status BEFORE upsert so we can reliably detect
      // a completed→in_progress restart without relying on post-upsert row state
      const { rows: [prevSession] } = await client.query(
        `SELECT status FROM aa_workflow_sessions WHERE interaction_id = $1`,
        [interactionId]
      );
      const wasCompleted = prevSession?.status === 'completed';

      // Read workflow slot items before creating the session so call-flow data can
      // become the initial slots_filled payload.
      const { rows: items } = await client.query(
        `SELECT i.id as item_id, i.id, i.type, i.slot_name
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON i.stage_id = s.id
         WHERE s.workflow_id = $1
         ORDER BY s.order_index, i.order_index`,
        [workflowId]
      );

      const callFlowWorkflowData =
        interaction.metadata?.workflow_data ||
        interaction.metadata?.agent_assist_config?.workflow_data_resolved ||
        {};
      const workflowPrefill = buildWorkflowPrefillFromClientState(
        { workflow_data: callFlowWorkflowData },
        { items },
      );

      // Create workflow session — ON CONFLICT: return existing session if already started
      // If the previous session was 'completed', fully reset progress.
      const { rows: [workflowSession] } = await client.query(
        `INSERT INTO aa_workflow_sessions 
         (interaction_id, workflow_id, current_stage_id, status, started_at, slots_filled, completion_percentage)
         VALUES ($1, $2, $3, 'in_progress', NOW(), $4::jsonb, 0)
         ON CONFLICT (interaction_id) DO UPDATE
           SET workflow_id = EXCLUDED.workflow_id,
               current_stage_id = EXCLUDED.current_stage_id,
               status = CASE WHEN aa_workflow_sessions.status = 'completed' THEN 'in_progress' ELSE aa_workflow_sessions.status END,
               started_at = CASE WHEN aa_workflow_sessions.status = 'completed' THEN NOW() ELSE aa_workflow_sessions.started_at END,
               slots_filled = CASE WHEN aa_workflow_sessions.status = 'completed' THEN $4::jsonb ELSE aa_workflow_sessions.slots_filled END,
               completion_percentage = CASE WHEN aa_workflow_sessions.status = 'completed' THEN 0 ELSE aa_workflow_sessions.completion_percentage END
         RETURNING *`,
        [interactionId, workflowId, firstStage?.id || null, JSON.stringify(workflowPrefill.slotsFilled)]
      );

      // If restarting a completed session, reset all item statuses back to pending
      // (ON CONFLICT DO NOTHING would otherwise preserve old completed states)
      const sessionWasCompleted = wasCompleted;
      if (sessionWasCompleted) {
        await client.query(
          `UPDATE aa_workflow_item_status SET status = 'pending', completed_at = NULL,
           completed_by = NULL, extracted_value = NULL, confidence_score = NULL,
           source_transcript = NULL, updated_at = NOW()
           WHERE session_id = $1`,
          [workflowSession.id]
        );
      }

      // Insert pending status for new items — ON CONFLICT DO NOTHING (idempotent for active sessions)
      for (const item of items) {
        await client.query(
          `INSERT INTO aa_workflow_item_status (session_id, item_id, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (session_id, item_id) DO NOTHING`,
          [workflowSession.id, item.item_id]
        );
      }

      if (workflowPrefill.itemCompletions.length > 0) {
        await client.query(
          `UPDATE aa_workflow_sessions
           SET slots_filled = COALESCE(slots_filled, '{}'::jsonb) || $2::jsonb,
               updated_at = NOW()
           WHERE id = $1`,
          [workflowSession.id, JSON.stringify(workflowPrefill.slotsFilled)]
        );

        for (const completion of workflowPrefill.itemCompletions) {
          await client.query(
            `INSERT INTO aa_workflow_item_status
             (session_id, item_id, status, extracted_value, confidence_score, completed_at, completed_by, source_transcript)
             VALUES ($1, $2, 'completed', $3, NULL, NOW(), 'call_flow', $4)
             ON CONFLICT (session_id, item_id)
             DO UPDATE SET
               status = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.status ELSE 'completed' END,
               extracted_value = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.extracted_value ELSE $3 END,
               confidence_score = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.confidence_score ELSE NULL END,
               completed_at = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.completed_at ELSE NOW() END,
               completed_by = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN 'agent' ELSE 'call_flow' END,
               source_transcript = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.source_transcript ELSE $4 END,
               updated_at = NOW()`,
            [
              workflowSession.id,
              completion.itemId,
              typeof completion.value === "string" ? completion.value : JSON.stringify(completion.value),
              "client_state.workflow_data",
            ]
          );
        }
      }

      await client.query("COMMIT");
      if (workflowPrefill.itemCompletions.length > 0) {
        await recalculateCurrentStage(workflowSession.id);
      }

      // Check for pending AI handoff data and apply it
      let aiHandoffApplied = false;
      let aiHandoffData = null;
      if (hasAiHandoff) {
        try {
          console.log(`[Workflow Start] Checking for pending AI handoff for interaction: ${interactionId}`);
          aiHandoffData = await applyPendingAiHandoff(interactionId, workflowSession.id);
          if (aiHandoffData) {
            aiHandoffApplied = true;
            console.log(`[Workflow Start] Applied AI handoff data to session: ${workflowSession.id}`);
            
            // Broadcast AI handoff data to agent
            await broadcastAiHandoffToAgent(interaction, workflowSession.id, aiHandoffData);
          }
        } catch (aiErr) {
          console.warn("[Workflow Start] Warning: Failed to apply AI handoff:", aiErr.message);
          // Don't fail session start if AI handoff fails
        }
      }

      // Fetch complete session state (will include AI data if applied)
      const sessionState = await getWorkflowSessionState(pool, workflowSession.id);

      return NextResponse.json({
        ok: true,
        session: sessionState,
        aiHandoffApplied,
        hasAiHandoff,
        aiCallControlId: aiCallControlId || null,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("[Agent Assist Workflow] Start error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to start workflow session" },
      { status: 500 }
    );
  }
}

/**
 * Helper function to get complete workflow session state
 */
async function getWorkflowSessionState(pool, sessionId) {
  // Get session with interaction and agent info
  const { rows: [session] } = await pool.query(
    `SELECT s.*, 
            w.name as workflow_name, 
            w.category as workflow_category,
            i.agent_username,
            u.first_name as agent_first_name,
            u.last_name as agent_last_name
     FROM aa_workflow_sessions s
     JOIN aa_workflows w ON s.workflow_id = w.id
     LEFT JOIN cc_interactions i ON s.interaction_id = i.id
     LEFT JOIN users u ON i.agent_username = u.username
     WHERE s.id = $1`,
    [sessionId]
  );

  if (!session) return null;
  
  // Build agent_name from user record
  const agentName = session.agent_first_name 
    ? `${session.agent_first_name}${session.agent_last_name ? ' ' + session.agent_last_name : ''}`
    : session.agent_username || null;

  // Get stages with items
  const { rows: stages } = await pool.query(
    `SELECT * FROM aa_workflow_stages 
     WHERE workflow_id = $1 
     ORDER BY order_index`,
    [session.workflow_id]
  );

  // Get all items for this workflow
  const stageIds = stages.map(s => s.id);
  let items = [];
  if (stageIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT * FROM aa_workflow_items WHERE stage_id = ANY($1) ORDER BY stage_id, order_index`,
      [stageIds]
    );
    items = rows;
  }

  // Get item statuses for this session
  const { rows: itemStatuses } = await pool.query(
    `SELECT * FROM aa_workflow_item_status WHERE session_id = $1`,
    [sessionId]
  );

  // Create item status map
  const statusMap = itemStatuses.reduce((acc, status) => {
    acc[status.item_id] = status;
    return acc;
  }, {});

  // Attach items to stages with status
  const itemsByStage = items.reduce((acc, item) => {
    if (!acc[item.stage_id]) acc[item.stage_id] = [];
    acc[item.stage_id].push({
      ...item,
      status: statusMap[item.id] || { status: 'pending' },
    });
    return acc;
  }, {});

  stages.forEach(stage => {
    stage.items = itemsByStage[stage.id] || [];
  });

  // Calculate current stage index
  const currentStageIndex = stages.findIndex(s => s.id === session.current_stage_id);

  return {
    ...session,
    agent_name: agentName,
    stages,
    currentStageIndex: currentStageIndex >= 0 ? currentStageIndex : 0,
  };
}
