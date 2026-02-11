/**
 * Update AI Assistant - Sync assistant instructions with current workflow
 * POST /api/admin/workflows/[id]/update-assistant
 * Regenerates instructions from workflow stages and PATCHes the Telnyx assistant.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { generateWorkflowInstructions } from "@/lib/agent-assist/workflow-instructions";
import { buildTelnyxV2Url } from "@/lib/telnyx";

export async function POST(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing TELNYX_API_KEY" },
        { status: 500 }
      );
    }

    const { id: workflowId } = await params;
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    const { rows: [workflow] } = await pool.query(
      `SELECT id, name, description, ai_assistant_id FROM aa_workflows WHERE id = $1`,
      [workflowId]
    );

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    if (!workflow.ai_assistant_id) {
      return NextResponse.json(
        { error: "No AI assistant assigned to this workflow" },
        { status: 400 }
      );
    }

    const { rows: stages } = await pool.query(
      `SELECT * FROM aa_workflow_stages WHERE workflow_id = $1 ORDER BY order_index`,
      [workflowId]
    );

    const stageIds = stages.map((s) => s.id);
    let items = [];
    if (stageIds.length > 0) {
      const { rows: itemRows } = await pool.query(
        `SELECT * FROM aa_workflow_items WHERE stage_id = ANY($1) ORDER BY stage_id, order_index`,
        [stageIds]
      );
      items = itemRows;
    }

    const itemsByStage = items.reduce((acc, item) => {
      if (!acc[item.stage_id]) acc[item.stage_id] = [];
      acc[item.stage_id].push(item);
      return acc;
    }, {});

    const stagesWithItems = stages.map((s) => ({
      ...s,
      items: itemsByStage[s.id] || [],
    }));

    const instructions = generateWorkflowInstructions(workflow, stagesWithItems);

    const res = await fetch(buildTelnyxV2Url(`/ai/assistants/${workflow.ai_assistant_id}`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ instructions }),
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        {
          ok: false,
          error: res.status === 404
            ? "AI assistant not found on Telnyx (may have been deleted)"
            : `Telnyx API error: ${res.status} ${text}`,
        },
        { status: res.status === 404 ? 404 : 502 }
      );
    }

    const data = await res.json();
    return NextResponse.json({
      ok: true,
      assistant: data?.data || data,
    });
  } catch (err) {
    console.error("[Update Assistant] Error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to update assistant" },
      { status: 500 }
    );
  }
}
