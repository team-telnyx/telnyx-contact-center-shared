import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { addSseClient, removeSseClient, broadcastToKey } from "@/lib/sse";

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

      // Send periodic ping to keep connection alive
      const pingInterval = setInterval(async () => {
        try {
          await sendEvent("ping", { timestamp: new Date().toISOString() });
        } catch (error) {
          clearInterval(pingInterval);
          removeSseClient(statusKey, writer);
          removeSseClient(queueKey, writer);
          try {
            await writer.close();
          } catch (_) {}
        }
      }, 30000); // Ping every 30 seconds

      // Handle client disconnect
      request.signal.addEventListener("abort", async () => {
        clearInterval(pingInterval);
        removeSseClient(statusKey, writer);
        removeSseClient(queueKey, writer);
        try {
          await writer.close();
        } catch (_) {}
      });
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
