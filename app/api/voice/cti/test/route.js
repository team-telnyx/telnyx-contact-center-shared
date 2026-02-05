import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { testPolycomConnection } from "@/lib/cti/polycom-sip-notify";

/**
 * POST /api/voice/cti/test
 * Test SIP connection to IP phone (OPTIONS)
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

    console.log(`[CTI Test] Testing connection to ${phoneConfig.ip}:${phoneConfig.port || 5060}`);

    const result = await testPolycomConnection(phoneConfig);

    if (!result.success) {
      return NextResponse.json(
        { ok: false, error: "Connection test failed", details: result },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: "Phone is reachable via SIP",
      data: result
    });

  } catch (err) {
    console.error("[CTI Test] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}
