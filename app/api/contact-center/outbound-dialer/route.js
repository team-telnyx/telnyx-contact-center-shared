import { NextResponse } from "next/server";
import { getOutboundPool, loadOutboundContactLists, mapCampaign, mapContactList, mapDncList, mapForm, mapHandlerReference, mapOutboundAttemptControl, mapOutboundFilter, mapOutboundSettings, mapOutboundTimeSet, outboundSchemaPayload, requireOutboundSupervisor } from "@/lib/outbound-dialer/api";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { getRunnerState } from "@/lib/outbound-dialer/runner";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";

async function safeQuery(pool, sql, params = [], fallback = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return rows || fallback;
  } catch (err) {
    campaignsLogger.warn("optional_query_failed", { ...outboundErrorPayload(err) });
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
    campaignsLogger.warn("assistants_load_failed", { ...outboundErrorPayload(err) });
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
      if (!res.ok) {
        throw new Error(`Telnyx inventory page ${page} failed with ${res.status}`);
      }
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
    campaignsLogger.warn("inventory_numbers_load_failed", { ...outboundErrorPayload(err) });
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
        r.row_data AS contact_row_data,
        r.contact_methods AS contact_methods,
        ROW_NUMBER() OVER (PARTITION BY l.campaign_id ORDER BY l.created_at DESC, l.id DESC) AS rn
      FROM outbound_attempt_ledger l
      LEFT JOIN outbound_contact_records r ON r.id = l.contact_record_id
      WHERE l.campaign_id = ANY($1::uuid[])
    )
    SELECT campaign_id, id, contact_record_id, call_control_id, call_session_id, status, created_at, updated_at, metadata, failure_reason, contact_row_data, contact_methods
    FROM ranked
    WHERE rn <= 500
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
      COUNT(*) FILTER (
        WHERE l.status IN ('dialing','answered')
           OR (
             l.status = 'claimed'
             AND COALESCE(l.lease_expires_at, NOW() + INTERVAL '1 second') > NOW() - INTERVAL '5 seconds'
           )
      )::int AS active_now,
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

  const contactRecords = await safeQuery(
    pool,
    `WITH campaign_lists AS (
      SELECT id AS campaign_id, contact_list_id
      FROM outbound_campaigns
      WHERE id = ANY($1::uuid[]) AND contact_list_id IS NOT NULL
    ), ranked AS (
      SELECT
        cl.campaign_id,
        r.id AS contact_record_id,
        r.row_data,
        r.contact_methods,
        r.validation_status,
        r.last_attempt_at,
        COUNT(l.id)::int AS attempt_count,
        COALESCE(jsonb_object_agg(l.status, status_counts.count ORDER BY l.status) FILTER (WHERE l.status IS NOT NULL), '{}'::jsonb) AS status_counts,
        ROW_NUMBER() OVER (PARTITION BY cl.campaign_id ORDER BY COALESCE(r.last_attempt_at, r.created_at) DESC, r.id DESC) AS rn
      FROM campaign_lists cl
      JOIN outbound_contact_records r ON r.contact_list_id = cl.contact_list_id
      LEFT JOIN outbound_attempt_ledger l ON l.campaign_id = cl.campaign_id AND l.contact_record_id = r.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS count
        FROM outbound_attempt_ledger ls
        WHERE ls.campaign_id = cl.campaign_id AND ls.contact_record_id = r.id AND ls.status = l.status
      ) status_counts ON TRUE
      GROUP BY cl.campaign_id, r.id, r.row_data, r.contact_methods, r.validation_status, r.last_attempt_at, r.created_at
    )
    SELECT campaign_id, contact_record_id, row_data, contact_methods, validation_status, last_attempt_at, attempt_count, status_counts
    FROM ranked
    WHERE rn <= 200
    ORDER BY campaign_id, COALESCE(last_attempt_at, NOW() - INTERVAL '100 years') DESC, contact_record_id`,
    [ids],
    [],
  );

  const campaignRuns = await safeQuery(
    pool,
    `WITH ranked AS (
      SELECT
        r.campaign_id,
        r.id,
        r.status,
        r.started_by,
        r.stopped_by,
        r.stop_reason,
        r.metadata,
        r.started_at,
        r.stopped_at,
        r.created_at,
        r.updated_at,
        ROW_NUMBER() OVER (PARTITION BY r.campaign_id ORDER BY COALESCE(r.stopped_at, r.started_at, r.updated_at, r.created_at) DESC, r.id DESC) AS rn
      FROM outbound_campaign_runs r
      WHERE r.campaign_id = ANY($1::uuid[])
    )
    SELECT campaign_id, id, status, started_by, stopped_by, stop_reason, metadata, started_at, stopped_at, created_at, updated_at
    FROM ranked
    WHERE rn <= 100
    ORDER BY campaign_id, COALESCE(stopped_at, started_at, updated_at, created_at) DESC, id DESC`,
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
    contact_records: [],
    campaign_runs: [],
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

  for (const row of contactRecords) {
    if (!byCampaign[row.campaign_id]) continue;
    byCampaign[row.campaign_id].contact_records.push({
      contact_record_id: row.contact_record_id || null,
      row_data: row.row_data && typeof row.row_data === "object" ? row.row_data : {},
      contact_methods: row.contact_methods && typeof row.contact_methods === "object" ? row.contact_methods : {},
      validation_status: row.validation_status || null,
      last_attempt_at: row.last_attempt_at || null,
      attempt_count: Number(row.attempt_count || 0),
      status_counts: row.status_counts && typeof row.status_counts === "object" ? row.status_counts : {},
    });
  }

  for (const row of campaignRuns) {
    if (!byCampaign[row.campaign_id]) continue;
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    byCampaign[row.campaign_id].campaign_runs.push({
      id: row.id,
      status: row.status,
      started_by: row.started_by || null,
      stopped_by: row.stopped_by || null,
      stop_reason: row.stop_reason || null,
      metadata,
      started_at: row.started_at || null,
      stopped_at: row.stopped_at || null,
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
    });
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
      contact_row_data: row.contact_row_data && typeof row.contact_row_data === "object" ? row.contact_row_data : {},
      contact_methods: row.contact_methods && typeof row.contact_methods === "object" ? row.contact_methods : {},
      suppression_reason: metadata.suppression_reason || null,
      failure_reason: row.failure_reason || metadata.failure_reason || null,
      skip_reason: metadata.skip_reason || null,
      reason_code: metadata.reason_code || null,
      retry_eligible: metadata.retry_eligible ?? metadata.retryEligible ?? false,
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
    const [campaignsResult, listsResult, dncListsResult, formsResult, filtersRows, timeSetsRows, attemptControlsRows, settingsRows, queueRows, flowRows, workflowRows, assistants, inventoryNumbers] = await Promise.all([
      pool.query(`SELECT c.*, l.name AS contact_list_name, f.name AS attached_form_name, ac.name AS attempt_control_name FROM outbound_campaigns c LEFT JOIN outbound_contact_lists l ON l.id = c.contact_list_id LEFT JOIN form_definitions f ON f.id = c.attached_form_id LEFT JOIN outbound_attempt_controls ac ON ac.id = c.attempt_control_id WHERE c.status <> 'archived' ORDER BY c.updated_at DESC LIMIT 100`),
      loadOutboundContactLists(pool, 100),
      pool.query(`SELECT * FROM outbound_dnc_lists WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 100`),
      pool.query(`SELECT id, name, status, category, schema FROM form_definitions WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 200`),
      safeQuery(pool, `SELECT f.*, l.name AS contact_list_name FROM outbound_contact_filters f LEFT JOIN outbound_contact_lists l ON l.id = f.contact_list_id WHERE f.status <> 'archived' ORDER BY f.updated_at DESC LIMIT 100`),
      safeQuery(pool, `SELECT * FROM outbound_time_sets WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 100`),
      safeQuery(pool, `SELECT * FROM outbound_attempt_controls WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 100`),
      safeQuery(pool, `SELECT * FROM outbound_settings WHERE id='default' LIMIT 1`),
      safeQuery(pool, `SELECT id, name, display_name, enabled, active, routing_strategy FROM cc_queues WHERE enabled = true AND active = true ORDER BY priority DESC, name ASC LIMIT 200`),
      safeQuery(pool, `SELECT id, name, description FROM voice_flows WHERE jsonb_typeof(nodes) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(nodes) AS n WHERE n->'data'->>'nodeType' = 'outbound_campaign') ORDER BY updated_at DESC LIMIT 200`),
      safeQuery(pool, `SELECT id, name, description FROM aa_workflows WHERE is_active = true ORDER BY updated_at DESC NULLS LAST, name ASC LIMIT 200`),
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
        workflow: workflowRows.map((row) => mapHandlerReference(row, "workflow")),
        ai_assistant: assistants,
      },
      inventoryNumbers,
      executionDebugByCampaign,
    });
  } catch (err) {
    campaignsLogger.error("outbound_overview_load_failed", { ...outboundErrorPayload(err) });
    return NextResponse.json({ error: "Failed to load outbound dialer data" }, { status: 500 });
  }
}
