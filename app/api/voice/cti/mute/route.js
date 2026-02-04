import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";

/**
 * POST /api/voice/cti/mute
 * Toggle mute via SIP NOTIFY to IP phone
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

    const { ip, port = "5060", model = "Polycom VVX300" } = phoneConfig;

    // TODO: Implement actual SIP NOTIFY for Polycom VVX300 mute command
    // For Polycom phones, the SIP NOTIFY would look like:
    // NOTIFY sip:user@phone.ip SIP/2.0
    // Event: polycom-call
    // Content-Type: application/polycom-call+xml
    // 
    // <PolycomIPPhone>
    //   <Call>
    //     <Action>mute</Action>
    //   </Call>
    // </PolycomIPPhone>

    console.log(`[CTI Mute] Sending mute toggle command to ${ip}:${port}`);

    // Simulate SIP NOTIFY send
    await new Promise(resolve => setTimeout(resolve, 200)); // Simulate network delay

    // Mock response - in real implementation, this would be the SIP NOTIFY response
    const muteResponse = {
      sipNotifyResult: {
        status: "200 OK",
        method: "NOTIFY",
        event: "polycom-call",
        target: `sip:${phoneConfig.username}@${ip}:${port}`,
        contentType: "application/polycom-call+xml"
      },
      callInfo: {
        action: "mute_toggle",
        muteState: "toggled", // In real implementation, phone would return current mute state
        timestamp: new Date().toISOString()
      }
    };

    return NextResponse.json({
      ok: true,
      message: `Mute toggle command sent to ${model} at ${ip}`,
      data: muteResponse
    });

  } catch (err) {
    console.error("[CTI Mute] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}