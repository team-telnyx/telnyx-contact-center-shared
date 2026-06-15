/**
 * Eligible call flows for AI Agent voice testing.
 * GET /api/admin/workflows/[id]/voice-test/flows
 *
 * Returns the workflow's assistant id plus the list of voice flows, each tagged
 * with whether it is eligible to run an AI Agent voice test (has
 * ai_assistant_start + agent_assist[workflows] + transcription). The Test AI
 * Agent voice UI uses this to populate the "Test call flow" dropdown and to
 * explain why a flow is not selectable.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { validateAiAgentTestFlow } from "@/lib/workflows/ai-agent-voice-test.mjs";

export async function GET(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ error: "Database not configured" }, { status: 503 });
    }

    const { rows: [workflow] } = await pool.query(
      `SELECT id, name, ai_assistant_id FROM aa_workflows WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (!workflow) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }

    const { rows: flowRows } = await pool.query(
      `SELECT id, name, nodes, edges, is_active, updated_at
       FROM voice_flows
       ORDER BY updated_at DESC NULLS LAST, name ASC`,
    );

    const flows = flowRows.map((flow) => {
      const validation = validateAiAgentTestFlow(flow, {
        expectAssistantId: workflow.ai_assistant_id,
      });
      return {
        id: flow.id,
        name: flow.name,
        is_active: flow.is_active === true,
        eligible: validation.ok,
        reasons: validation.reasons,
        has_ai_assistant: validation.hasAiAssistant,
        has_agent_assist: validation.hasAgentAssist,
        transcription_active: validation.transcriptionActive,
      };
    });

    return NextResponse.json({
      ok: true,
      assistant_id: workflow.ai_assistant_id || null,
      has_assistant: Boolean(workflow.ai_assistant_id),
      flows,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to list voice-test flows" },
      { status: 500 },
    );
  }
}
