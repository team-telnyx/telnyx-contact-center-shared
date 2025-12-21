/**
 * Webhook endpoint for Telnyx voice events
 * This route handles webhooks sent to /api/webhooks
 * It forwards to the same handler as /api/voice/webhook
 */

import { NextResponse } from "next/server";

// Import the original handler
import { POST as originalPOST } from "../voice/webhook/route";

export async function POST(request) {
  try {
    // Log incoming request details
    const url = request.url;
    const method = request.method;
    const headers = Object.fromEntries(request.headers.entries());

    // Read the body for logging
    const rawBody = await request.text();

    let parsedBody = null;
    try {
      parsedBody = JSON.parse(rawBody || "{}");
    } catch (e) {
      // Body might not be JSON
    }

    const eventType =
      parsedBody?.data?.event_type || parsedBody?.event_type || "unknown";
    const callControlId =
      parsedBody?.data?.payload?.call_control_id ||
      parsedBody?.payload?.call_control_id ||
      null;
    const callSessionId =
      parsedBody?.data?.payload?.call_session_id ||
      parsedBody?.payload?.call_session_id ||
      null;

    console.log("[webhooks] 📥 Incoming webhook to /api/webhooks:", {
      url,
      method,
      eventType,
      callControlId,
      callSessionId,
      headers: {
        "content-type": headers["content-type"],
        "x-telnyx-signature": headers["x-telnyx-signature"]
          ? "present"
          : "missing",
        "x-telnyx-timestamp": headers["x-telnyx-timestamp"],
        "user-agent": headers["user-agent"],
      },
      bodySize: rawBody.length,
      bodyPreview:
        rawBody.length > 500 ? rawBody.substring(0, 500) + "..." : rawBody,
    });

    // Create a new Request with the same body to forward to the original handler
    // (since we already consumed the original request's body stream)
    const newRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: rawBody,
    });

    // Forward to the original handler
    return await originalPOST(newRequest);
  } catch (err) {
    console.error("[webhooks] ❌ Error in /api/webhooks wrapper:", err);
    // If we got here, the body was already consumed, so we can't forward
    // Return error response
    return NextResponse.json(
      { error: "Error processing webhook", details: err.message },
      { status: 500 }
    );
  }
}
