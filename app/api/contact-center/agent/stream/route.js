import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { addSseClient, removeSseClient } from "@/lib/sse";

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

        const cleanup = () => {
          if (closed) return;
          closed = true;
          try {
            if (timer) clearInterval(timer);
          } catch (_) {}
          try {
            removeSseClient(sseKey, proxyWriter);
          } catch (_) {}
          try {
            controller.close?.();
          } catch (_) {}
        };

        const write = async (chunk) => {
          if (closed) return;
          try {
            controller.enqueue(
              typeof chunk === "string" ? encoder.encode(chunk) : chunk
            );
          } catch (_) {
            cleanup();
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

        // Keep-alive ping every 20s
        timer = setInterval(() => {
          write("event: ping\n\n");
        }, 20000);

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
    console.error("[ContactCenter] SSE stream error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

