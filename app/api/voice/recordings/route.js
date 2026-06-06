import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

/**
 * GET /api/voice/recordings
 * Fetch call recordings from Telnyx API
 *
 * Query parameters:
 * - call_session_id: Filter recordings by call session ID (direct filter)
 * - call_control_id: Filter recordings by call control ID (fetches call_session_id first)
 * - Other query params are passed through to Telnyx API (e.g., page[size], page[number])
 *
 * If call_control_id is provided, the endpoint will:
 * 1. Fetch call information from /v2/calls/{call_control_id} to get call_session_id
 * 2. Use call_session_id to filter recordings
 */
export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const token = process.env.TELNYX_API_KEY;
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Missing Telnyx API key" },
        { status: 500 },
      );
    }

    const { searchParams } = new URL(request.url);
    let callSessionId = searchParams.get("call_session_id");
    const callControlId = searchParams.get("call_control_id");

    // If call_control_id is provided, fetch call_session_id first
    if (callControlId && !callSessionId) {
      try {
        const callUrl = buildTelnyxV2Url(
          `/calls/${encodeURIComponent(callControlId)}`,
        );
        const callRes = await fetch(callUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          cache: "no-store",
        });

        if (callRes.ok) {
          const callData = await callRes.json();
          const callInfo = callData.data || callData;
          callSessionId = callInfo.call_session_id || callInfo.callSessionId;

          if (!callSessionId) {
            return NextResponse.json(
              {
                ok: false,
                error:
                  "Call session ID not found for the provided call control ID",
              },
              { status: 404 },
            );
          }
        } else {
          const errorText = await callRes.text();
          console.error("[Recordings] Failed to fetch call info:", errorText);
          return NextResponse.json(
            {
              ok: false,
              error: "Failed to fetch call information from Telnyx",
            },
            { status: callRes.status },
          );
        }
      } catch (fetchError) {
        console.error("[Recordings] Error fetching call info:", fetchError);
        return NextResponse.json(
          { ok: false, error: "Failed to fetch call information" },
          { status: 500 },
        );
      }
    }

    // Build query parameters for recordings endpoint
    const params = new URLSearchParams();

    if (callSessionId) {
      params.set("filter[call_session_id]", callSessionId);
    }

    // Pass through other query parameters (e.g., pagination, other filters)
    searchParams.forEach((value, key) => {
      // Skip call_control_id and call_session_id as they're handled above
      if (key === "call_control_id" || key === "call_session_id") return;
      params.set(key, value);
    });

    // Fetch recordings from Telnyx API
    const telnyxUrl = buildTelnyxV2Url(`/recordings?${params.toString()}`);

    const res = await fetch(telnyxUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("[Recordings] Telnyx error:", errorText);
      return NextResponse.json(
        { ok: false, error: "Failed to fetch recordings from Telnyx" },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json({
      ok: true,
      data: data?.data || [],
      meta: data?.meta || {},
    });
  } catch (error) {
    console.error("[Recordings] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to fetch recordings" },
      { status: 500 },
    );
  }
}
