export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

/**
 * GET /api/voice/calls/[callControlId]/state
 * Get call state from Telnyx API
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

    // Get call information from Telnyx
    const url = buildTelnyxV2Url(`/calls/${encodeURIComponent(callControlId)}`);
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${telnyxApiKey}`,
        "Content-Type": "application/json",
      },
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const errorMsg =
        data?.errors?.[0]?.detail ||
        data?.message ||
        "Failed to get call state";
      console.error("[CallState] Telnyx API error:", errorMsg);
      return NextResponse.json(
        { ok: false, error: errorMsg },
        { status: resp.status }
      );
    }

    const callData = data.data || data;
    const state = callData.state || callData.status || "unknown";

    return NextResponse.json({
      ok: true,
      state,
      callData,
    });
  } catch (err) {
    console.error("[CallState] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}

