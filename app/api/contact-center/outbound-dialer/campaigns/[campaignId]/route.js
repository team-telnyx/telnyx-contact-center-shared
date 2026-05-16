import { NextResponse } from "next/server";
import { annotateCampaignDncScaffold, getOutboundPool, jsonError, mapCampaign, requireOutboundSupervisor, requireString, optionalString, ensureEnum, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { OUTBOUND_CAMPAIGN_MODES, OUTBOUND_CHANNELS, OUTBOUND_HANDLER_TYPES } from "@/lib/outbound-dialer/schema";

export async function GET(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { campaignId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);

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

    const reasonCodeStatsResult = await pool.query(
      `SELECT
         COALESCE(NULLIF(metadata->>'reason_code', ''), 'unknown') AS reason_code,
         COUNT(*)::int AS count,
         COUNT(*) FILTER (WHERE COALESCE((metadata->>'retry_eligible')::boolean, false))::int AS retry_eligible_count
       FROM outbound_attempt_ledger
       WHERE campaign_id = $1
         AND status IN ('completed', 'failed', 'cancelled', 'suppressed', 'skipped')
       GROUP BY 1
       ORDER BY count DESC, reason_code ASC`,
      [campaignId],
    );

    const totalsResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total_terminal_attempts,
         COUNT(*) FILTER (WHERE COALESCE((metadata->>'retry_eligible')::boolean, false))::int AS retry_eligible_attempts
       FROM outbound_attempt_ledger
       WHERE campaign_id = $1
         AND status IN ('completed', 'failed', 'cancelled', 'suppressed', 'skipped')`,
      [campaignId],
    );

    return NextResponse.json({
      ok: true,
      campaign: mapCampaign(campaign),
      reason_code_metrics: {
        totals: totalsResult.rows[0] || { total_terminal_attempts: 0, retry_eligible_attempts: 0 },
        breakdown: reasonCodeStatsResult.rows || [],
      },
    });
  } catch (err) {
    console.error("[Outbound Dialer] get campaign details error:", err);
    return jsonError(err.message || "Failed to load campaign", 400);
  }
}

export async function PUT(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { campaignId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const username = usernameFor(user);
    const { rows } = await pool.query(`UPDATE outbound_campaigns SET name=$1, description=$2, status=$3, channel=$4, mode=$5, handler_type=$6, handler_ref=$7, contact_list_id=$8, attached_form_id=$9, pacing_config=$10, concurrency_config=$11, dialing_windows=$12, retry_policy=$13, amd_config=$14, form_variable_mapping=$15, metadata=$16, attempt_control_id=$17, updated_by=$18, updated_at=NOW() WHERE id=$19 AND status <> 'archived' RETURNING *`, [
      requireString(body.name, "Campaign name"), optionalString(body.description), ensureEnum(body.status, ["draft", "ready", "paused", "running", "completed"], "draft"), ensureEnum(body.channel, OUTBOUND_CHANNELS, "voice"), ensureEnum(body.mode, OUTBOUND_CAMPAIGN_MODES, "preview"), ensureEnum(body.handler_type, OUTBOUND_HANDLER_TYPES, "queue"), optionalString(body.handler_ref, 200), body.contact_list_id || null, body.attached_form_id || null, JSON.stringify(safeJson(body.pacing_config, {})), JSON.stringify(safeJson(body.concurrency_config, {})), JSON.stringify(safeJson(body.dialing_windows, [])), JSON.stringify(safeJson(body.retry_policy, {})), JSON.stringify(safeJson(body.amd_config, {})), JSON.stringify(safeJson(body.form_variable_mapping, [])), JSON.stringify(safeJson(body.metadata, {})), body.attempt_control_id || null, username, campaignId,
    ]);
    if (!rows[0]) return jsonError("Campaign not found", 404);
    let campaign = rows[0];
    const metadata = campaign.metadata || {};
    const action = metadata.execution_control?.lastAction || metadata.execution_control?.last_action;
    if (campaign.status === "running" && metadata.dnc_list_id && ["start", "resume", "recycle"].includes(action)) {
      const checked = await annotateCampaignDncScaffold(pool, campaign, username);
      campaign = checked.campaign;
    }
    return NextResponse.json({ ok: true, campaign: mapCampaign(campaign) });
  } catch (err) { console.error("[Outbound Dialer] update campaign error:", err); return jsonError(err.message || "Failed to update campaign", 400); }
}

export async function DELETE(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { campaignId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`UPDATE outbound_campaigns SET status='archived', updated_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [usernameFor(user), campaignId]);
  if (!rows[0]) return jsonError("Campaign not found", 404);
  return NextResponse.json({ ok: true, campaign: mapCampaign(rows[0]) });
}
