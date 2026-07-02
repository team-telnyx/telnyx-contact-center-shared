/**
 * Admin Workflow Item [itemId] API
 * PUT - Update an item
 * DELETE - Delete an item
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";

// PUT /api/admin/workflows/[id]/items/[itemId] - Update item
export async function PUT(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: workflowId, itemId } = await params;
    
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    // Verify item belongs to workflow
    const { rows: [existing] } = await pool.query(
      `SELECT i.id FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
       WHERE i.id = $1 AND s.workflow_id = $2`,
      [itemId, workflowId]
    );

    if (!existing) {
      return NextResponse.json(
        { error: "Item not found" },
        { status: 404 }
      );
    }

    const body = await request.json();
    const {
      type,
      label,
      description,
      prompt_hint,
      hints,
      order_index,
      is_required,
      slot_name,
      slot_type,
      slot_options,
      slot_validation,
      completion_trigger,
    } = body;

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (type !== undefined) {
      if (!["action", "question", "topic", "slot"].includes(type)) {
        return NextResponse.json(
          { error: "Invalid type. Must be one of: action, question, topic, slot" },
          { status: 400 }
        );
      }
      updates.push(`type = $${paramIndex++}`);
      values.push(type);
    }
    if (label !== undefined) {
      updates.push(`label = $${paramIndex++}`);
      values.push(label.trim());
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (prompt_hint !== undefined) {
      updates.push(`prompt_hint = $${paramIndex++}`);
      values.push(prompt_hint);
    }
    if (hints !== undefined) {
      updates.push(`hints = $${paramIndex++}`);
      values.push(hints ? JSON.stringify(hints) : null);
    }
    if (order_index !== undefined) {
      updates.push(`order_index = $${paramIndex++}`);
      values.push(order_index);
    }
    if (is_required !== undefined) {
      updates.push(`is_required = $${paramIndex++}`);
      values.push(is_required);
    }
    if (slot_name !== undefined) {
      updates.push(`slot_name = $${paramIndex++}`);
      values.push(slot_name);
    }
    if (slot_type !== undefined) {
      updates.push(`slot_type = $${paramIndex++}`);
      values.push(slot_type);
    }
    if (slot_options !== undefined) {
      updates.push(`slot_options = $${paramIndex++}`);
      values.push(slot_options ? JSON.stringify(slot_options) : null);
    }
    if (slot_validation !== undefined) {
      updates.push(`slot_validation = $${paramIndex++}`);
      values.push(slot_validation);
    }
    if (completion_trigger !== undefined) {
      if (!["agent", "customer", "either"].includes(completion_trigger)) {
        return NextResponse.json(
          { error: "Invalid completion_trigger. Must be one of: agent, customer, either" },
          { status: 400 }
        );
      }
      updates.push(`completion_trigger = $${paramIndex++}`);
      values.push(completion_trigger);
    }

    if (updates.length === 0) {
      return NextResponse.json(
        { error: "No fields to update" },
        { status: 400 }
      );
    }

    updates.push(`updated_at = NOW()`);
    values.push(itemId);

    const { rows: [item] } = await pool.query(
      `UPDATE aa_workflow_items SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    return NextResponse.json({
      ok: true,
      item,
    });
  } catch (error) {
    workflowLogger.error("admin_workflow_error", { ...agentAssistRuntimePayload({ workflowId: typeof workflowId !== "undefined" ? workflowId : undefined, stageId: typeof stageId !== "undefined" ? stageId : undefined, itemId: typeof itemId !== "undefined" ? itemId : undefined, error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof syncErr !== "undefined" ? syncErr : undefined }) });
    return NextResponse.json(
      { error: error.message || "Failed to update item" },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/workflows/[id]/items/[itemId] - Delete item
export async function DELETE(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: workflowId, itemId } = await params;
    
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    // Verify item belongs to workflow and get its stage_id and order_index
    const { rows: [existing] } = await pool.query(
      `SELECT i.id, i.stage_id, i.order_index FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
       WHERE i.id = $1 AND s.workflow_id = $2`,
      [itemId, workflowId]
    );

    if (!existing) {
      return NextResponse.json(
        { error: "Item not found" },
        { status: 404 }
      );
    }

    const { stage_id, order_index } = existing;

    // Delete item
    await pool.query(`DELETE FROM aa_workflow_items WHERE id = $1`, [itemId]);

    // Renumber remaining items in the same stage (close the gap)
    await pool.query(
      `UPDATE aa_workflow_items 
       SET order_index = order_index - 1, updated_at = NOW()
       WHERE stage_id = $1 AND order_index > $2`,
      [stage_id, order_index]
    );

    return NextResponse.json({
      ok: true,
      message: "Item deleted successfully",
    });
  } catch (error) {
    workflowLogger.error("admin_workflow_error", { ...agentAssistRuntimePayload({ workflowId: typeof workflowId !== "undefined" ? workflowId : undefined, stageId: typeof stageId !== "undefined" ? stageId : undefined, itemId: typeof itemId !== "undefined" ? itemId : undefined, error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof syncErr !== "undefined" ? syncErr : undefined }) });
    return NextResponse.json(
      { error: error.message || "Failed to delete item" },
      { status: 500 }
    );
  }
}
