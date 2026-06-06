import { NextResponse } from "next/server";
import { getOutboundPool, mapCampaign, requireOutboundSupervisor } from "@/lib/outbound-dialer/api";
import { loadExecutionDebugByCampaign } from "../route";

export const maxDuration = 300;

async function loadCampaigns(pool) {
  const result = await pool.query(
    `SELECT c.*, l.name AS contact_list_name, f.name AS attached_form_name, ac.name AS attempt_control_name
     FROM outbound_campaigns c
     LEFT JOIN outbound_contact_lists l ON l.id = c.contact_list_id
     LEFT JOIN form_definitions f ON f.id = c.attached_form_id
     LEFT JOIN outbound_attempt_controls ac ON ac.id = c.attempt_control_id
     WHERE c.status <> 'archived'
     ORDER BY c.updated_at DESC
     LIMIT 100`,
  );
  return result.rows.map(mapCampaign);
}

export async function GET(request) {
  const user = await requireOutboundSupervisor();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pool = getOutboundPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let timer = null;

      const send = (payload, eventType = null) => {
        if (closed) return;
        const message = eventType
          ? `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`
          : `data: ${JSON.stringify(payload)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      const pushUpdate = async () => {
        if (closed) return;
        try {
          const campaigns = await loadCampaigns(pool);
          const executionDebugByCampaign = await loadExecutionDebugByCampaign(pool, campaigns.map((c) => c.id));
          send(
            {
              type: "outbound_update",
              timestamp: new Date().toISOString(),
              campaigns,
              executionDebugByCampaign,
            },
            "outbound_update",
          );
        } catch (err) {
          send({ type: "error", message: err?.message || "stream update failed" }, "error");
        }
      };

      send({ type: "connected", timestamp: new Date().toISOString() }, "connected");
      pushUpdate();
      timer = setInterval(pushUpdate, 3000);
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
}
