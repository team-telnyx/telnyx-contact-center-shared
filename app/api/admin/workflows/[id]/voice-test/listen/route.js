/**
 * Attach / detach a silent WebRTC listener to a running AI Agent voice test.
 *
 * POST /api/admin/workflows/[id]/voice-test/listen
 *   body { runId?, ledgerId?, callControlId? }
 *   -> { ok, supervisorCallControlId, sipUsername }
 *   Places a Telnyx 'monitor' (listen-only) supervisor call to the current
 *   user's WebRTC SIP identity, bound to the test's generated leg. The browser
 *   receives it as an inbound call and auto-answers to hear the live AI↔caller
 *   conversation. The listener is never heard by the call.
 *
 * DELETE /api/admin/workflows/[id]/voice-test/listen
 *   body { supervisorCallControlId }  -> { ok }
 *   Hangs up the listener leg (the test call itself is unaffected).
 */

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { resolveWebrtcCredential } from "@/lib/telnyx-webrtc-credential.mjs";
import {
  getAiAgentVoiceTestState,
  startVoiceTestListener,
  stopVoiceTestListener,
} from "@/lib/workflows/ai-agent-voice-test.mjs";

const LISTEN_REASON_STATUS = {
  missing_api_key: 500,
  missing_connection_id: 500,
  missing_target_call: 400,
  missing_sip_username: 400,
  listener_dial_failed: 502,
  telnyx_request_error: 502,
  no_call_control_id: 502,
};

export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    // Resolve the generated leg's call_control_id. Prefer an explicit value but
    // fall back to the live state lookup (so the client can pass just runId).
    let targetCallControlId = String(body.callControlId || "").trim() || null;
    if (!targetCallControlId && (body.runId || body.ledgerId)) {
      const state = await getAiAgentVoiceTestState({
        runId: body.runId || null,
        ledgerId: body.ledgerId || null,
      });
      if (!state.ok) {
        return NextResponse.json({ error: "test_not_found" }, { status: 404 });
      }
      if (!["answered", "talking"].includes(String(state.status))) {
        return NextResponse.json({ error: "test_not_answered" }, { status: 409 });
      }
      targetCallControlId = state.callControlId;
    }

    if (!targetCallControlId) {
      return NextResponse.json({ error: "missing_target_call" }, { status: 400 });
    }

    const credential = await resolveWebrtcCredential(user);
    if (!credential?.sipUsername) {
      return NextResponse.json(
        { error: "no_webrtc_credential" },
        { status: 400 },
      );
    }

    const result = await startVoiceTestListener({
      targetCallControlId,
      sipUsername: credential.sipUsername,
    });
    if (!result.ok) {
      const status = LISTEN_REASON_STATUS[result.reason] || 400;
      return NextResponse.json(
        { error: result.reason || "listen_failed", detail: result.detail || null },
        { status },
      );
    }

    return NextResponse.json({
      ok: true,
      supervisorCallControlId: result.supervisorCallControlId,
      sipUsername: credential.sipUsername,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to start listener" },
      { status: 500 },
    );
  }
}

export async function DELETE(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const supervisorCallControlId = String(body.supervisorCallControlId || "").trim();
    if (!supervisorCallControlId) {
      return NextResponse.json({ error: "missing_supervisor_call" }, { status: 400 });
    }

    const result = await stopVoiceTestListener({ supervisorCallControlId });
    return NextResponse.json({ ok: result.ok === true });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to stop listener" },
      { status: 500 },
    );
  }
}
