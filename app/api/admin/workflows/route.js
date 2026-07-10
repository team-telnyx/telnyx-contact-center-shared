/**
 * Admin Workflows API
 * GET - List all workflows
 * POST - Create a new workflow
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";

function normalizeWorkflowDataActionButtons(buttons) {
  if (!Array.isArray(buttons)) return [];
  return buttons
    .map((button, index) => ({
      id: String(button?.id || `data-action-${index + 1}`).trim(),
      label: String(button?.label || "Data action").trim(),
      data_action_flow_id: String(button?.data_action_flow_id || button?.dataActionFlowId || button?.flow_id || button?.flowId || "").trim(),
      data_action_label: String(button?.data_action_label || button?.dataActionLabel || "").trim(),
      variant: String(button?.variant || "secondary").trim(),
      one_click: Boolean(button?.one_click || button?.oneClick),
    }))
    .filter((button) => button.id && button.label && button.data_action_flow_id);
}

// GET /api/admin/workflows - List all workflows
export async function GET(request) {
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

    const { searchParams } = new URL(request.url);
    const includeStages = searchParams.get("includeStages") === "true";
    const category = searchParams.get("category");
    const isActive = searchParams.get("isActive");

    let query = `
      SELECT 
        w.id,
        w.name,
        w.description,
        w.category,
        w.is_active,
        w.created_by,
        w.created_at,
        w.updated_at,
        u.username as created_by_username,
        (SELECT COUNT(*) FROM aa_workflow_stages WHERE workflow_id = w.id) as stages_count,
        (SELECT COUNT(*) FROM aa_workflow_items i 
         JOIN aa_workflow_stages s ON i.stage_id = s.id 
         WHERE s.workflow_id = w.id) as items_count
      FROM aa_workflows w
      LEFT JOIN users u ON w.created_by = u.id
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    if (category) {
      query += ` AND w.category = $${paramIndex++}`;
      params.push(category);
    }

    if (isActive !== null && isActive !== undefined) {
      query += ` AND w.is_active = $${paramIndex++}`;
      params.push(isActive === "true");
    }

    query += " ORDER BY w.created_at DESC";

    const { rows: workflows } = await pool.query(query, params);

    // If includeStages, fetch stages for each workflow
    if (includeStages && workflows.length > 0) {
      const workflowIds = workflows.map((w) => w.id);
      const { rows: stages } = await pool.query(
        `SELECT * FROM aa_workflow_stages 
         WHERE workflow_id = ANY($1) 
         ORDER BY workflow_id, order_index`,
        [workflowIds]
      );

      // Group stages by workflow
      const stagesByWorkflow = stages.reduce((acc, stage) => {
        if (!acc[stage.workflow_id]) acc[stage.workflow_id] = [];
        acc[stage.workflow_id].push(stage);
        return acc;
      }, {});

      // Attach stages to workflows
      workflows.forEach((w) => {
        w.stages = stagesByWorkflow[w.id] || [];
      });
    }

    return NextResponse.json({
      ok: true,
      workflows,
      count: workflows.length,
    });
  } catch (error) {
    workflowLogger.error("admin_workflow_error", { ...agentAssistRuntimePayload({ workflowId: typeof workflowId !== "undefined" ? workflowId : undefined, stageId: typeof stageId !== "undefined" ? stageId : undefined, itemId: typeof itemId !== "undefined" ? itemId : undefined, error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof syncErr !== "undefined" ? syncErr : undefined }) });
    return NextResponse.json(
      { error: error.message || "Failed to fetch workflows" },
      { status: 500 }
    );
  }
}

// POST /api/admin/workflows - Create a new workflow
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
    const { name, description, category, is_active = true, stages, data_action_buttons } = body;

    if (!name?.trim()) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Create workflow
      const { rows: [workflow] } = await client.query(
        `INSERT INTO aa_workflows (name, description, category, is_active, created_by, data_action_buttons)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [name.trim(), description || null, category || null, is_active, session.user.id, JSON.stringify(normalizeWorkflowDataActionButtons(data_action_buttons))]
      );

      // If stages are provided, create them
      if (stages && Array.isArray(stages)) {
        for (let i = 0; i < stages.length; i++) {
          const stage = stages[i];
          const { rows: [createdStage] } = await client.query(
            `INSERT INTO aa_workflow_stages (workflow_id, name, description, order_index, is_required)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [
              workflow.id,
              stage.name,
              stage.description || null,
              stage.order_index ?? i,
              stage.is_required ?? true,
            ]
          );

          // If items are provided for this stage, create them
          if (stage.items && Array.isArray(stage.items)) {
            for (let j = 0; j < stage.items.length; j++) {
              const item = stage.items[j];
              await client.query(
                `INSERT INTO aa_workflow_items 
                 (stage_id, type, label, description, prompt_hint, order_index, is_required,
                  slot_name, slot_type, slot_options, slot_validation)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                  createdStage.id,
                  item.type || "action",
                  item.label,
                  item.description || null,
                  item.prompt_hint || null,
                  item.order_index ?? j,
                  item.is_required ?? true,
                  item.slot_name || null,
                  item.slot_type || null,
                  item.slot_options ? JSON.stringify(item.slot_options) : null,
                  item.slot_validation || null,
                ]
              );
            }
          }
        }
      }

      await client.query("COMMIT");

      // Fetch complete workflow with stages and items
      const { rows: [fullWorkflow] } = await client.query(
        `SELECT * FROM aa_workflows WHERE id = $1`,
        [workflow.id]
      );

      const { rows: workflowStages } = await client.query(
        `SELECT * FROM aa_workflow_stages WHERE workflow_id = $1 ORDER BY order_index`,
        [workflow.id]
      );

      fullWorkflow.stages = workflowStages;

      for (const stage of fullWorkflow.stages) {
        const { rows: items } = await client.query(
          `SELECT * FROM aa_workflow_items WHERE stage_id = $1 ORDER BY order_index`,
          [stage.id]
        );
        stage.items = items;
      }

      return NextResponse.json({
        ok: true,
        workflow: fullWorkflow,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    workflowLogger.error("admin_workflow_error", { ...agentAssistRuntimePayload({ workflowId: typeof workflowId !== "undefined" ? workflowId : undefined, stageId: typeof stageId !== "undefined" ? stageId : undefined, itemId: typeof itemId !== "undefined" ? itemId : undefined, error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof syncErr !== "undefined" ? syncErr : undefined }) });
    return NextResponse.json(
      { error: error.message || "Failed to create workflow" },
      { status: 500 }
    );
  }
}
