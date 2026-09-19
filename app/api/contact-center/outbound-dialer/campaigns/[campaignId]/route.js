import { campaignConfigurationError, configurationMetadata } from "@/lib/outbound-dialer/configuration-authorization.mjs";
import { NextResponse } from "next/server";
import { normalizeAmdConfig } from "@/lib/outbound-dialer/execution";
import { annotateCampaignDncScaffold, getOutboundPool, jsonError, mapCampaign, requireString, optionalString, ensureEnum, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { OUTBOUND_CAMPAIGN_MODES, OUTBOUND_CHANNELS, OUTBOUND_HANDLER_TYPES, isOutboundMessagingChannel } from "@/lib/outbound-dialer/schema";
import { assertMessagingCampaignSavable, normalizeMessagingMetadata } from "@/lib/outbound-dialer/messaging/api.mjs";
import { normalizeCampaignMaxAttempts, normalizeGlobalMaxAttempts } from "@/lib/outbound-dialer/attempt-limits";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { normalizedCampaignPacingConfig } from "@/lib/outbound-dialer/answered-without-agent-policy.mjs";
import { withPermission } from "@/lib/authz/guard";
import { campaignInScope } from "@/lib/authz/scope.mjs";
import { removeScopeIds } from "@/lib/authz/roles-store.mjs";

async function loadGlobalSettings(pool) {
  const { rows } = await pool.query(`SELECT settings FROM outbound_settings WHERE id='default' LIMIT 1`);
  return rows?.[0]?.settings || {};
}

function normalizeCampaignMetadata(value = {}, channel = "voice") {
  const metadata = normalizeMessagingMetadata(safeJson(value, {}), channel);
  const dialTimeout = metadata.dial_timeout_secs ?? metadata.dialTimeoutSecs;
  if (dialTimeout == null || dialTimeout === "") return metadata;
  const parsed = Number(dialTimeout);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const { dial_timeout_secs, dialTimeoutSecs, ...rest } = metadata;
    return rest;
  }
  return { ...metadata, dial_timeout_secs: Math.max(15, Math.min(600, Math.round(parsed))) };
}

const normalizeRetryPolicy = (value = {}, globalMaxAttempts) => {
  const policy = safeJson(value, {});
  const maxAttempts = normalizeCampaignMaxAttempts(policy?.maxAttempts, 4, globalMaxAttempts);
  return { ...policy, maxAttempts };
};

async function loadCampaignWithLookups(pool, campaignId) {
  const { rows } = await pool.query(
    `SELECT c.*, l.name AS contact_list_name, f.name AS attached_form_name, ac.name AS attempt_control_name
     FROM outbound_campaigns c
     LEFT JOIN outbound_contact_lists l ON l.id = c.contact_list_id
     LEFT JOIN form_definitions f ON f.id = c.attached_form_id
     LEFT JOIN outbound_attempt_controls ac ON ac.id = c.attempt_control_id
     WHERE c.id = $1 AND c.status <> 'archived'
     LIMIT 1`,
    [campaignId],
  );
  return rows[0] || null;
}

async function GET_handler(request, context, authz) {
  const user = authz.user;
  const { campaignId } = await context.params;
  if (!campaignInScope(authz.scope, campaignId)) return jsonError("Campaign not found", 404);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { searchParams } = new URL(request.url);
  const selectedDay = searchParams.get("day");

  try {
    const campaignResult = await pool.query(
      `SELECT c.*, l.name AS contact_list_name, f.name AS attached_form_name, ac.name AS attempt_control_name
       FROM outbound_campaigns c
       LEFT JOIN outbound_contact_lists l ON l.id = c.contact_list_id
       LEFT JOIN form_definitions f ON f.id = c.attached_form_id
       LEFT JOIN outbound_attempt_controls ac ON ac.id = c.attempt_control_id
       WHERE c.id = $1 AND c.status <> 'archived'
       LIMIT 1`,
      [campaignId],
    );

    const campaign = campaignResult.rows[0] || null;
    if (!campaign) return jsonError("Campaign not found", 404);

    const dayFilterSql = selectedDay ? ` AND DATE(updated_at) = $2::date` : "";
    const reasonBreakdownParams = selectedDay ? [campaignId, selectedDay] : [campaignId];
    const reasonCodeStatsResult = await pool.query(
      `SELECT
         COALESCE(NULLIF(metadata->>'reason_code', ''), 'unknown') AS reason_code,
         COUNT(*)::int AS count,
         COUNT(*) FILTER (WHERE COALESCE((metadata->>'retry_eligible')::boolean, false))::int AS retry_eligible_count
       FROM outbound_attempt_ledger
       WHERE campaign_id = $1
         AND status IN ('completed', 'failed', 'cancelled', 'suppressed', 'skipped')
         ${dayFilterSql}
       GROUP BY 1
       ORDER BY count DESC, reason_code ASC`,
      reasonBreakdownParams,
    );

    const totalsResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total_terminal_attempts,
         COUNT(*) FILTER (WHERE COALESCE((metadata->>'retry_eligible')::boolean, false))::int AS retry_eligible_attempts
       FROM outbound_attempt_ledger
       WHERE campaign_id = $1
         AND status IN ('completed', 'failed', 'cancelled', 'suppressed', 'skipped')
         ${dayFilterSql}`,
      reasonBreakdownParams,
    );

    const trendResult = await pool.query(
      `SELECT
         DATE(updated_at) AS day,
         COUNT(*)::int AS total_attempts,
         COUNT(*) FILTER (WHERE COALESCE((metadata->>'retry_eligible')::boolean, false))::int AS retry_eligible_attempts
       FROM outbound_attempt_ledger
       WHERE campaign_id = $1
         AND status IN ('completed', 'failed', 'cancelled', 'suppressed', 'skipped')
         AND updated_at >= CURRENT_DATE - INTERVAL '13 days'
       GROUP BY 1
       ORDER BY day DESC
       LIMIT 14`,
      [campaignId],
    );

    return NextResponse.json({
      ok: true,
      campaign: mapCampaign(campaign),
      reason_code_metrics: {
        totals: totalsResult.rows[0] || { total_terminal_attempts: 0, retry_eligible_attempts: 0 },
        breakdown: reasonCodeStatsResult.rows || [],
        trend: (trendResult.rows || []).reverse(),
        selected_day: selectedDay || null,
      },
    });
  } catch (err) {
    campaignsLogger.error("campaign_details_load_failed", { campaignId, ...outboundErrorPayload(err) });
    return jsonError(err.message || "Failed to load campaign", 400);
  }
}

async function PUT_handler(request, context, authz) {
  const user = authz.user;
  const { campaignId } = await context.params;
  if (!campaignInScope(authz.scope, campaignId)) return jsonError("Campaign not found", 404);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const username = usernameFor(user);
    const globalSettings = await loadGlobalSettings(pool);
    const globalMaxAttempts = normalizeGlobalMaxAttempts(globalSettings.global_max_attempts ?? globalSettings.globalMaxAttempts);
    const pacingConfig = normalizedCampaignPacingConfig(safeJson(body.pacing_config, {}), globalSettings);
    const name = requireString(body.name, "Campaign name");
    const status = ensureEnum(body.status, ["draft", "ready", "paused", "running", "stopped", "completed"], "draft");
    const current = (await pool.query("SELECT status FROM outbound_campaigns WHERE id=$1 AND status <> 'archived'", [campaignId])).rows[0];
    if (!current) return jsonError("Campaign not found", 404);
    const configurationError = campaignConfigurationError(status, current.status);
    if (configurationError) return jsonError(configurationError, 403);
    const channel = ensureEnum(body.channel, OUTBOUND_CHANNELS, "voice");
    const messaging = isOutboundMessagingChannel(channel);
    const mode = messaging ? "broadcast" : ensureEnum(body.mode, OUTBOUND_CAMPAIGN_MODES, "preview");
    const handlerType = messaging ? "queue" : ensureEnum(body.handler_type, OUTBOUND_HANDLER_TYPES, "queue");
    const normalizedMetadata = configurationMetadata(normalizeCampaignMetadata(body.metadata, channel));
    await assertMessagingCampaignSavable(pool, { name, status, channel, mode, contact_list_id: body.contact_list_id || null, metadata: normalizedMetadata }, globalSettings);
    const { rows } = await pool.query(`UPDATE outbound_campaigns SET name=$1, description=$2, status=$3, channel=$4, mode=$5, handler_type=$6, handler_ref=$7, contact_list_id=$8, attached_form_id=$9, pacing_config=$10, concurrency_config=$11, dialing_windows=$12, retry_policy=$13, amd_config=$14, form_variable_mapping=$15, metadata=$16::jsonb || (SELECT COALESCE(jsonb_object_agg(key,value), '{}'::jsonb) FROM jsonb_each(COALESCE(metadata, '{}'::jsonb)) WHERE key IN ('execution_control','execution_state','messaging_runtime','event_timeline')), attempt_control_id=$17, updated_by=$18, updated_at=NOW() WHERE id=$19 AND status=$20 RETURNING *`, [
      name, optionalString(body.description), status, channel, mode, handlerType, optionalString(body.handler_ref, 200), body.contact_list_id || null, body.attached_form_id || null, JSON.stringify(pacingConfig), JSON.stringify(safeJson(body.concurrency_config, {})), JSON.stringify(safeJson(body.dialing_windows, [])), JSON.stringify(normalizeRetryPolicy(body.retry_policy, globalMaxAttempts)), JSON.stringify(normalizeAmdConfig(safeJson(body.amd_config, {}))), JSON.stringify(safeJson(body.form_variable_mapping, [])), JSON.stringify(normalizedMetadata), body.attempt_control_id || null, username, campaignId, current.status,
    ]);
    if (!rows[0]) return jsonError("Campaign not found", 404);
    let campaign = rows[0];
    const metadata = campaign.metadata || {};
    const action = metadata.execution_control?.lastAction || metadata.execution_control?.last_action;
    if (campaign.status === "running" && metadata.dnc_list_id && ["start", "resume", "recycle"].includes(action)) {
      const checked = await annotateCampaignDncScaffold(pool, campaign, username);
      campaign = checked.campaign;
    }
    const campaignWithLookups = await loadCampaignWithLookups(pool, campaign.id);
    return NextResponse.json({ ok: true, campaign: mapCampaign(campaignWithLookups || campaign) });
  } catch (err) { campaignsLogger.error("campaign_update_failed", { campaignId, ...outboundErrorPayload(err) }); return jsonError(err.message || "Failed to update campaign", err.status || 400); }
}

async function DELETE_handler(request, context, authz) {
  const user = authz.user;
  const { campaignId } = await context.params;
  if (!campaignInScope(authz.scope, campaignId)) return jsonError("Campaign not found", 404);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`UPDATE outbound_campaigns SET status='archived', updated_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [usernameFor(user), campaignId]);
  if (!rows[0]) return jsonError("Campaign not found", 404);
  // An archived campaign leaves every role scope that named it (Phase 3a).
  await removeScopeIds(pool, "campaigns", [campaignId], { actor: user, reason: "campaign archived" });
  return NextResponse.json({ ok: true, campaign: mapCampaign(rows[0]) });
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("campaigns:read", GET_handler, { route: "/api/contact-center/outbound-dialer/campaigns/[campaignId]" });
export const PUT = withPermission("campaigns:update", PUT_handler, { route: "/api/contact-center/outbound-dialer/campaigns/[campaignId]" });
export const DELETE = withPermission("campaigns:delete", DELETE_handler, { route: "/api/contact-center/outbound-dialer/campaigns/[campaignId]" });
