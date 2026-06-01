/**
 * Agent Assist Workflow - Session API
 * GET - Get current workflow session state
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";

// GET /api/agent-assist/workflow/session?interactionId=xxx - Get session state
export async function GET(request) {
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

    const { searchParams } = new URL(request.url);
    const interactionId = searchParams.get("interactionId");
    const sessionId = searchParams.get("sessionId");

    if (!interactionId && !sessionId) {
      return NextResponse.json(
        { error: "interactionId or sessionId is required" },
        { status: 400 }
      );
    }

    // Find session
    let workflowSession;
    if (sessionId) {
      const { rows: [s] } = await pool.query(
        `SELECT * FROM aa_workflow_sessions WHERE id = $1`,
        [sessionId]
      );
      workflowSession = s;
    } else {
      const { rows: [s] } = await pool.query(
        `SELECT * FROM aa_workflow_sessions WHERE interaction_id = $1`,
        [interactionId]
      );
      workflowSession = s;
    }

    if (!workflowSession) {
      return NextResponse.json({
        ok: true,
        session: null,
        message: "No workflow session found",
      });
    }

    // Get complete session state
    const sessionState = await getWorkflowSessionState(pool, workflowSession.id);

    return NextResponse.json({
      ok: true,
      session: sessionState,
    });
  } catch (error) {
    console.error("[Agent Assist Workflow] Session GET error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to get workflow session" },
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
            COALESCE(w.stt_confidence_threshold, 0.95)::float as stt_confidence_threshold,
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

  // Calculate completion percentage
  const totalItems = items.length;
  const completedItems = itemStatuses.filter(s => s.status === 'completed').length;
  const completionPercentage = totalItems > 0 
    ? Math.round((completedItems / totalItems) * 100)
    : 0;

  return {
    ...session,
    agent_name: agentName,
    stages,
    currentStageIndex: currentStageIndex >= 0 ? currentStageIndex : 0,
    completionPercentage,
    totalItems,
    completedItems,
  };
}
