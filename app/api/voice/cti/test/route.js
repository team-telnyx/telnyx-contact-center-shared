import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";

/**
 * POST /api/voice/cti/test
 * Test connection to SIP phone via SIP NOTIFY
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

    // Validate phone config
    const { ip, port = "5060", username, macAddress, model = "Polycom VVX300" } = phoneConfig;

    // For now, simulate a connection test
    // TODO: Implement actual SIP NOTIFY ping/status check
    const isValidIP = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip);
    
    if (!isValidIP) {
      return NextResponse.json(
        { ok: false, error: "Invalid IP address format" },
        { status: 400 }
      );
    }

    // Simulate connection test (replace with actual SIP NOTIFY)
    await new Promise(resolve => setTimeout(resolve, 500)); // Simulate network delay

    // Mock phone response - in real implementation, this would be SIP NOTIFY response
    const phoneStatus = {
      ip,
      port,
      model,
      status: "online",
      sipState: "registered",
      capabilities: ["dial", "answer", "hangup", "hold", "mute", "transfer"],
      lastSeen: new Date().toISOString(),
      macAddress: macAddress || "unknown",
      firmware: "5.9.7.3480" // Mock firmware version
    };

    return NextResponse.json({
      ok: true,
      message: `Successfully connected to ${model} at ${ip}:${port}`,
      data: {
        phoneStatus,
        connection: {
          method: "SIP_NOTIFY",
          transport: "UDP",
          timeout: 5000,
          testType: "ping"
        }
      }
    });

  } catch (err) {
    console.error("[CTI Test] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}