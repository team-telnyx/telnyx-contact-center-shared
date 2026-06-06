export const dynamic = "force-dynamic";

/**
 * Admin Workflow Stages API
 * POST - Add a stage to a workflow
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";

// POST /api/admin/workflows/[id]/stages - Add a stage
export async function POST(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: workflowId } = await params;
    
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    // Verify workflow exists
    const { rows: [workflow] } = await pool.query(
      `SELECT id FROM aa_workflows WHERE id = $1`,
      [workflowId]
    );

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const body = await request.json();
    const { name, description, order_index, is_required = true, items } = body;

    if (!name?.trim()) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    // If order_index not provided, get next available
    let finalOrderIndex = order_index;
    if (finalOrderIndex === undefined || finalOrderIndex === null) {
      const { rows: [maxOrder] } = await pool.query(
        `SELECT COALESCE(MAX(order_index), -1) + 1 as next_order 
         FROM aa_workflow_stages WHERE workflow_id = $1`,
        [workflowId]
      );
      finalOrderIndex = maxOrder.next_order;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Create stage
      const { rows: [stage] } = await client.query(
        `INSERT INTO aa_workflow_stages (workflow_id, name, description, order_index, is_required)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [workflowId, name.trim(), description || null, finalOrderIndex, is_required]
      );

      // If items provided, create them
      if (items && Array.isArray(items)) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          await client.query(
            `INSERT INTO aa_workflow_items 
             (stage_id, type, label, description, prompt_hint, order_index, is_required,
              slot_name, slot_type, slot_options, slot_validation)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              stage.id,
              item.type || "action",
              item.label,
              item.description || null,
              item.prompt_hint || null,
              item.order_index ?? i,
              item.is_required ?? true,
              item.slot_name || null,
              item.slot_type || null,
              item.slot_options ? JSON.stringify(item.slot_options) : null,
              item.slot_validation || null,
            ]
          );
        }
      }

      await client.query("COMMIT");

      // Fetch stage with items
      const { rows: stageItems } = await client.query(
        `SELECT * FROM aa_workflow_items WHERE stage_id = $1 ORDER BY order_index`,
        [stage.id]
      );
      stage.items = stageItems;

      return NextResponse.json({
        ok: true,
        stage,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("[Admin Workflow Stages] POST error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create stage" },
      { status: 500 }
    );
  }
}
