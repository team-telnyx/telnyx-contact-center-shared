import { campaignConfigurationError, configurationMetadata } from "@/lib/outbound-dialer/configuration-authorization.mjs";
import { NextResponse } from "next/server";
import { normalizeAmdConfig } from "@/lib/outbound-dialer/execution";
import { getOutboundPool, jsonError, mapCampaign, requireString, optionalString, ensureEnum, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { OUTBOUND_CAMPAIGN_MODES, OUTBOUND_CHANNELS, OUTBOUND_HANDLER_TYPES, isOutboundMessagingChannel } from "@/lib/outbound-dialer/schema";
import { assertMessagingCampaignSavable, normalizeMessagingMetadata } from "@/lib/outbound-dialer/messaging/api.mjs";
import { normalizeCampaignMaxAttempts, normalizeGlobalMaxAttempts } from "@/lib/outbound-dialer/attempt-limits";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { normalizedCampaignPacingConfig } from "@/lib/outbound-dialer/answered-without-agent-policy.mjs";
import { withPermission } from "@/lib/authz/guard";
import { campaignScopeSql } from "@/lib/authz/scope.mjs";

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
  const policy = safeJson(value, { maxAttempts: 4, minDelayHours: 6, exhaustAfterDays: 7 });
  const maxAttempts = normalizeCampaignMaxAttempts(policy?.maxAttempts, 4, globalMaxAttempts);
  return { ...policy, maxAttempts };
};

async function GET_handler(_request, _context, authz) {
  const user = authz.user;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  // Campaign scope of the granting roles (Phase 3a); campaign ids are UUIDs, the scope carries text.
  const vals = [];
  const scopeSql = campaignScopeSql(authz.scope, "c.id::text", vals).map((c) => ` AND ${c}`).join("");
  const { rows } = await pool.query(`SELECT c.*, l.name AS contact_list_name, f.name AS attached_form_name, ac.name AS attempt_control_name FROM outbound_campaigns c LEFT JOIN outbound_contact_lists l ON l.id = c.contact_list_id LEFT JOIN form_definitions f ON f.id = c.attached_form_id LEFT JOIN outbound_attempt_controls ac ON ac.id = c.attempt_control_id WHERE c.status <> 'archived'${scopeSql} ORDER BY c.updated_at DESC LIMIT 200`, vals);
  return NextResponse.json({ ok: true, campaigns: rows.map(mapCampaign) });
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const name = requireString(body.name, "Campaign name");
    const username = usernameFor(user);
    const globalSettings = await loadGlobalSettings(pool);
    const globalMaxAttempts = normalizeGlobalMaxAttempts(globalSettings.global_max_attempts ?? globalSettings.globalMaxAttempts);
    const pacingConfig = normalizedCampaignPacingConfig(
      safeJson(body.pacing_config, { strategy: "per_available_agent", ratio: 1, supervisorApproval: true }),
      globalSettings,
    );
    const status = ensureEnum(body.status, ["draft", "ready", "paused", "running", "stopped", "completed"], "draft");
    const configurationError = campaignConfigurationError(status);
    if (configurationError) return jsonError(configurationError, 403);
    const channel = ensureEnum(body.channel, OUTBOUND_CHANNELS, "voice");
    const messaging = isOutboundMessagingChannel(channel);
    const mode = messaging ? "broadcast" : ensureEnum(body.mode, OUTBOUND_CAMPAIGN_MODES, "preview");
    const handlerType = messaging ? "queue" : ensureEnum(body.handler_type, OUTBOUND_HANDLER_TYPES, "queue");
    const metadata = configurationMetadata(normalizeCampaignMetadata(body.metadata, channel));
    await assertMessagingCampaignSavable(pool, { name, status, channel, mode, contact_list_id: body.contact_list_id || null, metadata }, globalSettings);
    const { rows } = await pool.query(`INSERT INTO outbound_campaigns (name, description, status, channel, mode, handler_type, handler_ref, contact_list_id, attached_form_id, pacing_config, concurrency_config, dialing_windows, retry_policy, amd_config, form_variable_mapping, metadata, attempt_control_id, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18) RETURNING *`, [
      name, optionalString(body.description), status, channel, mode, handlerType, optionalString(body.handler_ref, 200), body.contact_list_id || null, body.attached_form_id || null,
      JSON.stringify(pacingConfig), JSON.stringify(safeJson(body.concurrency_config, { maxConcurrent: 10, perAgentLimit: 1 })), JSON.stringify(safeJson(body.dialing_windows, [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00", timezonePolicy: "contact" }])), JSON.stringify(normalizeRetryPolicy(body.retry_policy, globalMaxAttempts)), JSON.stringify(normalizeAmdConfig(safeJson(body.amd_config, { enabled: true, humanConfidenceThreshold: 0.74, voicemailAction: "hangup" }))), JSON.stringify(safeJson(body.form_variable_mapping, [])), JSON.stringify(metadata), body.attempt_control_id || null, username,
    ]);
    return NextResponse.json({ ok: true, campaign: mapCampaign(rows[0]) });
  } catch (err) { campaignsLogger.error("campaign_create_failed", { ...outboundErrorPayload(err) }); return jsonError(err.message || "Failed to create campaign", err.status || 400); }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("campaigns:read", GET_handler, { route: "/api/contact-center/outbound-dialer/campaigns" });
export const POST = withPermission("campaigns:create", POST_handler, { route: "/api/contact-center/outbound-dialer/campaigns" });
