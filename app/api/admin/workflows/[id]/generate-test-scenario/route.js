/**
 * Generate test scenario via LLM
 * POST - Create test scenario with varied, realistic responses based on scenario type
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { generateTestScenario, SCENARIO_TYPES } from "@/lib/agent-assist/generate-test-scenario";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";

// POST /api/admin/workflows/[id]/generate-test-scenario
export async function POST(request, { params }) {
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

    const { id: workflowId } = await params;
    const body = await request.json().catch(() => ({}));
    const scenarioType = body.scenarioType || "workflow_specific";

    if (!Object.keys(SCENARIO_TYPES).includes(scenarioType)) {
      return NextResponse.json(
        { error: `Invalid scenarioType: ${scenarioType}` },
        { status: 400 }
      );
    }

    const { rows: [workflow] } = await pool.query(
      `SELECT id, name, llm_model FROM aa_workflows WHERE id = $1`,
      [workflowId]
    );

    if (!workflow) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }

    const { rows: stages } = await pool.query(
      `SELECT * FROM aa_workflow_stages WHERE workflow_id = $1 ORDER BY order_index`,
      [workflowId]
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

    const itemsByStage = items.reduce((acc, item) => {
      if (!acc[item.stage_id]) acc[item.stage_id] = [];
      acc[item.stage_id].push(item);
      return acc;
    }, {});

    stages.forEach((stage) => {
      stage.items = itemsByStage[stage.id] || [];
    });
    workflow.stages = stages;

    const scenario = await generateTestScenario({
      workflow,
      scenarioType,
      model: workflow.llm_model || "openai/gpt-4o",
    });

    if (!scenario) {
      return NextResponse.json(
        { error: scenarioType === "workflow_specific"
          ? "Workflow has no collectible items (question/slot/topic)"
          : "Failed to generate scenario" },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true, scenario });
  } catch (error) {
    workflowLogger.error("admin_workflow_error", { ...agentAssistRuntimePayload({ workflowId: typeof workflowId !== "undefined" ? workflowId : undefined, stageId: typeof stageId !== "undefined" ? stageId : undefined, itemId: typeof itemId !== "undefined" ? itemId : undefined, error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof syncErr !== "undefined" ? syncErr : undefined }) });
    return NextResponse.json(
      { error: error.message || "Failed to generate scenario" },
      { status: 500 }
    );
  }
}
