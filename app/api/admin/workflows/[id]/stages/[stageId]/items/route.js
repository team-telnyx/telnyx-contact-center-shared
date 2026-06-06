/**
 * Admin Workflow Stage Items API
 * POST - Add an item to a stage
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";

// POST /api/admin/workflows/[id]/stages/[stageId]/items - Add an item
export async function POST(request, { params }) {
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
    const { rows: [stage] } = await pool.query(
      `SELECT id FROM aa_workflow_stages WHERE id = $1 AND workflow_id = $2`,
      [stageId, workflowId]
    );

    if (!stage) {
      return NextResponse.json(
        { error: "Stage not found" },
        { status: 404 }
      );
    }

    const body = await request.json();
    const {
      type = "action",
      label,
      description,
      prompt_hint,
      order_index,
      is_required = true,
      slot_name,
      slot_type,
      slot_options,
      slot_validation,
    } = body;

    if (!label?.trim()) {
      return NextResponse.json(
        { error: "Label is required" },
        { status: 400 }
      );
    }

    if (!["action", "question", "topic", "slot"].includes(type)) {
      return NextResponse.json(
        { error: "Invalid type. Must be one of: action, question, topic, slot" },
        { status: 400 }
      );
    }

    // Validate slot fields if type is slot
    if (type === "slot") {
      if (!slot_name?.trim()) {
        return NextResponse.json(
          { error: "slot_name is required for slot type items" },
          { status: 400 }
        );
      }
    }

    // If order_index not provided, get next available
    let finalOrderIndex = order_index;
    if (finalOrderIndex === undefined || finalOrderIndex === null) {
      const { rows: [maxOrder] } = await pool.query(
        `SELECT COALESCE(MAX(order_index), -1) + 1 as next_order 
         FROM aa_workflow_items WHERE stage_id = $1`,
        [stageId]
      );
      finalOrderIndex = maxOrder.next_order;
    }

    const { rows: [item] } = await pool.query(
      `INSERT INTO aa_workflow_items 
       (stage_id, type, label, description, prompt_hint, order_index, is_required,
        slot_name, slot_type, slot_options, slot_validation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        stageId,
        type,
        label.trim(),
        description || null,
        prompt_hint || null,
        finalOrderIndex,
        is_required,
        slot_name || null,
        slot_type || null,
        slot_options ? JSON.stringify(slot_options) : null,
        slot_validation || null,
      ]
    );

    return NextResponse.json({
      ok: true,
      item,
    });
  } catch (error) {
    console.error("[Admin Workflow Items] POST error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create item" },
      { status: 500 }
    );
  }
}
