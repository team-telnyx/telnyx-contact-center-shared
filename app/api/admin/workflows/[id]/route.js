/**
 * Admin Workflow [id] API
 * GET - Get workflow by ID with stages and items
 * PUT - Update workflow
 * DELETE - Delete workflow
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";

// GET /api/admin/workflows/[id] - Get workflow with stages and items
export async function GET(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    // Fetch workflow
    const { rows: [workflow] } = await pool.query(
      `SELECT 
        w.*,
        u.username as created_by_username
       FROM aa_workflows w
       LEFT JOIN users u ON w.created_by = u.id
       WHERE w.id = $1`,
      [id]
    );

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Fetch stages
    const { rows: stages } = await pool.query(
      `SELECT * FROM aa_workflow_stages WHERE workflow_id = $1 ORDER BY order_index`,
      [id]
    );

    // Fetch items for all stages
    const stageIds = stages.map((s) => s.id);
    let items = [];
    if (stageIds.length > 0) {
      const { rows } = await pool.query(
        `SELECT * FROM aa_workflow_items WHERE stage_id = ANY($1) ORDER BY stage_id, order_index`,
        [stageIds]
      );
      items = rows;
    }

    // Group items by stage
    const itemsByStage = items.reduce((acc, item) => {
      if (!acc[item.stage_id]) acc[item.stage_id] = [];
      acc[item.stage_id].push(item);
      return acc;
    }, {});

    // Attach items to stages
    stages.forEach((stage) => {
      stage.items = itemsByStage[stage.id] || [];
    });

    workflow.stages = stages;

    return NextResponse.json({
      ok: true,
      workflow,
    });
  } catch (error) {
    console.error("[Admin Workflows] GET [id] error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch workflow" },
      { status: 500 }
    );
  }
}

// PUT /api/admin/workflows/[id] - Update workflow
export async function PUT(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { name, description, category, is_active } = body;

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
    if (category !== undefined) {
      updates.push(`category = $${paramIndex++}`);
      values.push(category);
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(is_active);
    }

    if (updates.length === 0) {
      return NextResponse.json(
        { error: "No fields to update" },
        { status: 400 }
      );
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const { rows: [workflow] } = await pool.query(
      `UPDATE aa_workflows SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      workflow,
    });
  } catch (error) {
    console.error("[Admin Workflows] PUT [id] error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update workflow" },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/workflows/[id] - Delete workflow
export async function DELETE(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    // Check if workflow exists
    const { rows: [existing] } = await pool.query(
      `SELECT id FROM aa_workflows WHERE id = $1`,
      [id]
    );

    if (!existing) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    // Check if workflow is in use by any active sessions
    const { rows: [activeSession] } = await pool.query(
      `SELECT id FROM aa_workflow_sessions WHERE workflow_id = $1 AND status = 'in_progress' LIMIT 1`,
      [id]
    );

    if (activeSession) {
      return NextResponse.json(
        { error: "Cannot delete workflow with active sessions" },
        { status: 400 }
      );
    }

    // Delete workflow (cascade will remove stages, items, and sessions)
    await pool.query(`DELETE FROM aa_workflows WHERE id = $1`, [id]);

    return NextResponse.json({
      ok: true,
      message: "Workflow deleted successfully",
    });
  } catch (error) {
    console.error("[Admin Workflows] DELETE [id] error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to delete workflow" },
      { status: 500 }
    );
  }
}
