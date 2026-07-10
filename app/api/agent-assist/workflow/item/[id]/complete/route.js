/**
 * Agent Assist Workflow - Manual Item Complete API
 * PUT - Manually mark an item as completed
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";

// Presence check that preserves boolean false / 0 — a captured "No" is a real
// value. Truthiness (value || null / && value) would drop it.
function hasMeaningfulValue(value) {
  return value !== null && value !== undefined && value !== "";
}

// PUT /api/agent-assist/workflow/item/[id]/complete - Complete item manually
export async function PUT(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: itemId } = await params;
    
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

    // Verify item belongs to this workflow
    const { rows: [item] } = await pool.query(
      `SELECT i.*, s.workflow_id
       FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
       WHERE i.id = $1 AND s.workflow_id = $2`,
      [itemId, workflowSession.workflow_id]
    );

    if (!item) {
      return NextResponse.json(
        { error: "Item not found in this workflow" },
        { status: 404 }
      );
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Update item status
      await client.query(
        `UPDATE aa_workflow_item_status 
         SET status = 'completed',
             completed_at = NOW(),
             completed_by = 'agent',
             extracted_value = $1,
             confidence_score = 1.0,
             updated_at = NOW()
         WHERE session_id = $2 AND item_id = $3`,
        [hasMeaningfulValue(value) ? value : null, workflowSession.id, itemId]
      );

      // If this is a slot item with a value, update slots_filled
      if (item.slot_name && hasMeaningfulValue(value)) {
        const slotsFilled = workflowSession.slots_filled || {};
        slotsFilled[item.slot_name] = value;
        
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
        item_id: itemId,
        status: "completed",
        completionPercentage,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    workflowLogger.error("agent_assist_workflow", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return NextResponse.json(
      { error: error.message || "Failed to complete item" },
      { status: 500 }
    );
  }
}
