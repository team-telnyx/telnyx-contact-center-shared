/**
 * Agent Assist Workflow - Start Session API
 * POST - Start a new workflow session for an interaction
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";

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

    // Verify interaction exists
    const { rows: [interaction] } = await pool.query(
      `SELECT id FROM cc_interactions WHERE id = $1`,
      [interactionId]
    );

    if (!interaction) {
      return NextResponse.json(
        { error: "Interaction not found" },
        { status: 404 }
      );
    }

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

      // Create workflow session
      const { rows: [workflowSession] } = await client.query(
        `INSERT INTO aa_workflow_sessions 
         (interaction_id, workflow_id, current_stage_id, status, started_at, slots_filled, completion_percentage)
         VALUES ($1, $2, $3, 'in_progress', NOW(), '{}'::jsonb, 0)
         RETURNING *`,
        [interactionId, workflowId, firstStage?.id || null]
      );

      // Create item status records for all items in the workflow
      const { rows: items } = await client.query(
        `SELECT i.id as item_id
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON i.stage_id = s.id
         WHERE s.workflow_id = $1
         ORDER BY s.order_index, i.order_index`,
        [workflowId]
      );

      // Insert pending status for all items
      for (const item of items) {
        await client.query(
          `INSERT INTO aa_workflow_item_status (session_id, item_id, status)
           VALUES ($1, $2, 'pending')`,
          [workflowSession.id, item.item_id]
        );
      }

      await client.query("COMMIT");

      // Fetch complete session state
      const sessionState = await getWorkflowSessionState(pool, workflowSession.id);

      return NextResponse.json({
        ok: true,
        session: sessionState,
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
