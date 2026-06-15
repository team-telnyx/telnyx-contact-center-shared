/**
 * Start an AI Agent voice test.
 * POST /api/admin/workflows/[id]/voice-test/start
 *
 * Body: { flowId, fromNumber, persona?, voice?, expressive?, replyDelayMs?, maxDurationSecs? }
 *
 * Places a real SIP call to the chosen test call flow (which runs the workflow's
 * AI assistant with Standalone STT on both legs) and seeds the simulated-caller
 * reply engine. Returns { runId, ledgerId, callControlId } the UI uses to poll
 * state, attach the silent WebRTC listener, and stop the test.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { startAiAgentVoiceTest } from "@/lib/workflows/ai-agent-voice-test.mjs";

const REASON_STATUS = {
  call_generator_disabled: 409,
  workflow_not_found: 404,
  workflow_has_no_assistant: 400,
  flow_not_found: 404,
  flow_invalid: 422,
  missing_from_number: 400,
  missing_flow: 400,
  db_unavailable: 503,
};

export async function POST(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const result = await startAiAgentVoiceTest({
      workflowId: id,
      flowId: String(body.flowId || "").trim(),
      fromNumber: String(body.fromNumber || "").trim(),
      voiceConfig: {
        persona: body.persona,
        voice: body.voice,
        expressive: body.expressive === true,
        reply_delay_ms: body.replyDelayMs,
      },
      maxDurationSecs: body.maxDurationSecs,
    });

    if (!result.ok) {
      const status = REASON_STATUS[result.reason] || 400;
      return NextResponse.json(
        { error: result.reason || "start_failed", details: result.details || null },
        { status },
      );
    }

    return NextResponse.json({
      ok: true,
      runId: result.runId,
      ledgerId: result.ledgerId,
      callControlId: result.callControlId,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to start voice test" },
      { status: 500 },
    );
  }
}
