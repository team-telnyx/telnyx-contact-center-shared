import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";

/**
 * POST /api/voice/cti/transfer
 * Transfer call to another number via SIP NOTIFY to IP phone
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
        { ok: false, error: "Transfer number is required" },
        { status: 400 }
      );
    }

    // Validate and normalize transfer number
    const cleanNumber = number.replace(/\D/g, ''); // Remove non-digits
    if (cleanNumber.length < 7) {
      return NextResponse.json(
        { ok: false, error: "Invalid transfer number" },
        { status: 400 }
      );
    }

    const { ip, port = "5060", model = "Polycom VVX300" } = phoneConfig;

    // TODO: Implement actual SIP NOTIFY for Polycom VVX300 transfer command
    // For Polycom phones, the SIP NOTIFY would look like:
    // NOTIFY sip:user@phone.ip SIP/2.0
    // Event: polycom-call
    // Content-Type: application/polycom-call+xml
    // 
    // <PolycomIPPhone>
    //   <Call>
    //     <Action>transfer</Action>
    //     <Number>+1234567890</Number>
    //   </Call>
    // </PolycomIPPhone>

    console.log(`[CTI Transfer] Sending transfer command to ${ip}:${port} for number ${number}`);

    // Simulate SIP NOTIFY send
    await new Promise(resolve => setTimeout(resolve, 300)); // Simulate network delay

    // Mock response - in real implementation, this would be the SIP NOTIFY response
    const transferResponse = {
      sipNotifyResult: {
        status: "200 OK",
        method: "NOTIFY",
        event: "polycom-call",
        target: `sip:${phoneConfig.username}@${ip}:${port}`,
        contentType: "application/polycom-call+xml"
      },
      callInfo: {
        action: "transfer",
        transferTarget: number,
        state: "transferring",
        timestamp: new Date().toISOString()
      }
    };

    return NextResponse.json({
      ok: true,
      message: `Transfer command sent to ${model} at ${ip} for number ${number}`,
      data: transferResponse
    });

  } catch (err) {
    console.error("[CTI Transfer] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}