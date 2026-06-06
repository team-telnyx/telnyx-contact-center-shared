export const dynamic = "force-dynamic";

/**
 * Agent Assist Workflow - Slot Update API
 * PUT - Manually update a slot value
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";

// PUT /api/agent-assist/workflow/slot/[name] - Update slot value
export async function PUT(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name: slotName } = await params;
    
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { sessionId, interactionId, value } = body;

    if (!sessionId && !interactionId) {
      return NextResponse.json(
        { error: "sessionId or interactionId is required" },
        { status: 400 }
      );
    }

    if (value === undefined) {
      return NextResponse.json(
        { error: "value is required" },
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
      return NextResponse.json(
        { error: "Workflow session not found" },
        { status: 404 }
      );
    }

    // Find the slot item in this workflow
    const { rows: [slotItem] } = await pool.query(
      `SELECT i.id
       FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
       WHERE s.workflow_id = $1 AND i.slot_name = $2`,
      [workflowSession.workflow_id, slotName]
    );

    // Update slots_filled
    const slotsFilled = workflowSession.slots_filled || {};
    slotsFilled[slotName] = value;

    await pool.query(
      `UPDATE aa_workflow_sessions 
       SET slots_filled = $1, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(slotsFilled), workflowSession.id]
    );

    // If there's a corresponding item, update its status too
    if (slotItem) {
      await pool.query(
        `UPDATE aa_workflow_item_status 
         SET status = 'completed',
             completed_at = NOW(),
             completed_by = 'agent',
             extracted_value = $1,
             confidence_score = 1.0,
             updated_at = NOW()
         WHERE session_id = $2 AND item_id = $3 AND status = 'pending'`,
        [value, workflowSession.id, slotItem.id]
      );

      // Recalculate completion percentage
      const { rows: [stats] } = await pool.query(
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

      await pool.query(
        `UPDATE aa_workflow_sessions 
         SET completion_percentage = $1, updated_at = NOW()
         WHERE id = $2`,
        [completionPercentage, workflowSession.id]
      );
    }

    return NextResponse.json({
      ok: true,
      slot: slotName,
      value,
      slotsFilled,
    });
  } catch (error) {
    console.error("[Agent Assist Workflow] Slot update error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update slot" },
      { status: 500 }
    );
  }
}
