import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";

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

    const token = process.env.TELNYX_API_KEY;
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Missing Telnyx API key" },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const params = new URLSearchParams();

    const callSessionId = searchParams.get("call_session_id");
    if (callSessionId) {
      params.set("filter[call_session_id]", callSessionId);
    }

    searchParams.forEach((value, key) => {
      if (key === "call_session_id") return;
      params.set(key, value);
    });

    const baseUrl = getTelnyxBaseUrl();
    const telnyxUrl = `${baseUrl}/v2/recordings?${params.toString()}`;

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
        { status: res.status }
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
      { status: 500 }
    );
  }
}

