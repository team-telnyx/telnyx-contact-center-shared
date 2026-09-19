import { NextResponse } from "next/server";
import { getOutboundPool } from "@/lib/outbound-dialer/api";
import { buildOutboundLiveCallsPayload, OUTBOUND_LIVE_CALLS_SQL } from "@/lib/outbound-dialer/live-calls";
import { OUTBOUND_LIVE_CALLS_CHANGED_TOPIC } from "@/lib/outbound-dialer/live-calls-events.mjs";
import { liveCallsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { subscribe } from "@/lib/events/event-bus";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function loadLiveCalls(pool) {
  const { rows } = await pool.query(OUTBOUND_LIVE_CALLS_SQL);
  return buildOutboundLiveCallsPayload(rows);
}

async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;

    const pool = getOutboundPool();
    if (!pool) return NextResponse.json({ error: "Postgres is not configured" }, { status: 503 });

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let timer = null;
        let unsubscribe = null;
        let pushing = false;
        let pendingPush = false;

        const send = (payload, eventType = "live_calls") => {
          if (closed) return;
          controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`));
        };

        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          unsubscribe?.();
          unsubscribe = null;
          try {
            controller.close();
          } catch {
            // client already disconnected
          }
        };

        const pushUpdate = async () => {
          if (closed) return;
          if (pushing) {
            pendingPush = true;
            return;
          }
          pushing = true;
          try {
            do {
              pendingPush = false;
              try {
                send(await loadLiveCalls(pool));
              } catch (error) {
                send({ type: "error", message: error?.message || "live calls stream update failed" }, "error");
              }
            } while (pendingPush && !closed);
          } finally {
            pushing = false;
          }
        };

        send({ type: "connected", timestamp: new Date().toISOString() }, "connected");
        pushUpdate();
        timer = setInterval(pushUpdate, 2000);
        subscribe(OUTBOUND_LIVE_CALLS_CHANGED_TOPIC, pushUpdate)
          .then((stop) => {
            if (closed) stop();
            else unsubscribe = stop;
          })
          .catch((error) => {
            liveCallsLogger.warn("live_calls_event_subscription_failed", { ...outboundErrorPayload(error) });
          });
        request.signal.addEventListener("abort", cleanup);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    liveCallsLogger.error("live_calls_stream_failed", { ...outboundErrorPayload(error) });
    return NextResponse.json({ error: error?.message || "Failed to stream live calls" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("campaigns:read", GET_handler, { route: "/api/contact-center/outbound-dialer/live-calls/stream" });
