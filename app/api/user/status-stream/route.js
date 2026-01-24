import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { addSseClient, removeSseClient, broadcastToKey } from "@/lib/sse";

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

      // Handle client disconnect - set status to offline only if no other connections exist
      const handleDisconnect = async () => {
        // Prevent multiple calls
        if (disconnectHandled) {
          console.log("[SSE] Disconnect already handled, skipping");
          return;
        }
        disconnectHandled = true;

        console.log("[SSE] Disconnect handler triggered for user:", {
          userId,
          username: user.username,
        });

        if (pingInterval) {
          clearInterval(pingInterval);
        }
        removeSseClient(statusKey, writer);
        removeSseClient(queueKey, writer);
        try {
          await writer.close();
        } catch (_) {}

        // Wait a bit to see if connection reconnects or if other connections exist
        // This prevents setting offline during temporary reconnects
        await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay

        // Check if there are still active connections for this user
        const { hasActiveClients } = await import("@/lib/sse");
        const stillHasStatusConnection = hasActiveClients(statusKey);
        const stillHasQueueConnection = hasActiveClients(queueKey);

        // Also check contact center agent stream
        const agentStreamKey = `contact-center:agent:${user.username}`;
        const stillHasAgentConnection = hasActiveClients(agentStreamKey);

        console.log("[SSE] Connection status check:", {
          userId,
          username: user.username,
          stillHasStatusConnection,
          stillHasQueueConnection,
          stillHasAgentConnection,
        });

        // Only set to offline if no active connections remain
        if (
          !stillHasStatusConnection &&
          !stillHasQueueConnection &&
          !stillHasAgentConnection
        ) {
          try {
            const { PgDb } = await import("@/lib/pgdb");
            const { setUserStatus } = await import(
              "@/lib/contact-center/user-status"
            );
            const currentUser = await PgDb.findUserById(userId);
            if (currentUser && currentUser.status !== "Offline") {
              console.log(
                "[SSE] All connections lost, setting user status to Offline:",
                {
                  userId,
                  username: user.username,
                  previousStatus: currentUser.status,
                }
              );
              await setUserStatus({
                userId,
                username: user.username,
                status: "Offline",
                previousStatus: currentUser.status,
              });
            } else {
              console.log("[SSE] User already offline or not found:", {
                userId,
                currentStatus: currentUser?.status,
              });
            }
          } catch (error) {
            console.error(
              "[SSE] Failed to set status to offline on disconnect:",
              error
            );
          }
        } else {
          console.log(
            "[SSE] Connection lost but other connections still active, not setting offline:",
            {
              stillHasStatusConnection,
              stillHasQueueConnection,
              stillHasAgentConnection,
            }
          );
        }
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
          console.log("[SSE] Ping failed, consecutive failures:", consecutiveFailures);
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
