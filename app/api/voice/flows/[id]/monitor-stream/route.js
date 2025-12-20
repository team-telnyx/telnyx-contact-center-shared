/**
 * SSE endpoint for streaming real-time flow execution events
 * Streams node and edge activations for visual monitoring
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { NextResponse } from "next/server";
import { getFlowExecutionEvents } from "@/lib/call-monitor-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/flows/[id]/monitor-stream
 * Server-Sent Events endpoint for real-time flow monitoring
 */
export async function GET(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const { id: flowId } = await params;

    // Create a TransformStream for SSE
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();

    // Send SSE headers
    const response = new NextResponse(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });

    // Function to send SSE message
    const sendEvent = async (event, data) => {
      try {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        await writer.write(encoder.encode(message));
      } catch (error) {
        console.error("[Monitor Stream] Error sending event:", error);
      }
    };

    // Send initial connection event
    sendEvent("connected", { flowId, timestamp: new Date().toISOString() });

    // Poll for new events every 100ms
    const pollInterval = setInterval(async () => {
      try {
        const events = getFlowExecutionEvents(flowId);
        if (events.length > 0) {
          await sendEvent("execution", { flowId, events });
        }
      } catch (error) {
        console.error("[Monitor Stream] Error polling events:", error);
      }
    }, 100);

    // Heartbeat every 15 seconds to keep connection alive
    const heartbeatInterval = setInterval(async () => {
      try {
        await sendEvent("heartbeat", { timestamp: new Date().toISOString() });
      } catch (error) {
        console.error("[Monitor Stream] Error sending heartbeat:", error);
      }
    }, 15000);

    // Cleanup on connection close
    request.signal.addEventListener("abort", () => {
      console.log("[Monitor Stream] Client disconnected");
      clearInterval(pollInterval);
      clearInterval(heartbeatInterval);
      writer.close();
    });

    return response;
  } catch (error) {
    console.error("[Monitor Stream] Error:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to start monitor stream" },
      { status: 500 }
    );
  }
}
