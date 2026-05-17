import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapCampaign, requireOutboundSupervisor, requireString, optionalString, ensureEnum, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { OUTBOUND_CAMPAIGN_MODES, OUTBOUND_CHANNELS, OUTBOUND_HANDLER_TYPES } from "@/lib/outbound-dialer/schema";
import { normalizeCampaignMaxAttempts, normalizeGlobalMaxAttempts } from "@/lib/outbound-dialer/attempt-limits";
import { normalizeOutboundDialTimeoutSecs } from "@/lib/outbound-dialer/execution";

async function loadGlobalMaxAttempts(pool) {
  const { rows } = await pool.query(`SELECT settings FROM outbound_settings WHERE id='default' LIMIT 1`);
  const settings = rows?.[0]?.settings || {};
  return normalizeGlobalMaxAttempts(settings.global_max_attempts ?? settings.globalMaxAttempts);
}

async function loadGlobalDialTimeoutSecs(pool) {
  const { rows } = await pool.query(`SELECT settings FROM outbound_settings WHERE id='default' LIMIT 1`);
  const settings = rows?.[0]?.settings || {};
  return normalizeOutboundDialTimeoutSecs(settings.dial_timeout_secs ?? settings.dialTimeoutSecs, 30);
}

function normalizeCampaignMetadata(value = {}, globalDialTimeoutSecs = 30) {
  const metadata = safeJson(value, {});
  return {
    ...metadata,
    dial_timeout_secs: normalizeOutboundDialTimeoutSecs(metadata.dial_timeout_secs ?? metadata.dialTimeoutSecs, globalDialTimeoutSecs),
  };
}

const normalizeRetryPolicy = (value = {}, globalMaxAttempts) => {
  const policy = safeJson(value, { maxAttempts: 4, minDelayHours: 6, exhaustAfterDays: 7 });
  const maxAttempts = normalizeCampaignMaxAttempts(policy?.maxAttempts, 4, globalMaxAttempts);
  return { ...policy, maxAttempts };
};

export async function GET() {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`SELECT c.*, l.name AS contact_list_name, f.name AS attached_form_name, ac.name AS attempt_control_name FROM outbound_campaigns c LEFT JOIN outbound_contact_lists l ON l.id = c.contact_list_id LEFT JOIN form_definitions f ON f.id = c.attached_form_id LEFT JOIN outbound_attempt_controls ac ON ac.id = c.attempt_control_id WHERE c.status <> 'archived' ORDER BY c.updated_at DESC LIMIT 200`);
  return NextResponse.json({ ok: true, campaigns: rows.map(mapCampaign) });
}

export async function POST(request) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const name = requireString(body.name, "Campaign name");
    const username = usernameFor(user);
    const globalMaxAttempts = await loadGlobalMaxAttempts(pool);
    const globalDialTimeoutSecs = await loadGlobalDialTimeoutSecs(pool);
    const { rows } = await pool.query(`INSERT INTO outbound_campaigns (name, description, status, channel, mode, handler_type, handler_ref, contact_list_id, attached_form_id, pacing_config, concurrency_config, dialing_windows, retry_policy, amd_config, form_variable_mapping, metadata, attempt_control_id, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18) RETURNING *`, [
      name, optionalString(body.description), ensureEnum(body.status, ["draft", "ready", "paused", "running", "stopped", "completed"], "draft"), ensureEnum(body.channel, OUTBOUND_CHANNELS, "voice"), ensureEnum(body.mode, OUTBOUND_CAMPAIGN_MODES, "preview"), ensureEnum(body.handler_type, OUTBOUND_HANDLER_TYPES, "queue"), optionalString(body.handler_ref, 200), body.contact_list_id || null, body.attached_form_id || null,
      JSON.stringify(safeJson(body.pacing_config, { strategy: "per_available_agent", ratio: 1, supervisorApproval: true })), JSON.stringify(safeJson(body.concurrency_config, { maxConcurrent: 10, perAgentLimit: 1 })), JSON.stringify(safeJson(body.dialing_windows, [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00", timezonePolicy: "contact" }])), JSON.stringify(normalizeRetryPolicy(body.retry_policy, globalMaxAttempts)), JSON.stringify(safeJson(body.amd_config, { enabled: true, humanConfidenceThreshold: 0.74, voicemailAction: "hangup" })), JSON.stringify(safeJson(body.form_variable_mapping, [])), JSON.stringify(normalizeCampaignMetadata(body.metadata, globalDialTimeoutSecs)), body.attempt_control_id || null, username,
    ]);
    return NextResponse.json({ ok: true, campaign: mapCampaign(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] create campaign error:", err); return jsonError(err.message || "Failed to create campaign", 400); }
}
