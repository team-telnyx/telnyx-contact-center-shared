import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { sendPolycomNotify } from "@/lib/cti/polycom-sip-notify";

/**
 * POST /api/voice/cti/answer
 * Answer incoming call via SIP NOTIFY
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

    console.log(`[CTI Answer] Sending answer command to ${phoneConfig.ip}:${phoneConfig.port || 5060}`);

    const result = await sendPolycomNotify(phoneConfig, 'answer');

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
    console.error("[CTI Answer] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}
