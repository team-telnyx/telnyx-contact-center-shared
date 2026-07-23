import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { replaceSseClient, removeSseClient } from "@/lib/sse";

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

          // Agent SSE is a read/presence transport only. Do not persist routing
          // status from connect/disconnect lifecycle; DB-authoritative call
          // lifecycle status is owned by agent-call-lifecycle-status.js.
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
        // One live connection per agent expected here — evict any stale writer
        // under the same key instead of leaving both registered. Through a
        // tunnel (cloudflared/ngrok), a silent client reconnect can otherwise
        // leave an old, undetected-dead writer receiving broadcasts for up to
        // 15s (until the ping-failure cleanup), causing the same event to be
        // delivered twice and rendered as a duplicate transcription bubble.
        replaceSseClient(sseKey, proxyWriter);

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
