import { NextResponse } from "next/server";
import { getOutboundPool, loadOutboundContactLists, mapContactList, mapCampaign } from "@/lib/outbound-dialer/api";
import { OUTBOUND_LIVE_CALLS_CHANGED_TOPIC } from "@/lib/outbound-dialer/live-calls-events.mjs";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { subscribe } from "@/lib/events/event-bus";
import { loadExecutionDebugByCampaign } from "../route";
import { withPermission } from "@/lib/authz/guard";
import { campaignScopeSql } from "@/lib/authz/scope.mjs";

export const maxDuration = 300;

async function loadCampaigns(pool, scope) {
  const vals = [];
  const scopeSql = campaignScopeSql(scope, "c.id::text", vals).map((c) => ` AND ${c}`).join("");
  const result = await pool.query(
    `SELECT c.*, l.name AS contact_list_name, f.name AS attached_form_name, ac.name AS attempt_control_name
     FROM outbound_campaigns c
     LEFT JOIN outbound_contact_lists l ON l.id = c.contact_list_id
     LEFT JOIN form_definitions f ON f.id = c.attached_form_id
     LEFT JOIN outbound_attempt_controls ac ON ac.id = c.attempt_control_id
     WHERE c.status <> 'archived'${scopeSql}
     ORDER BY c.updated_at DESC
     LIMIT 100`,
    vals,
  );
  return result.rows.map(mapCampaign);
}

async function GET_handler(request, _context, authz) {
  const user = authz.user;

  const pool = getOutboundPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let timer = null;
      let unsubscribe = null;
      let pushing = false;
      let pendingPush = false;

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
        unsubscribe?.();
        unsubscribe = null;
        try {
          controller.close();
        } catch {
          // ignore
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
              const [campaigns, lists] = await Promise.all([loadCampaigns(pool, authz.scope), authz.can("contact_lists:read") ? loadOutboundContactLists(pool, 100) : Promise.resolve({ rows: [] })]);
              const executionDebugByCampaign = await loadExecutionDebugByCampaign(pool, campaigns.map((c) => c.id));
              send(
                {
                  type: "outbound_update",
                  timestamp: new Date().toISOString(),
                  campaigns,
                  contactLists: lists.rows.map(mapContactList),
                  executionDebugByCampaign,
                },
                "outbound_update",
              );
            } catch (err) {
              send({ type: "error", message: err?.message || "stream update failed" }, "error");
            }
          } while (pendingPush && !closed);
        } finally {
          pushing = false;
        }
      };

      send({ type: "connected", timestamp: new Date().toISOString() }, "connected");
      pushUpdate();
      timer = setInterval(pushUpdate, 3000);
      subscribe(OUTBOUND_LIVE_CALLS_CHANGED_TOPIC, pushUpdate)
        .then((stop) => {
          if (closed) stop();
          else unsubscribe = stop;
        })
        .catch((error) => {
          campaignsLogger.warn("campaign_monitor_event_subscription_failed", { ...outboundErrorPayload(error) });
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
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("campaigns:read", GET_handler, { route: "/api/contact-center/outbound-dialer/stream" });
