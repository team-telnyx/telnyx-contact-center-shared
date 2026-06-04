import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { addSseClient, removeSseClient } from "@/lib/sse";

// Disable timeout for SSE streams (they should stay open indefinitely)
export const maxDuration = 300; // 5 minutes (max allowed by Vercel, but effectively unlimited for SSE)

// Server-Sent Events endpoint for real-time status and queue updates
export async function GET(request) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = String(user.id);
  const statusKey = `user:status:${userId}`;
  const queueKey = `user:queues:${userId}`;

  // Create a readable stream for SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Create a writer-like object that wraps controller.enqueue
      const writer = {
        write: async (data) => {
          try {
            controller.enqueue(data);
          } catch (error) {
            console.error("[SSE] Failed to enqueue event:", error);
            throw error;
          }
        },
        close: async () => {
          try {
            controller.close();
          } catch (_) {}
        },
      };

      // Register this client for status and queue updates
      addSseClient(statusKey, writer);
      addSseClient(queueKey, writer);

      // Send initial connection event
      const sendEvent = async (event, data) => {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          await writer.write(encoder.encode(message));
        } catch (error) {
          console.error("[SSE] Failed to write event:", error);
        }
      };

      // Send connected event
      await sendEvent("connected", { timestamp: new Date().toISOString() });

      // Track last successful ping to detect stale connections
      let lastPingSuccess = Date.now();
      let consecutiveFailures = 0;
      let pingInterval = null;
      let disconnectHandled = false;

      // Handle client disconnect. SSE is a read-only presence transport for the
      // header/queue widgets; it must never persist Contact Center routing
      // status. Call lifecycle status is owned by backend call-state handlers,
      // and manual status changes are owned by the dropdown/profile API.
      const handleDisconnect = async () => {
        // Prevent multiple calls
        if (disconnectHandled) {
          return;
        }
        disconnectHandled = true;

        if (pingInterval) {
          clearInterval(pingInterval);
        }
        removeSseClient(statusKey, writer);
        removeSseClient(queueKey, writer);
        try {
          await writer.close();
        } catch (_) {}

        // Do not write agent status here.
      };

      // Send periodic ping to keep connection alive
      // Use shorter interval to prevent any timeout issues
      pingInterval = setInterval(async () => {
        try {
          await sendEvent("ping", { timestamp: new Date().toISOString() });
          lastPingSuccess = Date.now();
          consecutiveFailures = 0;
        } catch (error) {
          consecutiveFailures++;
          // If ping fails, connection is likely dead - trigger cleanup
          if (consecutiveFailures >= 2) {
            clearInterval(pingInterval);
            removeSseClient(statusKey, writer);
            removeSseClient(queueKey, writer);
            try {
              await writer.close();
            } catch (_) {}
            // Trigger disconnect handler
            handleDisconnect();
          }
        }
      }, 15000); // Ping every 15 seconds to keep connection alive

      request.signal.addEventListener("abort", handleDisconnect);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable buffering for nginx
    },
  });
}
