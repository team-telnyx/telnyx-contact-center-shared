/**
 * Call flows available for AI Agent voice testing.
 * GET /api/admin/workflows/[id]/voice-test/flows
 *
 * Lists every voice flow that has an Incoming Call initiator (i.e. can be
 * reached by dialing its SIP URI — the requirement for the test originate).
 * Each flow is tagged with informational eligibility flags (AI assistant node
 * present, transcription enabled) so the UI can warn — but never block —
 * the user. The "Test call flow" dropdown is populated from this list.
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

    // voice_flows schema: id, username, name, description, telnyx_voice_app_id,
    // webhook_url, nodes, edges, variables, metadata, created_at, updated_at.
    // (No is_active column.)
    const { rows: flowRows } = await pool.query(
      `SELECT id, name, webhook_url, nodes, edges, updated_at
       FROM voice_flows
       ORDER BY updated_at DESC NULLS LAST, name ASC`,
    );

    const flows = flowRows
      .map((flow) => {
        const validation = validateAiAgentTestFlow(flow, {
          expectAssistantId: workflow.ai_assistant_id,
        });
        const blockingReasons = (validation.reasons || []).filter((reason) =>
          [
            "missing_incoming_call",
            "missing_ai_assistant_start",
            "assistant_mismatch",
          ].includes(reason),
        );
        return {
          id: flow.id,
          name: flow.name,
          webhook_url: flow.webhook_url || null,
          has_incoming_call: validation.hasIncomingCall,
          // Keep this in sync with startAiAgentVoiceTest: flows that cannot
          // actually start the selected assistant must not be auto-selected as
          // eligible. Missing transcription remains a soft warning because the
          // call can still run, but simulated replies will not fire.
          eligible: blockingReasons.length === 0,
          reasons: (validation.reasons || []).filter((r) => r !== "missing_incoming_call"),
          has_ai_assistant: validation.hasAiAssistant,
          has_agent_assist: validation.hasAgentAssist,
          transcription_active: validation.transcriptionActive,
        };
      })
      // Only flows reachable by dialing their SIP URI (Incoming Call initiator).
      .filter((f) => f.has_incoming_call);

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
