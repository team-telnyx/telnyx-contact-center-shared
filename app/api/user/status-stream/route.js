import { NextResponse } from "next/server";
import { addSseClient, removeSseClient } from "@/lib/sse";
import { platformApiLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

// Disable timeout for SSE streams (they should stay open indefinitely)
export const maxDuration = 300; // 5 minutes (max allowed by Vercel, but effectively unlimited for SSE)

// Server-Sent Events endpoint for real-time status and queue updates
async function GET_handler(request, _context, authz) {
  const user = authz.user;

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
            platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
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
          platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
          throw error;
        }
      };

      // Send connected event
      await sendEvent("connected", { timestamp: new Date().toISOString() });

      let consecutiveFailures = 0;
      let pingInterval = null;
      let disconnectHandled = false;

      // This stream carries queue/campaign and transient call metadata only.
      // WebRTC readiness is authored exclusively by acd_agent_sessions.
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
      };

      // Send periodic ping to keep connection alive
      // Use shorter interval to prevent any timeout issues
      pingInterval = setInterval(async () => {
        try {
          await sendEvent("ping", { timestamp: new Date().toISOString() });
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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("authenticated", GET_handler, { route: "/api/user/status-stream" });
