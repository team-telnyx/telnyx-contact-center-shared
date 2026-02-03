import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import {
  startChunkedSpeak,
  shouldChunk,
  cancelQueue,
} from "@/lib/contact-center/speak-queue";

/**
 * POST /api/voice/call-action
 * Execute a Telnyx call control action (hangup, transfer, etc.)
 */
export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { action, callControlId, params = {} } = body;

    if (!action || !callControlId) {
      return NextResponse.json(
        { ok: false, error: "action and callControlId are required" },
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

    // For speak actions with long text, use chunked speak queue
    if (action === "speak" && params.payload && shouldChunk(params.payload)) {
      const result = await startChunkedSpeak(
        callControlId,
        params.payload,
        params.voice || "female",
        params.language
      );

      if (!result.ok) {
        return NextResponse.json(
          { ok: false, error: result.error || "Failed to start chunked speak" },
          { status: 500 }
        );
      }

      return NextResponse.json({
        ok: true,
        chunked: true,
        totalChunks: result.totalChunks,
        data: {},
      });
    }

    // For stop_speak actions, also cancel any active speak queue
    if (action === "stop_speak" || (action === "speak" && params.stop === "all")) {
      cancelQueue(callControlId);
    }

    // Build the Telnyx API URL for the call control action
    const url = buildTelnyxV2Url(
      `/calls/${encodeURIComponent(callControlId)}/actions/${action}`
    );

    // Prepare request body
    const requestBody = { ...params };

    // Make the API call to Telnyx
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${telnyxApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const errorMsg =
        data?.errors?.[0]?.detail ||
        data?.message ||
        "Failed to execute action";
      console.error("[CallAction] Telnyx API error:", errorMsg);
      return NextResponse.json(
        { ok: false, error: errorMsg },
        { status: resp.status }
      );
    }

    return NextResponse.json({
      ok: true,
      data: data.data || data,
    });
  } catch (err) {
    console.error("[CallAction] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}
