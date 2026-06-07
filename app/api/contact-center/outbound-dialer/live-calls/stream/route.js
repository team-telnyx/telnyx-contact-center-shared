import { NextResponse } from "next/server";
import { getOutboundPool, requireOutboundSupervisor } from "@/lib/outbound-dialer/api";
import { buildOutboundLiveCallsPayload, OUTBOUND_LIVE_CALLS_SQL } from "@/lib/outbound-dialer/live-calls";
import { liveCallsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function loadLiveCalls(pool) {
  const { rows } = await pool.query(OUTBOUND_LIVE_CALLS_SQL);
  return buildOutboundLiveCallsPayload(rows);
}

export async function GET(request) {
  try {
    const user = await requireOutboundSupervisor();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const pool = getOutboundPool();
    if (!pool) return NextResponse.json({ error: "Postgres is not configured" }, { status: 503 });

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let timer = null;

        const send = (payload, eventType = "live_calls") => {
          if (closed) return;
          controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`));
        };

        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          try {
            controller.close();
          } catch {
            // client already disconnected
          }
        };

        const pushUpdate = async () => {
          if (closed) return;
          try {
            send(await loadLiveCalls(pool));
          } catch (error) {
            send({ type: "error", message: error?.message || "live calls stream update failed" }, "error");
          }
        };

        send({ type: "connected", timestamp: new Date().toISOString() }, "connected");
        pushUpdate();
        timer = setInterval(pushUpdate, 2000);
        request.signal.addEventListener("abort", cleanup);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    liveCallsLogger.error("live_calls_stream_failed", { ...outboundErrorPayload(error) });
    return NextResponse.json({ error: error?.message || "Failed to stream live calls" }, { status: 500 });
  }
}
