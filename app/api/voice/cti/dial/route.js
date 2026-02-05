import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { sendPolycomNotify } from "@/lib/cti/polycom-sip-notify";

/**
 * POST /api/voice/cti/dial
 * Initiate a call via SIP NOTIFY to IP phone
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
    const { phoneConfig, number } = body;

    if (!phoneConfig || !phoneConfig.ip) {
      return NextResponse.json(
        { ok: false, error: "Phone configuration with IP address is required" },
        { status: 400 }
      );
    }

    if (!number) {
      return NextResponse.json(
        { ok: false, error: "Phone number is required" },
        { status: 400 }
      );
    }

    // Validate number (basic check)
    if (number.length < 3) {
      return NextResponse.json(
        { ok: false, error: "Invalid phone number" },
        { status: 400 }
      );
    }

    console.log(`[CTI Dial] Sending dial command to ${phoneConfig.ip}:${phoneConfig.port || 5060} for number ${number}`);

    // Send actual SIP NOTIFY
    const result = await sendPolycomNotify(phoneConfig, 'dial', { number });

    if (!result.success) {
      console.warn(`[CTI Dial] Failed: ${result.error || 'Unknown error'}`, result);
      return NextResponse.json(
        { 
          ok: false, 
          error: result.error || "Phone rejected command",
          details: result 
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: `Dial command accepted by phone`,
      data: result
    });

  } catch (err) {
    console.error("[CTI Dial] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}
