/**
 * AI Agent voice test session control.
 * GET  /api/admin/workflows/[id]/voice-test/session?runId=&ledgerId=  -> live state
 * POST /api/admin/workflows/[id]/voice-test/session  body { action:'stop', runId, ledgerId }
 *
 * GET returns the call status and the running AI↔caller transcript so the UI can
 * render the live conversation alongside the silent WebRTC audio listener.
 * POST with action 'stop' hangs up the generated leg and closes the run.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import {
  getAiAgentVoiceTestState,
  stopAiAgentVoiceTest,
} from "@/lib/workflows/ai-agent-voice-test.mjs";

export async function GET(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const runId = searchParams.get("runId") || null;
    const ledgerId = searchParams.get("ledgerId") || null;

    const state = await getAiAgentVoiceTestState({ runId, ledgerId });
    if (!state.ok) {
      const status = state.reason === "not_found" ? 404 : 400;
      return NextResponse.json({ error: state.reason || "state_failed" }, { status });
    }
    return NextResponse.json({ ok: true, ...state });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to read voice test state" },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const action = String(body.action || "stop").toLowerCase();
    if (action !== "stop") {
      return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
    }

    const result = await stopAiAgentVoiceTest({
      runId: body.runId || null,
      ledgerId: body.ledgerId || null,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason || "stop_failed" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, hungUp: result.hungUp, runId: result.runId });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to stop voice test" },
      { status: 500 },
    );
  }
}
