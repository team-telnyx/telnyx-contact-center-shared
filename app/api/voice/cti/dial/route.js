import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";

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

    // Validate and normalize phone number
    const cleanNumber = number.replace(/\D/g, ''); // Remove non-digits
    if (cleanNumber.length < 7) {
      return NextResponse.json(
        { ok: false, error: "Invalid phone number" },
        { status: 400 }
      );
    }

    const { ip, port = "5060", model = "Polycom VVX300" } = phoneConfig;

    // TODO: Implement actual SIP NOTIFY for Polycom VVX300
    // For Polycom phones, we would send something like:
    // NOTIFY sip:user@phone.ip SIP/2.0
    // Event: polycom-call
    // Content-Type: application/polycom-call+xml
    // 
    // <PolycomIPPhone>
    //   <Call>
    //     <Number>+1234567890</Number>
    //     <Action>dial</Action>
    //   </Call>
    // </PolycomIPPhone>

    console.log(`[CTI Dial] Sending dial command to ${ip}:${port} for number ${number}`);

    // Simulate SIP NOTIFY send
    await new Promise(resolve => setTimeout(resolve, 300)); // Simulate network delay

    // Mock response - in real implementation, this would be the SIP NOTIFY response
    const dialResponse = {
      sipNotifyResult: {
        status: "200 OK",
        method: "NOTIFY",
        event: "polycom-call",
        target: `sip:${phoneConfig.username}@${ip}:${port}`,
        contentType: "application/polycom-call+xml"
      },
      callInfo: {
        callId: `call-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        number: number,
        direction: "outbound",
        state: "dialing",
        startTime: new Date().toISOString()
      }
    };

    return NextResponse.json({
      ok: true,
      message: `Dial command sent to ${model} at ${ip} for number ${number}`,
      data: dialResponse
    });

  } catch (err) {
    console.error("[CTI Dial] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}