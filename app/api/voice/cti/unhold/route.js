import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";

/**
 * POST /api/voice/cti/unhold
 * Resume call from hold via SIP NOTIFY to IP phone
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

    // TODO: Implement actual SIP NOTIFY for Polycom VVX300 unhold command
    // For Polycom phones, the SIP NOTIFY would look like:
    // NOTIFY sip:user@phone.ip SIP/2.0
    // Event: polycom-call
    // Content-Type: application/polycom-call+xml
    // 
    // <PolycomIPPhone>
    //   <Call>
    //     <Action>unhold</Action>
    //   </Call>
    // </PolycomIPPhone>

    console.log(`[CTI Unhold] Sending unhold command to ${ip}:${port}`);

    // Simulate SIP NOTIFY send
    await new Promise(resolve => setTimeout(resolve, 200)); // Simulate network delay

    // Mock response - in real implementation, this would be the SIP NOTIFY response
    const unholdResponse = {
      sipNotifyResult: {
        status: "200 OK",
        method: "NOTIFY",
        event: "polycom-call",
        target: `sip:${phoneConfig.username}@${ip}:${port}`,
        contentType: "application/polycom-call+xml"
      },
      callInfo: {
        action: "unhold",
        state: "connected",
        timestamp: new Date().toISOString()
      }
    };

    return NextResponse.json({
      ok: true,
      message: `Unhold command sent to ${model} at ${ip}`,
      data: unholdResponse
    });

  } catch (err) {
    console.error("[CTI Unhold] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}