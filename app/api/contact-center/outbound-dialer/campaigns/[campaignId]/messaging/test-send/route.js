import { NextResponse } from "next/server";
import { getOutboundPool, jsonError } from "@/lib/outbound-dialer/api";
import { isOutboundMessagingChannel } from "@/lib/outbound-dialer/schema";
import { messagingChannelRequired } from "@/lib/outbound-dialer/messaging/api.mjs";
import { loadSampleContact } from "@/lib/outbound-dialer/messaging/audience.mjs";
import { sendMessagingTest } from "@/lib/outbound-dialer/messaging/execution.mjs";
import { messagingProvider } from "@/lib/outbound-dialer/messaging/provider.mjs";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { campaignInScope } from "@/lib/authz/scope.mjs";

// Send the rendered campaign message to one address now. Recorded on the
// ledger as a test send that never touches the audience. It runs against the
// stored campaign, so the editor blocks it while the draft has unsaved changes.
async function POST_handler(request, context, authz) {
  const user = authz.user;
  const { campaignId } = await context.params;
  if (!campaignInScope(authz.scope, campaignId)) return jsonError("Campaign not found", 404);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json().catch(() => ({}));
    const { rows } = await pool.query(`SELECT * FROM outbound_campaigns WHERE id = $1 AND status <> 'archived' LIMIT 1`, [campaignId]);
    const campaign = rows[0];
    if (!campaign) return jsonError("Campaign not found", 404);
    if (!isOutboundMessagingChannel(campaign.channel)) return jsonError(messagingChannelRequired(campaign), 400);
    const contact = body.contact_record_id ? await loadSampleContact(pool, { contactListId: campaign.contact_list_id, contactRecordId: body.contact_record_id }) : await loadSampleContact(pool, { contactListId: campaign.contact_list_id, offset: body.sample_index || 0 });
    const result = await sendMessagingTest(pool, messagingProvider(), { campaign, to: String(body.to || ""), contact });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    campaignsLogger.error("messaging_test_send_failed", { campaignId, ...outboundErrorPayload(err) });
    return jsonError(err.message || "Test message failed", err.status || 400);
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("campaigns:execute", POST_handler, { route: "/api/contact-center/outbound-dialer/campaigns/[campaignId]/messaging/test-send" });
