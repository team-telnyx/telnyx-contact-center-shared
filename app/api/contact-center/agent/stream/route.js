import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { addSseClient, removeSseClient } from "@/lib/sse";

// Disable timeout for SSE streams (they should stay open indefinitely)
export const maxDuration = 300; // 5 minutes (max allowed by Vercel, but effectively unlimited for SSE)

/**
 * GET /api/contact-center/agent/stream
 * SSE endpoint for real-time agent updates
 */
export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const sseKey = `contact-center:agent:${user.username}`;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let timer = null;
        let disconnectHandled = false;

        const cleanup = async () => {
          if (closed || disconnectHandled) {
            return;
          }
          closed = true;
          disconnectHandled = true;

          try {
            if (timer) clearInterval(timer);
          } catch (_) {}
          try {
            removeSseClient(sseKey, proxyWriter);
          } catch (_) {}
          try {
            controller.close?.();
          } catch (_) {}

          // Wait a bit to see if connection reconnects
          // This prevents setting offline during temporary reconnects
          await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay

          // Check if the agent stream reconnected
          const { hasActiveClients } = await import("@/lib/sse");
          const stillHasConnection = hasActiveClients(sseKey);

          // Set to offline if agent stream didn't reconnect
          // The contact center agent stream is the primary indicator of active contact center usage
          // Even if status/queue connections exist, if agent stream is lost, user should be offline
          if (!stillHasConnection) {
            try {
              const { PgDb } = await import("@/lib/pgdb");
              const { setUserStatus } = await import(
                "@/lib/contact-center/user-status"
              );
              const currentUser = await PgDb.findUserById(String(user.id));
              if (currentUser && currentUser.status !== "Offline") {
                await setUserStatus({
                  userId: String(user.id),
                  username: user.username,
                  status: "Offline",
                  previousStatus: currentUser.status,
                });
              }
            } catch (error) {
              // Failed to set status to offline on disconnect
            }
          }
        };

        let writeFailures = 0;
        const write = async (chunk) => {
          if (closed) return;
          try {
            controller.enqueue(
              typeof chunk === "string" ? encoder.encode(chunk) : chunk
            );
            writeFailures = 0; // Reset on success
          } catch (error) {
            writeFailures++;
            // If write fails multiple times, connection is likely dead
            if (writeFailures >= 2) {
              cleanup();
            }
          }
        };

        const proxyWriter = { write };
        addSseClient(sseKey, proxyWriter);

        // Send initial connection event
        write(
          "event: connected\ndata: " +
            JSON.stringify({ username: user.username }) +
            "\n\n"
        );

        // Keep-alive ping every 15s to prevent timeouts
        timer = setInterval(() => {
          write("event: ping\n\n");
        }, 15000);

        // Abort when client disconnects
        try {
          request?.signal?.addEventListener("abort", cleanup, { once: true });
        } catch (_) {}
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
