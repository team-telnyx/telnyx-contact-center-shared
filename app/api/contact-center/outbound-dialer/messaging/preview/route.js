import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, safeJson } from "@/lib/outbound-dialer/api";
import { isOutboundMessagingChannel } from "@/lib/outbound-dialer/schema";
import { normalizeMessagingCampaignConfig } from "@/lib/outbound-dialer/messaging/campaign-config.mjs";
import { countContacts, loadSampleContact, previewMessagingMessage } from "@/lib/outbound-dialer/messaging/audience.mjs";
import { loadOutboundSettingsRow } from "@/lib/outbound-dialer/messaging/execution.mjs";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { withPermission } from "@/lib/authz/guard";

// Render the campaign draft for one sample contact. The draft does not have to
// be saved: the editor posts its current state.
async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const draft = safeJson(body.campaign, {});
    const channel = String(draft.channel || body.channel || "sms").toLowerCase();
    if (!isOutboundMessagingChannel(channel)) return jsonError("Unsupported messaging channel", 400);
    const campaign = { ...draft, channel, metadata: { ...(safeJson(draft.metadata, {})), messaging: normalizeMessagingCampaignConfig(safeJson(draft.metadata, {}).messaging || body.messaging || {}) } };
    const contactListId = draft.contact_list_id || body.contact_list_id || null;
    const contact = await loadSampleContact(pool, { contactListId, contactRecordId: body.contact_record_id || null, offset: body.sample_index || 0 });
    const outboundSettings = await loadOutboundSettingsRow(pool);
    let senderAddress = null;
    const senderIds = campaign.metadata.messaging.sender?.sms?.number_ids || [];
    if (channel === "sms" && senderIds.length) {
      const { rows } = await pool.query(`SELECT phone_number FROM cc_sms_numbers WHERE id = ANY($1::uuid[]) ORDER BY phone_number LIMIT 1`, [senderIds]);
      senderAddress = rows[0]?.phone_number || null;
    }
    const preview = await previewMessagingMessage(pool, { campaign, contact, outboundSettings, senderAddress });
    return NextResponse.json({ ok: true, preview, sample: { index: Number(body.sample_index || 0), total: await countContacts(pool, contactListId), contact_record_id: contact?.id || null } });
  } catch (err) {
    campaignsLogger.error("messaging_preview_failed", { ...outboundErrorPayload(err) });
    return jsonError(err.message || "Failed to render preview", err.status || 400);
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("campaigns:read", POST_handler, { route: "/api/contact-center/outbound-dialer/messaging/preview" });
