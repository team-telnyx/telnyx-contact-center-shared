import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { normalizeImportedWorkflowBundle } from "@/lib/agent-assist/workflow-bundles.mjs";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";

export const dynamic = "force-dynamic";

async function loadWorkflowWithStages(client, id) {
  const { rows: [workflow] } = await client.query(
    `SELECT * FROM aa_workflows WHERE id = $1`,
    [id],
  );
  if (!workflow) return null;

  const { rows: stages } = await client.query(
    `SELECT * FROM aa_workflow_stages WHERE workflow_id = $1 ORDER BY order_index`,
    [id],
  );
  const stageIds = stages.map((stage) => stage.id);
  let items = [];
  if (stageIds.length > 0) {
    const { rows } = await client.query(
      `SELECT * FROM aa_workflow_items WHERE stage_id = ANY($1) ORDER BY stage_id, order_index`,
      [stageIds],
    );
    items = rows;
  }

  const itemsByStage = items.reduce((acc, item) => {
    if (!acc[item.stage_id]) acc[item.stage_id] = [];
    acc[item.stage_id].push(item);
    return acc;
  }, {});
  workflow.stages = stages.map((stage) => ({ ...stage, items: itemsByStage[stage.id] || [] }));
  return workflow;
}

export async function POST(request) {
  let client;
  let committed = false;
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ ok: false, error: "Database not configured" }, { status: 503 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid workflow format: request body must be valid JSON" },
        { status: 400 },
      );
    }

    const imported = normalizeImportedWorkflowBundle(body);

    client = await pool.connect();
    await client.query("BEGIN");

    const { rows: [workflow] } = await client.query(
      `INSERT INTO aa_workflows (name, description, category, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        imported.name,
        imported.description || null,
        imported.category || null,
        imported.is_active,
        session.user.id || null,
      ],
    );

    for (let stageIndex = 0; stageIndex < imported.stages.length; stageIndex += 1) {
      const stage = imported.stages[stageIndex];
      const { rows: [createdStage] } = await client.query(
        `INSERT INTO aa_workflow_stages (workflow_id, name, description, order_index, is_required)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          workflow.id,
          stage.name,
          stage.description || null,
          stage.order_index ?? stageIndex,
          stage.is_required ?? true,
        ],
      );

      for (let itemIndex = 0; itemIndex < (stage.items || []).length; itemIndex += 1) {
        const item = stage.items[itemIndex];
        await client.query(
          `INSERT INTO aa_workflow_items
           (stage_id, type, label, description, prompt_hint, hints, order_index, is_required,
            slot_name, slot_type, slot_options, slot_validation, completion_trigger)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            createdStage.id,
            item.type || "action",
            item.label,
            item.description || null,
            item.prompt_hint || null,
            item.hints ? JSON.stringify(item.hints) : JSON.stringify([]),
            item.order_index ?? itemIndex,
            item.is_required ?? true,
            item.slot_name || null,
            item.slot_type || null,
            item.slot_options ? JSON.stringify(item.slot_options) : null,
            item.slot_validation || null,
            item.completion_trigger || (item.type === "slot" ? "customer" : "agent"),
          ],
        );
      }
    }

    await client.query("COMMIT");
    committed = true;
    const fullWorkflow = await loadWorkflowWithStages(client, workflow.id);

    return NextResponse.json({ ok: true, workflow: fullWorkflow });
  } catch (error) {
    if (client && !committed) await client.query("ROLLBACK").catch(() => {});
    workflowLogger.error("admin_workflow_error", {
      ...agentAssistRuntimePayload({ error }),
    });
    const isClientError = /Invalid workflow/.test(error.message || "");
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to import workflow" },
      { status: isClientError ? 400 : 500 },
    );
  } finally {
    if (client) client.release();
  }
}
