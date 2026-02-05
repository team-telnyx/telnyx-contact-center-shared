import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { sendPolycomNotify } from "@/lib/cti/polycom-sip-notify";

/**
 * POST /api/voice/cti/mute
 * Toggle mute via SIP NOTIFY
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
    const { phoneConfig } = body;

    if (!phoneConfig || !phoneConfig.ip) {
      return NextResponse.json(
        { ok: false, error: "Phone configuration with IP address is required" },
        { status: 400 }
      );
    }

    console.log(`[CTI Mute] Sending mute command to ${phoneConfig.ip}:${phoneConfig.port || 5060}`);

    const result = await sendPolycomNotify(phoneConfig, 'mute');

    if (!result.success) {
      return NextResponse.json(
        { ok: false, error: result.error || "Phone rejected command", details: result },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: result
    });

  } catch (err) {
    console.error("[CTI Mute] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}
