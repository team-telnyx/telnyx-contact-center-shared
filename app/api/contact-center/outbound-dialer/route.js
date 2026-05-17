import { NextResponse } from "next/server";
import { getOutboundPool, loadOutboundContactLists, mapCampaign, mapContactList, mapDncList, mapForm, mapHandlerReference, mapOutboundAttemptControl, mapOutboundFilter, mapOutboundSettings, mapOutboundTimeSet, outboundSchemaPayload, requireOutboundSupervisor } from "@/lib/outbound-dialer/api";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { getRunnerState } from "@/lib/outbound-dialer/runner";

async function safeQuery(pool, sql, params = [], fallback = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return rows || fallback;
  } catch (err) {
    console.warn("[Outbound Dialer] optional query failed:", err?.message || err);
    return fallback;
  }
}

async function loadAiAssistants() {
  if (!process.env.TELNYX_API_KEY) return [];
  try {
    const res = await fetch(buildTelnyxV2Url("/ai/assistants"), {
      headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data.slice(0, 200).map((assistant) => mapHandlerReference({ id: assistant.id, name: assistant.name, status: assistant.status }, "ai_assistant")) : [];
  } catch (err) {
    console.warn("[Outbound Dialer] assistants load failed:", err?.message || err);
    return [];
  }
}

async function loadInventoryNumbers() {
  if (!process.env.TELNYX_API_KEY) return [];
  try {
    const pageSize = 250;
    const numbers = [];
    const seen = new Set();

    for (let page = 1; ; page += 1) {
      const params = new URLSearchParams();
      params.set("page[size]", String(pageSize));
      params.set("page[number]", String(page));
      params.set("filter[status]", "active");
      const res = await fetch(`${buildTelnyxV2Url("/phone_numbers")}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!res.ok) break;
      const data = await res.json();
      const rows = Array.isArray(data?.data) ? data.data : [];
      for (const item of rows) {
        if (!item?.phone_number || seen.has(item.phone_number)) continue;
        seen.add(item.phone_number);
        numbers.push({
          id: item.id,
          phone_number: item.phone_number || null,
          status: item.status || null,
          connection_name: item.connection_name || null,
          country_code: item.country_code || null,
        });
      }

      const currentPage = Number(data?.meta?.page_number || data?.meta?.page?.number || page);
      const totalPages = Number(data?.meta?.total_pages || data?.meta?.page?.total_pages || data?.meta?.page?.totalPages || 0);
      if (rows.length < pageSize || (totalPages && currentPage >= totalPages)) break;
    }

    return numbers;
  } catch (err) {
    console.warn("[Outbound Dialer] inventory numbers load failed:", err?.message || err);
    return [];
  }
}

export async function loadExecutionDebugByCampaign(pool, campaignIds = []) {
  const ids = Array.isArray(campaignIds) ? campaignIds.filter((id) => typeof id === "string" && id.trim()) : [];
  if (!ids.length) return {};

  const recentAttempts = await safeQuery(
    pool,
    `WITH ranked AS (
      SELECT
        l.campaign_id,
        l.id,
        l.contact_record_id,
        l.call_control_id,
        l.call_session_id,
        l.status,
        l.created_at,
        l.updated_at,
        l.metadata,
        l.failure_reason,
        ROW_NUMBER() OVER (PARTITION BY l.campaign_id ORDER BY l.created_at DESC, l.id DESC) AS rn
      FROM outbound_attempt_ledger l
      WHERE l.campaign_id = ANY($1::uuid[])
    )
    SELECT campaign_id, id, contact_record_id, call_control_id, call_session_id, status, created_at, updated_at, metadata, failure_reason
    FROM ranked
    WHERE rn <= 50
    ORDER BY campaign_id, created_at DESC, id DESC`,
    [ids],
    [],
  );

  const summaryRows = await safeQuery(
    pool,
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
    [],
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

  for (const row of summaryRows) {
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

  for (const row of recentAttempts) {
    if (!byCampaign[row.campaign_id]) continue;
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    byCampaign[row.campaign_id].recent_attempts.push({
      id: row.id,
      contact_record_id: row.contact_record_id || null,
      call_control_id: row.call_control_id || metadata.call_control_id || null,
      call_session_id: row.call_session_id || metadata.call_session_id || null,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      to_number: metadata.to_number || null,
      from_number: metadata.from_number || null,
      suppression_reason: metadata.suppression_reason || null,
      failure_reason: row.failure_reason || metadata.failure_reason || null,
      skip_reason: metadata.skip_reason || null,
      reason_code: metadata.reason_code || null,
    });
  }

  return byCampaign;
}

export async function GET() {
  const user = await requireOutboundSupervisor();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pool = getOutboundPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  try {
    const [campaignsResult, listsResult, dncListsResult, formsResult, filtersRows, timeSetsRows, attemptControlsRows, settingsRows, queueRows, flowRows, assistants, inventoryNumbers] = await Promise.all([
      pool.query(`SELECT c.*, l.name AS contact_list_name, f.name AS attached_form_name, ac.name AS attempt_control_name FROM outbound_campaigns c LEFT JOIN outbound_contact_lists l ON l.id = c.contact_list_id LEFT JOIN form_definitions f ON f.id = c.attached_form_id LEFT JOIN outbound_attempt_controls ac ON ac.id = c.attempt_control_id WHERE c.status <> 'archived' ORDER BY c.updated_at DESC LIMIT 100`),
      loadOutboundContactLists(pool, 100),
      pool.query(`SELECT * FROM outbound_dnc_lists WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 100`),
      pool.query(`SELECT id, name, status, category, schema FROM form_definitions WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 200`),
      safeQuery(pool, `SELECT f.*, l.name AS contact_list_name FROM outbound_contact_filters f LEFT JOIN outbound_contact_lists l ON l.id = f.contact_list_id WHERE f.status <> 'archived' ORDER BY f.updated_at DESC LIMIT 100`),
      safeQuery(pool, `SELECT * FROM outbound_time_sets WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 100`),
      safeQuery(pool, `SELECT * FROM outbound_attempt_controls WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 100`),
      safeQuery(pool, `SELECT * FROM outbound_settings WHERE id='default' LIMIT 1`),
      safeQuery(pool, `SELECT id, name, display_name, enabled, active FROM cc_queues WHERE enabled = true AND active = true ORDER BY priority DESC, name ASC LIMIT 200`),
      safeQuery(pool, `SELECT id, name, description FROM voice_flows WHERE jsonb_typeof(nodes) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(nodes) AS n WHERE n->'data'->>'nodeType' = 'outbound_campaign') ORDER BY updated_at DESC LIMIT 200`),
      loadAiAssistants(),
      loadInventoryNumbers(),
    ]);

    const campaigns = campaignsResult.rows.map(mapCampaign);
    const executionDebugByCampaign = await loadExecutionDebugByCampaign(pool, campaigns.map((c) => c.id));

    return NextResponse.json({
      ok: true,
      schema: outboundSchemaPayload,
      campaigns,
      contactLists: listsResult.rows.map(mapContactList),
      dncLists: dncListsResult.rows.map(mapDncList),
      forms: formsResult.rows.map(mapForm),
      filters: filtersRows.map(mapOutboundFilter),
      timeSets: timeSetsRows.map(mapOutboundTimeSet),
      attemptControls: attemptControlsRows.map(mapOutboundAttemptControl),
      settings: mapOutboundSettings(settingsRows[0]),
      handlerReferences: {
        queue: queueRows.map((row) => mapHandlerReference(row, "queue")),
        call_flow: flowRows.map((row) => mapHandlerReference(row, "call_flow")),
        ai_assistant: assistants,
      },
      inventoryNumbers,
      executionDebugByCampaign,
    });
  } catch (err) {
    console.error("[Outbound Dialer] GET error:", err);
    return NextResponse.json({ error: "Failed to load outbound dialer data" }, { status: 500 });
  }
}
