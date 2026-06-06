/**
 * Agent Assist Workflow - Skip Item API
 * PUT - Skip an item in the workflow
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";

// PUT /api/agent-assist/workflow/item/[id]/skip - Skip item
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
    const { sessionId, interactionId } = body;

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

    // Update item status to skipped
    await pool.query(
      `UPDATE aa_workflow_item_status 
       SET status = 'skipped',
           completed_at = NOW(),
           completed_by = 'agent',
           updated_at = NOW()
       WHERE session_id = $1 AND item_id = $2`,
      [workflowSession.id, itemId]
    );

    // Note: Skipped items are NOT counted toward completion percentage
    // Only completed items count

    return NextResponse.json({
      ok: true,
      item_id: itemId,
      status: "skipped",
    });
  } catch (error) {
    console.error("[Agent Assist Workflow] Skip item error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to skip item" },
      { status: 500 }
    );
  }
}
