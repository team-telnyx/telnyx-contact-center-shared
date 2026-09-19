import { NextResponse } from "next/server";
import { replaceSseClient, removeSseClient } from "@/lib/sse";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readAgentStream } from "@/lib/acd/stream.mjs";
import { withPermission } from "@/lib/authz/guard";

// Disable timeout for SSE streams (they should stay open indefinitely)
export const maxDuration = 300; // 5 minutes (max allowed by Vercel, but effectively unlimited for SSE)

/**
 * GET /api/contact-center/agent/stream
 * SSE endpoint for real-time agent updates
 */
async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;

    const sseKey = `contact-center:agent:${user.username}`;
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ error: "State unavailable" }, { status: 503 });
    const requestedCursor = request.headers.get("last-event-id") || new URL(request.url).searchParams.get("after") || "0";
    let cursor = /^\d{1,18}$/.test(requestedCursor) ? requestedCursor : "0";

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let timer = null;
        let pollTimer = null;
        let polling = false;
        let disconnectHandled = false;

        const cleanup = async () => {
          if (closed || disconnectHandled) {
            return;
          }
          closed = true;
          disconnectHandled = true;

          try {
            if (timer) clearInterval(timer);
            if (pollTimer) clearTimeout(pollTimer);
          } catch (_) {}
          try {
            removeSseClient(sseKey, proxyWriter);
          } catch (_) {}
          try {
            controller.close?.();
          } catch (_) {}

          // The stream is read-only. WebRTC session heartbeats and Core
          // lifecycle transitions are the only presence/workflow writers.
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

        const poll = async (snapshot = false) => {
          if (closed || polling) return;
          polling = true;
          let more = false;
          try {
            const batch = await readAgentStream(pool, { agentId: user.id, after: cursor, snapshot });
            cursor = batch.cursor;
            more = batch.more;
            await write(
              `id: ${cursor}\nevent: acd_sync\ndata: ${JSON.stringify({
                cursor,
                snapshot: batch.snapshot,
                recovery: batch.recovery,
              })}\n\n`,
            );
          } catch {
            // Reconnect obtains a fresh authorized snapshot; never skip a
            // cursor on database failure or expose another agent's events.
            await cleanup();
          } finally {
            polling = false;
            if (!closed) pollTimer = setTimeout(() => poll(), more ? 10 : 1000);
          }
        };
        poll(true);

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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/agent/stream" });
