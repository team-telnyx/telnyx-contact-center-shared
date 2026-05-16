import { NextResponse } from "next/server";
import { getOutboundPool, mapCampaign, requireOutboundSupervisor } from "@/lib/outbound-dialer/api";
import { getRunnerState } from "@/lib/outbound-dialer/runner";

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

async function loadExecutionDebugByCampaign(pool, campaignIds = []) {
  const ids = Array.isArray(campaignIds) ? campaignIds.filter((id) => typeof id === "string" && id.trim()) : [];
  if (!ids.length) return {};

  const recentAttemptsResult = await pool.query(
    `WITH ranked AS (
      SELECT
        l.campaign_id,
        l.id,
        l.status,
        l.created_at,
        l.updated_at,
        l.metadata,
        ROW_NUMBER() OVER (PARTITION BY l.campaign_id ORDER BY l.created_at DESC, l.id DESC) AS rn
      FROM outbound_attempt_ledger l
      WHERE l.campaign_id = ANY($1::uuid[])
    )
    SELECT campaign_id, id, status, created_at, updated_at, metadata
    FROM ranked
    WHERE rn <= 8`,
    [ids],
  );

  const summaryResult = await pool.query(
    `SELECT
      l.campaign_id,
      COUNT(*) FILTER (WHERE l.created_at > NOW() - INTERVAL '15 minutes')::int AS attempts_last_15m,
      COUNT(*) FILTER (WHERE l.status = 'dialing')::int AS dialing_now,
      COUNT(*) FILTER (WHERE l.status IN ('claimed','dialing','answered'))::int AS active_now,
      COUNT(*) FILTER (WHERE l.status = 'answered')::int AS answered_total,
      COUNT(*) FILTER (WHERE l.status = 'failed')::int AS failed_total,
      COUNT(*) FILTER (WHERE l.status = 'completed')::int AS completed_total,
      COUNT(DISTINCT l.contact_record_id) FILTER (WHERE l.status = 'completed')::int AS completed_records,
      COUNT(*) FILTER (WHERE COALESCE(l.metadata->>'reason_code','') IN ('answering_machine','machine','machine_detected'))::int AS machine_total,
      COUNT(*) FILTER (WHERE COALESCE(l.metadata->>'reason_code','') IN ('no_answer','timeout'))::int AS no_answer_total,
      COUNT(*) FILTER (WHERE l.status IN ('cancelled','recycled'))::int AS hangups_total,
      COUNT(*) FILTER (WHERE l.status = 'suppressed')::int AS suppressed_total,
      COUNT(*) FILTER (WHERE l.status = 'skipped')::int AS skipped_total,
      COUNT(DISTINCT l.contact_record_id) FILTER (WHERE l.status IN ('completed','failed','cancelled','suppressed','skipped','recycled'))::int AS processed_records,
      COUNT(*) FILTER (WHERE l.status = 'answered' AND l.created_at > NOW() - INTERVAL '30 minutes')::int AS answered_last_30m,
      COUNT(*) FILTER (WHERE l.status = 'failed' AND l.created_at > NOW() - INTERVAL '30 minutes')::int AS failed_last_30m,
      COUNT(*) FILTER (WHERE l.status = 'suppressed' AND l.created_at > NOW() - INTERVAL '30 minutes')::int AS suppressed_last_30m,
      MAX(l.created_at) AS last_attempt_at
    FROM outbound_attempt_ledger l
    WHERE l.campaign_id = ANY($1::uuid[])
    GROUP BY l.campaign_id`,
    [ids],
  );

  const byCampaign = Object.fromEntries(ids.map((id) => [id, {
    runner: getRunnerState(id),
    summary: {
      attempts_last_15m: 0,
      dialing_now: 0,
      active_now: 0,
      answered_total: 0,
      failed_total: 0,
      completed_total: 0,
      completed_records: 0,
      machine_total: 0,
      no_answer_total: 0,
      hangups_total: 0,
      suppressed_total: 0,
      skipped_total: 0,
      processed_records: 0,
      answered_last_30m: 0,
      failed_last_30m: 0,
      suppressed_last_30m: 0,
      last_attempt_at: null,
    },
    recent_attempts: [],
  }]));

  for (const row of summaryResult.rows || []) {
    if (!byCampaign[row.campaign_id]) continue;
    byCampaign[row.campaign_id].summary = {
      attempts_last_15m: Number(row.attempts_last_15m || 0),
      dialing_now: Number(row.dialing_now || 0),
      active_now: Number(row.active_now || 0),
      answered_total: Number(row.answered_total || 0),
      failed_total: Number(row.failed_total || 0),
      completed_total: Number(row.completed_total || 0),
      completed_records: Number(row.completed_records || 0),
      machine_total: Number(row.machine_total || 0),
      no_answer_total: Number(row.no_answer_total || 0),
      hangups_total: Number(row.hangups_total || 0),
      suppressed_total: Number(row.suppressed_total || 0),
      skipped_total: Number(row.skipped_total || 0),
      processed_records: Number(row.processed_records || 0),
      answered_last_30m: Number(row.answered_last_30m || 0),
      failed_last_30m: Number(row.failed_last_30m || 0),
      suppressed_last_30m: Number(row.suppressed_last_30m || 0),
      last_attempt_at: row.last_attempt_at || null,
    };
  }

  for (const row of recentAttemptsResult.rows || []) {
    if (!byCampaign[row.campaign_id]) continue;
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    byCampaign[row.campaign_id].recent_attempts.push({
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      to_number: metadata.to_number || null,
      from_number: metadata.from_number || null,
      suppression_reason: metadata.suppression_reason || null,
      failure_reason: metadata.failure_reason || null,
      skip_reason: metadata.skip_reason || null,
      reason_code: metadata.reason_code || null,
    });
  }

  return byCampaign;
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
