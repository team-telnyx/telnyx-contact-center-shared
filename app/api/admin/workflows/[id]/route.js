/**
 * Admin Workflow [id] API
 * GET - Get workflow by ID with stages and items
 * PUT - Update workflow (with optional insight sync)
 * DELETE - Delete workflow (with insight cleanup)
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { syncWorkflowInsights, deleteWorkflowInsights } from "@/lib/telnyx-insights";

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
    const {
      name,
      description,
      category,
      is_active,
      llm_model,
      stt_confidence_threshold,
      ai_assistant_id,
      syncInsights,
    } = body;

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
    if (llm_model !== undefined) {
      updates.push(`llm_model = $${paramIndex++}`);
      values.push(llm_model);
    }
    if (stt_confidence_threshold !== undefined) {
      const threshold = Number(stt_confidence_threshold);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        return NextResponse.json(
          { error: "STT confidence threshold must be between 0 and 1" },
          { status: 400 }
        );
      }
      updates.push(`stt_confidence_threshold = $${paramIndex++}`);
      values.push(Number(threshold.toFixed(2)));
    }
    if (ai_assistant_id !== undefined) {
      updates.push(`ai_assistant_id = $${paramIndex++}`);
      values.push(ai_assistant_id);
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

    // Sync insights if requested AND workflow has AI assistant
    let insightsSynced = false;
    if (syncInsights && workflow.ai_assistant_id) {
      try {
        // Fetch stages with items for insight generation
        const { rows: stages } = await pool.query(
          `SELECT * FROM aa_workflow_stages WHERE workflow_id = $1 ORDER BY order_index`,
          [id]
        );

        const stageIds = stages.map((s) => s.id);
        let items = [];
        if (stageIds.length > 0) {
          const { rows } = await pool.query(
            `SELECT * FROM aa_workflow_items WHERE stage_id = ANY($1) ORDER BY stage_id, order_index`,
            [stageIds]
          );
          items = rows;
        }

        // Check if workflow has slots
        const hasSlots = items.some((item) => item.type === "slot" && item.slot_name);
        
        if (hasSlots) {
          // Attach items to stages
          const itemsByStage = items.reduce((acc, item) => {
            if (!acc[item.stage_id]) acc[item.stage_id] = [];
            acc[item.stage_id].push(item);
            return acc;
          }, {});

          const workflowWithStages = {
            ...workflow,
            stages: stages.map((stage) => ({
              ...stage,
              items: itemsByStage[stage.id] || [],
            })),
          };

          // Get webhook URL
          const baseUrl = process.env.TELNYX_WEBHOOK_BASE_URL || process.env.NEXTAUTH_URL;
          if (baseUrl) {
            const webhookUrl = `${baseUrl.replace(/\/$/, "")}/api/webhooks/telnyx/conversation-insights`;
            
            console.log(`[Admin Workflows] Syncing insights for workflow: ${workflow.name}`);
            const insightResult = await syncWorkflowInsights(workflowWithStages, webhookUrl);

            // Update workflow with insight IDs
            await pool.query(
              `UPDATE aa_workflows SET
                insight_group_id = $1,
                insight_slots_id = $2,
                insight_summary_id = $3,
                insight_sentiment_id = $4
               WHERE id = $5`,
              [
                insightResult.groupId,
                insightResult.slotsInsightId,
                insightResult.summaryInsightId,
                insightResult.sentimentInsightId,
                id,
              ]
            );

            workflow.insight_group_id = insightResult.groupId;
            workflow.insight_slots_id = insightResult.slotsInsightId;
            workflow.insight_summary_id = insightResult.summaryInsightId;
            workflow.insight_sentiment_id = insightResult.sentimentInsightId;
            insightsSynced = true;
          }
        }
      } catch (syncErr) {
        console.warn("[Admin Workflows] Warning: Failed to sync insights:", syncErr.message);
        // Don't fail the update if insight sync fails
      }
    }

    return NextResponse.json({
      ok: true,
      workflow,
      insightsSynced,
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

    // Fetch workflow with insight IDs for cleanup
    const { rows: [existing] } = await pool.query(
      `SELECT id, name, insight_group_id, insight_slots_id, insight_summary_id, insight_sentiment_id
       FROM aa_workflows WHERE id = $1`,
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

    // Clean up Telnyx insights if they exist
    let insightsDeleted = false;
    if (existing.insight_group_id || existing.insight_slots_id || 
        existing.insight_summary_id || existing.insight_sentiment_id) {
      try {
        console.log(`[Admin Workflows] Cleaning up insights for workflow: ${existing.name}`);
        await deleteWorkflowInsights(existing);
        insightsDeleted = true;
      } catch (cleanupErr) {
        // Log but don't fail deletion if insight cleanup fails
        console.warn("[Admin Workflows] Warning: Failed to clean up insights:", cleanupErr.message);
      }
    }

    // Delete workflow (cascade will remove stages, items, and sessions)
    await pool.query(`DELETE FROM aa_workflows WHERE id = $1`, [id]);

    return NextResponse.json({
      ok: true,
      message: "Workflow deleted successfully",
      insightsDeleted,
    });
  } catch (error) {
    console.error("[Admin Workflows] DELETE [id] error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to delete workflow" },
      { status: 500 }
    );
  }
}
