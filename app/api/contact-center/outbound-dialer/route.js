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
    const params = new URLSearchParams();
    params.set("page[size]", "250");
    params.set("filter[status]", "active");
    const res = await fetch(`${buildTelnyxV2Url("/phone_numbers")}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.data)
      ? data.data
        .map((item) => ({
          id: item.id,
          phone_number: item.phone_number || null,
          status: item.status || null,
          connection_name: item.connection_name || null,
          country_code: item.country_code || null,
        }))
        .filter((item) => item.phone_number)
      : [];
  } catch (err) {
    console.warn("[Outbound Dialer] inventory numbers load failed:", err?.message || err);
    return [];
  }
}

async function loadExecutionDebugByCampaign(pool, campaignIds = []) {
  const ids = Array.isArray(campaignIds) ? campaignIds.filter((id) => typeof id === "string" && id.trim()) : [];
  if (!ids.length) return {};

  const recentAttempts = await safeQuery(
    pool,
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
    [],
  );

  const summaryRows = await safeQuery(
    pool,
    `SELECT
      l.campaign_id,
      COUNT(*) FILTER (WHERE l.created_at > NOW() - INTERVAL '15 minutes')::int AS attempts_last_15m,
      COUNT(*) FILTER (WHERE l.status = 'dialing')::int AS dialing_now,
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
      safeQuery(pool, `SELECT id, name, description FROM voice_flows ORDER BY updated_at DESC LIMIT 200`),
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
