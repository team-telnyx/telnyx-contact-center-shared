export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { buildTelnyxV2Url } from "@/lib/telnyx";

/**
 * POST /api/messaging/send
 * Send SMS message via Telnyx
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
    const { to, body: messageBody, type = "SMS" } = body;

    if (!to || !messageBody) {
      return NextResponse.json(
        { ok: false, error: "to and body are required" },
        { status: 400 }
      );
    }

    if (type !== "SMS") {
      return NextResponse.json(
        { ok: false, error: "Only SMS type is supported" },
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

    // Get messaging profile ID from environment or use default
    const messagingProfileId =
      process.env.TELNYX_MESSAGING_PROFILE_ID?.trim();

    if (!messagingProfileId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "TELNYX_MESSAGING_PROFILE_ID not configured. Please set it in environment variables.",
        },
        { status: 500 }
      );
    }

    // Build Telnyx API URL
    const url = buildTelnyxV2Url("/messages");

    // Prepare request body
    const requestBody = {
      to: to,
      text: messageBody,
      messaging_profile_id: messagingProfileId,
    };

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
        data?.errors?.[0]?.message ||
        data?.message ||
        "Failed to send message";
      console.error("[Messaging] Telnyx API error:", errorMsg);
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
    console.error("[Messaging] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}

