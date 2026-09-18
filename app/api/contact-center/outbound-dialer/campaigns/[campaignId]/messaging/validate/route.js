import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, usernameFor } from "@/lib/outbound-dialer/api";
import { isOutboundMessagingChannel } from "@/lib/outbound-dialer/schema";
import { messagingChannelRequired } from "@/lib/outbound-dialer/messaging/api.mjs";
import { validateMessagingAudience } from "@/lib/outbound-dialer/messaging/audience.mjs";
import { loadOutboundSettingsRow, patchMessagingRuntime } from "@/lib/outbound-dialer/messaging/execution.mjs";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { campaignInScope } from "@/lib/authz/scope.mjs";

// Audience validation for a stored messaging campaign: counts what the runner
// would send, suppress or skip, and records the result on the campaign. The
// editor blocks it while the draft has unsaved changes.
async function POST_handler(request, context, authz) {
  const user = authz.user;
  const { campaignId } = await context.params;
  if (!campaignInScope(authz.scope, campaignId)) return jsonError("Campaign not found", 404);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const { rows } = await pool.query(`SELECT * FROM outbound_campaigns WHERE id = $1 AND status <> 'archived' LIMIT 1`, [campaignId]);
    const campaign = rows[0];
    if (!campaign) return jsonError("Campaign not found", 404);
    if (!isOutboundMessagingChannel(campaign.channel)) return jsonError(messagingChannelRequired(campaign), 400);
    if (!campaign.contact_list_id) return jsonError("Attach a contact list first", 400);
    const outboundSettings = await loadOutboundSettingsRow(pool);
    const result = await validateMessagingAudience(pool, { campaign, outboundSettings });
    await patchMessagingRuntime(pool, campaign.id, { last_validation: { at: result.generated_at, by: usernameFor(user), ok: result.ok, counts: result.counts, limited: result.limited } });
    return NextResponse.json({ ok: true, validation: result });
  } catch (err) {
    campaignsLogger.error("messaging_validate_failed", { campaignId, ...outboundErrorPayload(err) });
    return jsonError(err.message || "Audience validation failed", err.status || 400);
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("campaigns:read", POST_handler, { route: "/api/contact-center/outbound-dialer/campaigns/[campaignId]/messaging/validate" });
