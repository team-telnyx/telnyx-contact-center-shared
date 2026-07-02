import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildWorkflowExportBundle, workflowExportFilename } from "@/lib/agent-assist/workflow-bundles.mjs";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";

export const dynamic = "force-dynamic";

async function loadWorkflowWithStages(pool, id) {
  const { rows: [workflow] } = await pool.query(
    `SELECT * FROM aa_workflows WHERE id = $1`,
    [id],
  );
  if (!workflow) return null;

  const { rows: stages } = await pool.query(
    `SELECT * FROM aa_workflow_stages WHERE workflow_id = $1 ORDER BY order_index`,
    [id],
  );

  const stageIds = stages.map((stage) => stage.id);
  let items = [];
  if (stageIds.length > 0) {
    const { rows } = await pool.query(
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

  workflow.stages = stages.map((stage) => ({
    ...stage,
    items: itemsByStage[stage.id] || [],
  }));

  return workflow;
}

export async function GET(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ ok: false, error: "Database not configured" }, { status: 503 });
    }

    const { id } = await params;
    const workflow = await loadWorkflowWithStages(pool, id);
    if (!workflow) {
      return NextResponse.json({ ok: false, error: "Workflow not found" }, { status: 404 });
    }

    const bundle = buildWorkflowExportBundle(workflow);
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${workflowExportFilename(workflow.name)}"`,
      },
    });
  } catch (error) {
    workflowLogger.error("admin_workflow_error", {
      ...agentAssistRuntimePayload({ error }),
    });
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to export workflow" },
      { status: 500 },
    );
  }
}
