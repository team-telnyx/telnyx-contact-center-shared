import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

/**
 * GET /api/voice/call-leg/[callControlId]
 * Get call leg information for a call control ID
 * This is a simplified version that returns the call control ID itself
 * In a full implementation, this would map WebRTC legs to PSTN legs
 */
export async function GET(request, { params }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { callControlId } = await params;
    if (!callControlId) {
      return NextResponse.json(
        { ok: false, error: "callControlId is required" },
        { status: 400 }
      );
    }

    const telnyxApiKey = process.env.TELNYX_API_KEY;
    if (!telnyxApiKey) {
      return NextResponse.json(
        { ok: false, error: "Server not configured" },
        { status: 500 }
      );
    }

    // Try to fetch call information from Telnyx
    try {
      const url = buildTelnyxV2Url(
        `/calls/${encodeURIComponent(callControlId)}`
      );
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${telnyxApiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (resp.ok) {
        const data = await resp.json();
        const callData = data.data || data;

        return NextResponse.json({
          ok: true,
          call_control_id: callControlId,
          call_session_id: callData.call_session_id || callData.callSessionId,
          // Return the call control ID as-is (simplified - in full implementation would map to PSTN leg)
          pstn_call_control_id: callData.call_control_id || callControlId,
        });
      }
    } catch (fetchErr) {
      voiceRuntimeLogger.warn("runtime_warning", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    }

    // Fallback: return the call control ID as-is
    // In a full implementation, this would use a mapping store
    return NextResponse.json({
      ok: true,
      call_control_id: callControlId,
      // Return the same ID as PSTN leg (simplified)
      pstn_call_control_id: callControlId,
    });
  } catch (err) {
    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}
