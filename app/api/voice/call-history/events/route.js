import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";

function getTelnyxBaseUrl() {
  return process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";
}

export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 }
      );
    }

    const token = process.env.TELNYX_API_KEY;
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Missing Telnyx API key" },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const params = new URLSearchParams(searchParams);

    const baseUrl = getTelnyxBaseUrl();
    const telnyxUrl = `${baseUrl}/v2/call_events?${params.toString()}`;

    const res = await fetch(telnyxUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("[CallHistoryEvents] Telnyx error:", errorText);
      return NextResponse.json(
        { ok: false, error: "Failed to fetch call events from Telnyx" },
        { status: res.status }
      );
    }

    const data = await res.json();
    const rows = (data.data || []).map((event) => ({
      ...event,
      occurred_at: event.event_timestamp || event.occurred_at,
      payload: event.metadata || event.payload || {},
    }));

    return NextResponse.json({
      ok: true,
      data: rows,
      meta: data.meta || {},
    });
  } catch (error) {
    console.error("[CallHistoryEvents] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to fetch call events" },
      { status: 500 }
    );
  }
}

