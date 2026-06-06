export const dynamic = "force-dynamic";

/**
 * Admin Workflow Stage [stageId] API
 * PUT - Update a stage
 * DELETE - Delete a stage
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";

// PUT /api/admin/workflows/[id]/stages/[stageId] - Update stage
export async function PUT(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: workflowId, stageId } = await params;
    
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    // Verify stage belongs to workflow
    const { rows: [existing] } = await pool.query(
      `SELECT id FROM aa_workflow_stages WHERE id = $1 AND workflow_id = $2`,
      [stageId, workflowId]
    );

    if (!existing) {
      return NextResponse.json(
        { error: "Stage not found" },
        { status: 404 }
      );
    }

    const body = await request.json();
    const { name, description, order_index, is_required } = body;

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name.trim());
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (order_index !== undefined) {
      updates.push(`order_index = $${paramIndex++}`);
      values.push(order_index);
    }
    if (is_required !== undefined) {
      updates.push(`is_required = $${paramIndex++}`);
      values.push(is_required);
    }

    if (updates.length === 0) {
      return NextResponse.json(
        { error: "No fields to update" },
        { status: 400 }
      );
    }

    updates.push(`updated_at = NOW()`);
    values.push(stageId);

    const { rows: [stage] } = await pool.query(
      `UPDATE aa_workflow_stages SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    // Fetch items for stage
    const { rows: items } = await pool.query(
      `SELECT * FROM aa_workflow_items WHERE stage_id = $1 ORDER BY order_index`,
      [stageId]
    );
    stage.items = items;

    return NextResponse.json({
      ok: true,
      stage,
    });
  } catch (error) {
    console.error("[Admin Workflow Stages] PUT error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update stage" },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/workflows/[id]/stages/[stageId] - Delete stage
export async function DELETE(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: workflowId, stageId } = await params;
    
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    // Verify stage belongs to workflow and get its order_index
    const { rows: [existing] } = await pool.query(
      `SELECT id, order_index FROM aa_workflow_stages WHERE id = $1 AND workflow_id = $2`,
      [stageId, workflowId]
    );

    if (!existing) {
      return NextResponse.json(
        { error: "Stage not found" },
        { status: 404 }
      );
    }

    const { order_index } = existing;

    // Delete stage (cascade will remove items)
    await pool.query(`DELETE FROM aa_workflow_stages WHERE id = $1`, [stageId]);

    // Renumber remaining stages in the same workflow (close the gap)
    await pool.query(
      `UPDATE aa_workflow_stages 
       SET order_index = order_index - 1, updated_at = NOW()
       WHERE workflow_id = $1 AND order_index > $2`,
      [workflowId, order_index]
    );

    return NextResponse.json({
      ok: true,
      message: "Stage deleted successfully",
    });
  } catch (error) {
    console.error("[Admin Workflow Stages] DELETE error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to delete stage" },
      { status: 500 }
    );
  }
}
