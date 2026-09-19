// Broadcast runner for messaging campaigns. The attempt ledger is the send
// journal: claim → prepare (gates + render) → send (provider) → delivery
// evidence. No ACD saga, work item or acd_messages row is created per message;
// replies reach queues through the inbound rules of the sending number.
import { createHash, randomUUID } from "node:crypto";
import { closeCampaignRun, startCampaignRun } from "../execution.js";
import { loadCampaignMaxAttempts } from "../completion.js";
import { notifyOutboundLiveCallsChanged } from "../live-calls-events.mjs";
import { executionLogger, outboundErrorPayload } from "../logging.mjs";
import { MESSAGE_LIVE_STATES, MESSAGE_STATE_LEDGER_STATUS } from "./schema.mjs";
import { effectiveMessagingPacing, messagingCampaignConfig } from "./campaign-config.mjs";
import { messagingSettingsFrom } from "./settings.mjs";
import { resolveMessagingDestination } from "./destination.mjs";
import { buildWhatsAppOutbound } from "../../whatsapp/policy.mjs";
import { checkMessagingSuppression, passesMessagingWindow } from "./suppression.mjs";
import { loadMessagingTemplate, renderMessagingMessage } from "./templates.mjs";
import { resolveVariableValues, systemVariableValues } from "./variables.mjs";
import { computeMessagingBudget, loadMessagingCounts, senderCapacity } from "./pacing.mjs";
import { classifyMessagingOutcome, deliveryAdvances, deliveryStateFor } from "./outcomes.mjs";
import { OUTBOUND_MESSAGING_CHANNELS, OUTBOUND_MESSAGING_MODES } from "../schema.js";

export const MESSAGING_RUNTIME_LOCK = Object.freeze([741901, 6]);
const CLAIM_LEASE = "5 minutes";
const SEND_LEASE = "2 minutes";
const DELIVERY_SYNC_ATTEMPTS = 5;
// A contact is done once one message reached the provider or failed for good.
const DONE_STATES = ["accepted", "sent", "delivered", "read", "replied", "unconfirmed", "failed_permanent", "undeliverable"];

const parse = (value, fallback = {}) => {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
const iso = (date = new Date()) => date.toISOString();
const minutesFromNow = (minutes) => iso(new Date(Date.now() + Math.max(1, Number(minutes) || 1) * 60_000));

// Installations (and test databases) without the outbound dialer tables must
// keep the SMS adapter working: every hook called from ingest checks first.
export async function messagingLedgerAvailable(db) {
  const { rows } = await db.query(`SELECT to_regclass('public.outbound_attempt_ledger') AS ledger, to_regclass('public.outbound_settings') AS settings`);
  return Boolean(rows[0]?.ledger && rows[0]?.settings);
}

export async function loadOutboundSettingsRow(db) {
  const { rows } = await db.query(`SELECT settings FROM outbound_settings WHERE id='default' LIMIT 1`);
  return rows?.[0]?.settings || {};
}

export async function loadMessagingCampaigns(db) {
  const { rows } = await db.query(
    `SELECT c.*, active_run.id AS active_run_id
     FROM outbound_campaigns c
     LEFT JOIN LATERAL (SELECT r.id FROM outbound_campaign_runs r WHERE r.campaign_id = c.id AND r.status = 'running' ORDER BY r.started_at DESC, r.id DESC LIMIT 1) active_run ON true
     WHERE c.status = 'running' AND c.channel = ANY($1::text[]) AND c.mode = ANY($2::text[])
     ORDER BY COALESCE(NULLIF(btrim(c.metadata->>'agent_priority'), '')::int, 3) DESC, c.updated_at ASC, c.id`,
    [OUTBOUND_MESSAGING_CHANNELS, OUTBOUND_MESSAGING_MODES],
  );
  return rows;
}

// Merge runtime facts into campaign.metadata.messaging_runtime without touching
// the rest of the metadata document.
export async function patchMessagingRuntime(db, campaignId, patch = {}) {
  await db.query(
    `UPDATE outbound_campaigns
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('messaging_runtime', COALESCE(metadata->'messaging_runtime', '{}'::jsonb) || $2::jsonb), updated_at = NOW()
     WHERE id = $1`,
    [campaignId, JSON.stringify(patch)],
  );
}

async function appendCampaignTimeline(db, campaignId, event) {
  await db.query(
    `UPDATE outbound_campaigns
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('event_timeline',
       (jsonb_build_array($2::jsonb) || COALESCE(metadata->'event_timeline', '[]'::jsonb))
     )
     WHERE id = $1`,
    [campaignId, JSON.stringify({ at: iso(), ...event })],
  );
  await db.query(
    `UPDATE outbound_campaigns SET metadata = jsonb_set(metadata, '{event_timeline}', (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM (SELECT e FROM jsonb_array_elements(metadata->'event_timeline') WITH ORDINALITY AS t(e, n) WHERE n <= 50) s)) WHERE id = $1`,
    [campaignId],
  );
}

export async function pauseMessagingCampaign(db, campaign, reason, detail = null) {
  const now = iso();
  const { rows } = await db.query(
    `UPDATE outbound_campaigns
     SET status = 'paused',
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_by = 'system', updated_at = NOW()
     WHERE id = $1 AND status = 'running'
     RETURNING *`,
    [campaign.id, JSON.stringify({
      execution_state: "paused",
      execution_control: { lastAction: "pause", last_action: "pause", updatedAt: now, updated_at: now, updatedBy: "system", updated_by: "system", reason },
      messaging_runtime: { ...(parse(campaign.metadata, {}).messaging_runtime || {}), auto_paused_reason: reason, auto_paused_detail: detail, auto_paused_at: now },
    })],
  );
  if (!rows[0]) return null;
  await closeCampaignRun(db, campaign.id, "paused", "system", `auto_pause:${reason}`, { action: "pause", auto_paused: true, reason, detail });
  await appendCampaignTimeline(db, campaign.id, { type: "pause", annotation: `Campaign paused automatically: ${reason}${detail ? ` (${detail})` : ""}` });
  executionLogger.warn("messaging_campaign_auto_paused", { campaignId: campaign.id, reason, detail });
  return rows[0];
}

/**
 * How many attempts one contact may receive in a messaging campaign: the
 * tighter of the campaign retry policy and `messaging.attempts` from
 * Dialer → Settings, so the messaging limit is never silently wider.
 */
export async function messagingMaxAttempts(db, campaign, settings = null) {
  const { maxAttemptsPerContact } = await loadCampaignMaxAttempts(db, campaign);
  const messagingSettings = settings || messagingSettingsFrom(await loadOutboundSettingsRow(db));
  const messagingLimit = Number(messagingSettings?.attempts?.max_attempts_per_contact) || 0;
  return messagingLimit > 0 ? Math.min(maxAttemptsPerContact, messagingLimit) : maxAttemptsPerContact;
}

export async function countRemainingMessagingRecords(db, campaign, { settings = null } = {}) {
  if (!campaign?.contact_list_id) return 0;
  const maxAttemptsPerContact = await messagingMaxAttempts(db, campaign, settings);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS remaining
     FROM outbound_contact_records r
     WHERE r.contact_list_id = $1 AND r.validation_status = 'valid'
       AND (SELECT COUNT(*) FROM outbound_attempt_ledger la WHERE la.campaign_id = $2 AND la.contact_record_id = r.id AND la.status IN ('claimed','dialing','answered','completed','failed')) < $3
       AND NOT EXISTS (SELECT 1 FROM outbound_attempt_ledger d WHERE d.campaign_id = $2 AND d.contact_record_id = r.id AND d.message_state = ANY($4::text[]))
       AND NOT EXISTS (SELECT 1 FROM outbound_attempt_ledger lr WHERE lr.campaign_id = $2 AND lr.contact_record_id = r.id
         AND ((lr.status = 'suppressed' AND NOT lr.metadata ? 'recycled_at') OR (NULLIF(lr.metadata->>'next_retry_at', '') IS NOT NULL AND (lr.metadata->>'next_retry_at')::timestamptz > NOW())))`,
    [campaign.contact_list_id, campaign.id, maxAttemptsPerContact, DONE_STATES],
  );
  return Number(rows?.[0]?.remaining || 0);
}

// Claim up to `limit` contacts as pending messages in one statement.
export async function claimMessagingBatch(db, campaign, runId, limit, { attemptReason = "messaging_broadcast", settings = null } = {}) {
  if (!campaign?.contact_list_id || !campaign?.id || !(limit > 0)) return [];
  const maxAttemptsPerContact = await messagingMaxAttempts(db, campaign, settings);
  const { rows } = await db.query(
    `WITH candidate AS (
      SELECT r.id
      FROM outbound_contact_records r
      WHERE r.contact_list_id = $1 AND r.validation_status = 'valid'
        AND (SELECT COUNT(*) FROM outbound_attempt_ledger la WHERE la.campaign_id = $2 AND la.contact_record_id = r.id AND la.status IN ('claimed','dialing','answered','completed','failed')) < $5
        AND NOT EXISTS (SELECT 1 FROM outbound_attempt_ledger l WHERE l.campaign_id = $2 AND l.contact_record_id = r.id AND l.status IN ('claimed','dialing','answered','completed') AND COALESCE(l.lease_expires_at, NOW() + INTERVAL '1 second') > NOW() - INTERVAL '5 seconds')
        AND NOT EXISTS (SELECT 1 FROM outbound_attempt_ledger d WHERE d.campaign_id = $2 AND d.contact_record_id = r.id AND d.message_state = ANY($9::text[]))
        AND NOT EXISTS (SELECT 1 FROM outbound_attempt_ledger lr WHERE lr.campaign_id = $2 AND lr.contact_record_id = r.id
          AND ((lr.status = 'suppressed' AND NOT lr.metadata ? 'recycled_at') OR (NULLIF(lr.metadata->>'next_retry_at', '') IS NOT NULL AND (lr.metadata->>'next_retry_at')::timestamptz > NOW())))
      ORDER BY COALESCE((SELECT max(o.created_at) FROM outbound_attempt_ledger o WHERE o.campaign_id = $2 AND o.contact_record_id = r.id), 'epoch'::timestamptz) ASC, r.created_at ASC, r.id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $6
    )
    INSERT INTO outbound_attempt_ledger (campaign_id, run_id, contact_record_id, status, channel, handler_type, handler_ref, claim_key, lease_expires_at, attempt_reason, message_state, metadata)
    SELECT $2, $3, candidate.id, 'claimed', $4, 'queue', NULL, $7, NOW() + INTERVAL '${CLAIM_LEASE}', $8, 'pending', jsonb_build_object('max_attempts_per_contact', $5)
    FROM candidate
    RETURNING *`,
    [campaign.contact_list_id, campaign.id, runId, campaign.channel, maxAttemptsPerContact, limit, randomUUID(), attemptReason, DONE_STATES],
  );
  if (rows.length) await db.query(`UPDATE outbound_contact_records SET last_attempt_at = NOW(), updated_at = NOW() WHERE id = ANY($1::uuid[])`, [rows.map((row) => row.contact_record_id)]);
  return rows;
}

async function setMessageState(db, ledgerId, state, { metadata = {}, failureReason = null, extra = {} } = {}) {
  const status = MESSAGE_STATE_LEDGER_STATUS[state] || "claimed";
  const { rows } = await db.query(
    `UPDATE outbound_attempt_ledger
     SET message_state = $2, status = $3,
         failure_reason = COALESCE($4, failure_reason),
         to_address = COALESCE($5, to_address), sender_address = COALESCE($6, sender_address), provider_message_id = COALESCE($7, provider_message_id),
         lease_expires_at = CASE WHEN $2 = ANY($8::text[]) THEN COALESCE($9::timestamptz, lease_expires_at) ELSE NULL END,
         delivery_sync_at = CASE WHEN $10::boolean THEN $11::timestamptz ELSE delivery_sync_at END,
         metadata = COALESCE(metadata, '{}'::jsonb) || $12::jsonb,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [ledgerId, state, status, failureReason, extra.toAddress || null, extra.senderAddress || null, extra.providerMessageId || null,
      MESSAGE_LIVE_STATES, extra.leaseExpiresAt || null, extra.deliverySyncAt !== undefined, extra.deliverySyncAt || null,
      JSON.stringify(metadata)],
  );
  return rows[0] || null;
}

function senderFor({ senders, strategy, address, attemptIndex, batchIndex, pacing, counts, usedInBatch }) {
  if (!senders.length) return null;
  const capacityOf = (sender) => senderCapacity(pacing, counts.per_sender?.[sender.address]) - (usedInBatch.get(sender.address) || 0);
  const ordered = [...senders];
  let start = 0;
  // "Same number for the same customer": the recipient's address maps to a fixed
  // position in the sender list, so their conversation stays on one of our
  // numbers. The hash distributes, it does not protect anything — but SHA-256
  // costs nothing here and keeps a deprecated primitive out of the codebase.
  // Note the mapping is inherently tied to senders.length: adding or removing a
  // number from a campaign reshuffles every recipient regardless of algorithm.
  if (strategy === "sticky_hash") start = Number.parseInt(createHash("sha256").update(String(address || "")).digest("hex").slice(0, 8), 16) % senders.length;
  else if (strategy === "rotate_on_retry") start = (Number(attemptIndex) || 0) % senders.length;
  else start = ((Number(counts.campaign_total) || 0) + (Number(batchIndex) || 0)) % senders.length;
  for (let offset = 0; offset < ordered.length; offset += 1) {
    const sender = ordered[(start + offset) % ordered.length];
    if (capacityOf(sender) > 0) return sender;
  }
  return null;
}

// Senders the campaign may use on its channel: the configured resources that
// still allow sending, intersected with the workspace allowlist. One WhatsApp
// number or one mailbox sends a campaign; SMS may rotate across numbers.
export async function loadMessagingSenders(db, campaign, config, settings) {
  if (campaign.channel === "sms") {
    const ids = config.sender.sms.number_ids;
    if (!ids.length) return [];
    const allowlist = settings.senders?.sms_numbers || [];
    const { rows } = await db.query(`SELECT id, phone_number, sending_enabled, routing_enabled, queue_id FROM cc_sms_numbers WHERE id = ANY($1::uuid[]) AND sending_enabled ORDER BY phone_number`, [ids]);
    return rows.filter((row) => !allowlist.length || allowlist.includes(row.id) || allowlist.includes(row.phone_number)).map((row) => ({ id: row.id, address: row.phone_number, routing_enabled: row.routing_enabled }));
  }
  if (campaign.channel === "whatsapp") {
    const id = config.sender.whatsapp.number_id;
    if (!id) return [];
    const allowlist = settings.senders?.whatsapp_numbers || [];
    const { rows } = await db.query(`SELECT id, phone_number, phone_number_id, waba_id, messaging_profile_id, sending_enabled, routing_enabled FROM cc_whatsapp_numbers WHERE id = $1::uuid AND sending_enabled`, [id]);
    return rows.filter((row) => !allowlist.length || allowlist.includes(row.id) || allowlist.includes(row.phone_number))
      .map((row) => ({ id: row.id, address: row.phone_number, routing_enabled: row.routing_enabled, messaging_profile_id: row.messaging_profile_id, waba_id: row.waba_id }));
  }
  if (campaign.channel === "email") {
    const id = config.sender.email.mailbox_id;
    if (!id) return [];
    const allowlist = settings.senders?.email_mailboxes || [];
    const { rows } = await db.query(`SELECT id, address, name, sending_enabled, routing_enabled FROM cc_email_mailboxes WHERE id = $1::uuid AND sending_enabled`, [id]);
    return rows.filter((row) => !allowlist.length || allowlist.includes(row.id) || allowlist.includes(row.address))
      .map((row) => ({ id: row.id, address: row.address, routing_enabled: row.routing_enabled, name: row.name }));
  }
  return [];
}

function buildProviderCommand(campaign, ledger, sender, rendered, webhookUrl, config = {}, settings = {}) {
  if (campaign.channel === "sms") {
    const request = { from: sender.address, to: ledger.to_address, text: rendered.text, type: "SMS" };
    if (webhookUrl) request.webhook_url = webhookUrl; else request.use_profile_webhooks = true;
    return { operation: "sms_send", endpoint: "/messages", request, commandId: ledger.id };
  }
  if (campaign.channel === "whatsapp") {
    // A campaign message is business-initiated, so it is always an approved
    // template and the 24-hour customer service window never applies.
    const request = buildWhatsAppOutbound({ from: sender.address, to: ledger.to_address, message: rendered.message, webhookUrl, messagingProfileId: sender.messaging_profile_id });
    return { operation: "whatsapp_send", endpoint: "/messages/whatsapp", request, commandId: ledger.id };
  }
  if (campaign.channel === "email") {
    // The campaign wins, then the workspace default from Dialer → Settings,
    // then the mailbox itself. The settings values are shown as placeholders in
    // the campaign editor, so they have to apply when the field is left empty.
    const fromName = config.sender?.email?.from_name || settings.email?.default_from_name || sender.name || "";
    const replyTo = config.sender?.email?.reply_to || settings.email?.default_reply_to || "";
    const request = {
      from: fromName ? `${fromName} <${sender.address}>` : sender.address,
      to: [ledger.to_address], subject: rendered.subject, text_body: rendered.text,
      ...(rendered.html ? { html_body: rendered.html } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(rendered.headers && Object.keys(rendered.headers).length ? { headers: rendered.headers } : {}),
      ...(rendered.unsubscribe_group_id ? { unsubscribe_group_id: rendered.unsubscribe_group_id } : {}),
    };
    return { operation: "email_send", endpoint: "/email_messages", request, commandId: ledger.id };
  }
  return null;
}

// Gates, destination and rendering for one claimed row. Returns the queued row
// or the terminal outcome that was recorded.
export async function prepareMessagingAttempt(db, { campaign, config, settings, outboundSettings, template, ledger, contact, senders, pacing, counts, usedInBatch, batchIndex = 0, webhookUrl = null }) {
  const channel = campaign.channel;
  const terminal = async (state, reason, extraMetadata = {}) => ({ ok: false, state, reason, ledger: await setMessageState(db, ledger.id, state, { failureReason: reason, metadata: { reason_code: reason, suppression_reason: ["suppressed"].includes(MESSAGE_STATE_LEDGER_STATUS[state]) ? reason : undefined, skip_reason: MESSAGE_STATE_LEDGER_STATUS[state] === "skipped" ? reason : undefined, ...extraMetadata } }) });
  if (!contact) return terminal("failed_permanent", "contact_not_found");
  const destination = resolveMessagingDestination({ channel, destinationFields: config.destination_fields, rowData: contact.row_data, contactMethods: contact.contact_methods });
  if (!destination.address) return terminal("suppressed", "missing_destination");
  await db.query(`UPDATE outbound_attempt_ledger SET to_address = $2, metadata = metadata || $3::jsonb WHERE id = $1`, [ledger.id, destination.address, JSON.stringify({ to_number: destination.address, destination_field: destination.field })]);
  const suppression = await checkMessagingSuppression(db, { channel, address: destination.address, contactRecord: contact, campaign, config, settings, senderNumberIds: senders.map((sender) => sender.id) });
  if (suppression.suppressed) return terminal("suppressed", suppression.reason);
  if (!(await passesMessagingWindow(db, { campaign, outboundSettings, messagingSettings: settings }))) {
    return terminal("skipped", "outside_time_set", { next_retry_at: minutesFromNow(15), retry_eligible: true });
  }
  const prior = await db.query(`SELECT COUNT(*)::int AS n FROM outbound_attempt_ledger WHERE campaign_id = $1 AND contact_record_id = $2 AND id <> $3`, [campaign.id, contact.id, ledger.id]);
  const strategy = channel === "sms" ? config.sender.sms.strategy : "round_robin";
  const sender = senderFor({ senders, strategy, address: destination.address, attemptIndex: Number(prior.rows[0]?.n || 0), batchIndex, pacing, counts, usedInBatch });
  if (!sender) {
    if (!senders.length) return { ok: false, state: "failed_permanent", reason: "missing_sender", campaignBlocked: "missing_sender", ledger: await setMessageState(db, ledger.id, "failed_permanent", { failureReason: "missing_sender", metadata: { reason_code: "missing_sender" } }) };
    return terminal("throttled", "sender_capacity", { next_retry_at: minutesFromNow(1) });
  }
  const system = systemVariableValues({ campaign, senderAddress: sender.address, optOutInstructions: channel === "sms" ? settings.sms?.opt_out_footer_text : "", timezone: parse(outboundSettings, {}).callable_window?.timezone });
  const resolved = resolveVariableValues(config.variable_mapping, { rowData: parse(contact.row_data, {}), contactMethods: parse(contact.contact_methods, {}), system });
  const policy = config.missing_variable_policy;
  if (resolved.missing.length && policy === "skip") return terminal("suppressed", "missing_variables", { missing_variables: resolved.missing });
  const rendered = renderMessagingMessage({ channel, template, values: resolved.values, settings, config, blankMissing: true });
  if (!rendered.ok) return terminal("suppressed", rendered.reason || "render_failed", { missing_variables: rendered.missing });
  if (rendered.missing.length && policy !== "send_blank") return terminal("suppressed", "missing_variables", { missing_variables: rendered.missing });
  const command = buildProviderCommand(campaign, { ...ledger, to_address: destination.address }, sender, rendered, webhookUrl, config, settings);
  if (!command) return terminal("failed_permanent", `channel_${channel}_not_available`);
  usedInBatch.set(sender.address, (usedInBatch.get(sender.address) || 0) + 1);
  const queued = await setMessageState(db, ledger.id, "queued", {
    extra: { toAddress: destination.address, senderAddress: sender.address, leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
    metadata: {
      from_number: sender.address, sender_number_id: sender.id, template_id: template.id, template_name: template.name,
      rendered: { text: rendered.text, subject: rendered.subject || undefined, encoding: rendered.segments?.encoding, parts: rendered.segments?.parts, footer: rendered.footer },
      variables_used: resolved.values, missing_variables: rendered.missing, payload: command.request,
    },
  });
  return { ok: true, ledger: queued, command, sender, rendered };
}

// Hand one queued message to the provider. The CAS to `sending` makes the
// ledger row the journal entry; a crash before the outcome lands leaves the row
// in `sending` with an expiring lease and the sweeper marks it unconfirmed.
export async function sendMessagingAttempt(db, provider, { campaign, ledger, command, settings }) {
  const claimed = await db.query(
    `UPDATE outbound_attempt_ledger SET message_state = 'sending', lease_expires_at = NOW() + INTERVAL '${SEND_LEASE}', metadata = metadata || $2::jsonb, updated_at = NOW()
     WHERE id = $1 AND message_state = 'queued' RETURNING *`,
    [ledger.id, JSON.stringify({ send_started_at: iso(), dial_started_at: iso() })],
  );
  if (!claimed.rows[0]) return { ok: false, reason: "not_queued" };
  const started = Date.now();
  let result;
  try { result = await provider.send(command); }
  catch (error) { result = { outcome: "ambiguous", httpStatus: null, response: { error: String(error?.message || error).slice(0, 500) } }; }
  const latency = Date.now() - started;
  if (result?.outcome === "accepted") {
    const data = result.response?.data || {};
    const row = await setMessageState(db, ledger.id, "accepted", {
      extra: { providerMessageId: data.id ? String(data.id) : null, deliverySyncAt: new Date(Date.now() + 2 * 60_000).toISOString() },
      metadata: { accepted_at: iso(), provider_latency_ms: latency, provider_response: { id: data.id || null, encoding: data.encoding || null, parts: Number.isInteger(data.parts) ? data.parts : null, direction: data.direction || null } },
    });
    await notifyOutboundLiveCallsChanged(db, { campaignId: campaign.id, attemptId: ledger.id, channel: campaign.channel }).catch(() => {});
    return { ok: true, state: "accepted", ledger: row };
  }
  const classified = classifyMessagingOutcome(campaign.channel, { outcome: result?.outcome || "failed", httpStatus: result?.httpStatus ?? null, code: result?.response?.code ?? null, sent: false }, settings);
  const metadata = {
    reason_code: classified.reason_code, provider_code: classified.provider_code, provider_error: result?.response?.error || null, provider_http_status: result?.httpStatus ?? null,
    retry_eligible: Boolean(classified.retry_eligible), provider_latency_ms: latency,
    ...(classified.retry_minutes ? { next_retry_at: minutesFromNow(classified.retry_minutes) } : {}),
  };
  const row = await setMessageState(db, ledger.id, classified.state, { failureReason: classified.reason_code, metadata });
  await notifyOutboundLiveCallsChanged(db, { campaignId: campaign.id, attemptId: ledger.id, channel: campaign.channel }).catch(() => {});
  return { ok: false, state: classified.state, classified, ledger: row };
}

/**
 * An approved WhatsApp template belongs to one WhatsApp Business Account. With
 * more than one account connected the catalogue is shared, so a template can be
 * paired with a number from another account; Meta then rejects every message.
 * Returns the mismatch description, or null when the pairing is usable.
 */
export function whatsappWabaMismatch(channel, template, senders = []) {
  if (channel !== "whatsapp") return null;
  const templateWaba = String(template?.waba_id || "").trim();
  if (!templateWaba) return null;
  const offending = senders.filter((sender) => String(sender.waba_id || "").trim() && String(sender.waba_id).trim() !== templateWaba);
  if (!offending.length) return null;
  return `Template ${template?.name || template?.id} belongs to WhatsApp Business Account ${templateWaba}, ${offending.map((sender) => sender.address).join(", ")} does not`;
}

// Delivery evidence (webhooks or reconciliation) for a campaign message.
export async function applyMessagingDeliveryUpdate(pool, { channel, providerMessageId, status, occurredAt = null, errorCode = null, errorDetail = null, source = "webhook" }) {
  if (!providerMessageId || !status) return "noop";
  if (!(await messagingLedgerAvailable(pool))) return "unmatched";
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const ledger = (await db.query(`SELECT l.*, c.metadata AS campaign_metadata FROM outbound_attempt_ledger l JOIN outbound_campaigns c ON c.id = l.campaign_id WHERE l.channel = $1 AND l.provider_message_id = $2 FOR UPDATE OF l`, [channel, String(providerMessageId)])).rows[0];
    if (!ledger) { await db.query("COMMIT"); return "unmatched"; }
    const settings = messagingSettingsFrom(await loadOutboundSettingsRow(db));
    const next = deliveryStateFor(channel, { status, code: errorCode }, settings);
    if (!next || !deliveryAdvances(ledger.message_state, next.state)) { await db.query("COMMIT"); return "noop"; }
    const terminal = !MESSAGE_LIVE_STATES.includes(next.state);
    const metadata = {
      delivery: { status, occurred_at: occurredAt || iso(), error_code: errorCode, error_detail: errorDetail, source },
      ...(next.reason_code ? { reason_code: next.reason_code, provider_code: errorCode } : {}),
      ...(next.retry_minutes ? { next_retry_at: minutesFromNow(next.retry_minutes), retry_eligible: true } : {}),
      ...(["delivered", "read"].includes(next.state) ? { delivered_at: occurredAt || iso() } : {}),
    };
    await setMessageState(db, ledger.id, next.state, { failureReason: next.reason_code || null, metadata, extra: { deliverySyncAt: terminal ? null : ledger.delivery_sync_at } });
    await db.query("COMMIT");
    await notifyOutboundLiveCallsChanged(pool, { campaignId: ledger.campaign_id, attemptId: ledger.id, channel }).catch(() => {});
    return "applied";
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

/**
 * A customer message from an address that recently received a campaign message
 * marks that one message as replied. Only the newest qualifying message is
 * attributed, and only one sent from the number or mailbox that received the
 * reply, so a second campaign to the same contact keeps its own counters.
 * Routing itself is unchanged.
 */
export async function markMessagingReplied(db, { channel, address, receivedBy = null, hours = null }) {
  // The ledger stores e-mail addresses lower-cased; inbound headers are not.
  const key = (value) => (channel === "email" ? String(value || "").trim().toLowerCase() : String(value || "").trim());
  const to = key(address);
  if (!to) return 0;
  if (!(await messagingLedgerAvailable(db))) return 0;
  const settings = messagingSettingsFrom(await loadOutboundSettingsRow(db));
  const window = Number(hours) || settings.reply.attribution_hours;
  const sender = key(receivedBy) || null;
  const { rows } = await db.query(
    `UPDATE outbound_attempt_ledger SET message_state = 'replied', status = 'completed', delivery_sync_at = NULL, lease_expires_at = NULL,
         metadata = metadata || jsonb_build_object('replied_at', NOW()::text, 'reason_code', 'replied'), updated_at = NOW()
     WHERE id = (
       SELECT id FROM outbound_attempt_ledger
       WHERE channel = $1 AND to_address = $2 AND message_state IN ('accepted','sent','delivered','read')
         AND created_at > NOW() - ($3::text || ' hours')::interval
         AND ($4::text IS NULL OR sender_address IS NULL OR sender_address = $4)
       ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, campaign_id`,
    [channel, to, String(window), sender],
  );
  if (rows.length) await notifyOutboundLiveCallsChanged(db, { campaignId: rows[0].campaign_id, channel, replied: rows.length }).catch(() => {});
  return rows.length;
}

/**
 * One delivery poll, normalized across channels. SMS and WhatsApp report the
 * recipient on the message resource; e-mail keeps recipients on their own
 * sub-resource, so it needs its own call rather than being left out of the
 * queue with its attempts ticking down. Returns null while nothing is known.
 */
export async function pollMessagingDelivery(channel, request, providerMessageId) {
  const id = encodeURIComponent(String(providerMessageId));
  if (channel === "email") {
    const result = await request(`/email_messages/${id}/recipients?page_size=100`);
    const recipients = Array.isArray(result?.data) ? result.data : [];
    const recipient = recipients.find((entry) => entry?.status && entry.status !== "queued") || null;
    if (!recipient) return null;
    const code = recipient.error_evidence?.code || recipient.smtp_code || null;
    return {
      status: recipient.status,
      occurredAt: recipient.updated_at || recipient[`${recipient.status}_at`] || recipient.failed_at || null,
      errorCode: code ? String(code) : null,
      errorDetail: recipient.error_evidence?.message || recipient.smtp_response || null,
    };
  }
  const result = await request(`/messages/${id}`);
  const data = result?.data;
  const recipient = Array.isArray(data?.to) ? data.to[0] : null;
  if (!data?.id || !recipient?.status || recipient.status === "queued") return null;
  const error = Array.isArray(data.errors) && data.errors[0] ? data.errors[0] : null;
  return {
    status: recipient.status,
    occurredAt: data.completed_at || data.sent_at || null,
    errorCode: error?.code ? String(error.code) : null,
    errorDetail: error?.detail || error?.title || null,
  };
}

// Recover missed delivery webhooks from the provider message resource.
export async function syncMessagingDeliveries(pool, { requests = {} } = {}) {
  const db = await pool.connect();
  let ledger;
  let exhausted = false;
  try {
    await db.query("BEGIN");
    ledger = (await db.query(`SELECT * FROM outbound_attempt_ledger WHERE delivery_sync_at IS NOT NULL AND delivery_sync_at <= NOW() AND provider_message_id IS NOT NULL
      ORDER BY delivery_sync_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (!ledger) { await db.query("COMMIT"); return false; }
    // The attempt is only spent once its poll has run, so the last attempt still
    // gets to ask the provider before the message is written off.
    exhausted = ledger.delivery_sync_attempts + 1 >= DELIVERY_SYNC_ATTEMPTS;
    await db.query(`UPDATE outbound_attempt_ledger SET delivery_sync_attempts = delivery_sync_attempts + 1, delivery_sync_at = CASE WHEN $2 THEN NULL ELSE NOW() + INTERVAL '2 minutes' END WHERE id = $1`, [ledger.id, exhausted]);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
  const request = requests[ledger.channel];
  // A channel with no reconciliation adapter must not burn attempts or be
  // written off: its delivery evidence would then arrive by webhook only, and a
  // message could be marked unconfirmed without a single query being made.
  if (!request) {
    await pool.query(`UPDATE outbound_attempt_ledger SET delivery_sync_attempts = GREATEST(delivery_sync_attempts - 1, 0), delivery_sync_at = NULL WHERE id = $1`, [ledger.id]);
    return true;
  }
  try {
    const evidence = await pollMessagingDelivery(ledger.channel, request, ledger.provider_message_id);
    if (!evidence) return true;
    await applyMessagingDeliveryUpdate(pool, { channel: ledger.channel, providerMessageId: String(ledger.provider_message_id), ...evidence, source: "message-sync" });
    return true;
  } catch (error) {
    executionLogger.warn("messaging_delivery_sync_failed", { attemptId: ledger.id, ...outboundErrorPayload(error) });
  } finally {
    // Written off only after the final poll returned nothing conclusive.
    if (exhausted) {
      const current = (await pool.query(`SELECT message_state FROM outbound_attempt_ledger WHERE id = $1`, [ledger.id])).rows[0];
      if (current && MESSAGE_LIVE_STATES.includes(current.message_state)) {
        await setMessageState(pool, ledger.id, "unconfirmed", { metadata: { reason_code: "delivery_unconfirmed", delivery_sync_exhausted_at: iso() } });
      }
    }
  }
  return true;
}

/**
 * Return rows that were claimed but never handed to the provider. They are
 * cancelled rather than left pending, so the pacing windows stop counting them
 * and the contacts become claimable again on the next run.
 */
export async function releaseClaimedMessages(db, claimed, reason) {
  const ids = (claimed || []).map((row) => row.id).filter(Boolean);
  if (!ids.length) return 0;
  const { rows } = await db.query(
    `UPDATE outbound_attempt_ledger SET message_state = 'cancelled', status = 'cancelled', lease_expires_at = NULL,
       metadata = metadata || jsonb_build_object('reason_code', $2::text), updated_at = NOW()
     WHERE id = ANY($1::uuid[]) AND message_state IN ('pending','rendered','queued')
     RETURNING id`,
    [ids, String(reason || "batch_released")],
  );
  return rows.length;
}

// Rows stuck in `sending` past their lease lost their provider outcome.
export async function sweepStalledMessagingSends(db) {
  const { rows } = await db.query(
    `UPDATE outbound_attempt_ledger SET message_state = 'unconfirmed', status = 'completed', lease_expires_at = NULL,
       metadata = metadata || jsonb_build_object('reason_code', 'provider_uncertain', 'send_lease_expired_at', NOW()::text), updated_at = NOW()
     WHERE message_state = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()
     RETURNING id`,
  );
  const stale = await db.query(
    `UPDATE outbound_attempt_ledger SET message_state = 'cancelled', status = 'cancelled', lease_expires_at = NULL,
       metadata = metadata || jsonb_build_object('reason_code', 'claim_lease_expired'), updated_at = NOW()
     WHERE message_state IN ('pending','rendered','queued') AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()
     RETURNING id`,
  );
  return { unconfirmed: rows.length, cancelled: stale.rows.length };
}

async function failureRateBreaker(db, campaign, settings) {
  const safety = settings.safety;
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE message_state IN ('failed_permanent','undeliverable','failed_transient','throttled','unconfirmed'))::int AS failed
     FROM outbound_attempt_ledger
     WHERE campaign_id = $1 AND sender_address IS NOT NULL AND message_state NOT IN ('pending','rendered','queued','sending')
       AND created_at > NOW() - ($2::text || ' minutes')::interval`,
    [campaign.id, String(safety.failure_rate_window_minutes)],
  );
  const total = Number(rows[0]?.total || 0);
  const failed = Number(rows[0]?.failed || 0);
  if (total < safety.failure_rate_min_sample) return null;
  const percent = Math.round((failed / total) * 100);
  return percent > safety.auto_pause_failure_rate_percent ? { percent, total, failed } : null;
}

export async function completeMessagingCampaignIfExhausted(db, campaign) {
  if (!campaign?.id || campaign.status !== "running") return { completed: false };
  const active = await db.query(
    `SELECT COUNT(*) FILTER (WHERE message_state = ANY($2::text[]))::int AS live,
       COUNT(*) FILTER (WHERE NULLIF(metadata->>'next_retry_at','') IS NOT NULL AND (metadata->>'next_retry_at')::timestamptz > NOW())::int AS future_retry
     FROM outbound_attempt_ledger WHERE campaign_id = $1`,
    [campaign.id, MESSAGE_LIVE_STATES],
  );
  if (Number(active.rows[0]?.live) > 0 || Number(active.rows[0]?.future_retry) > 0) return { completed: false, live: Number(active.rows[0]?.live), futureRetry: Number(active.rows[0]?.future_retry) };
  const remaining = await countRemainingMessagingRecords(db, campaign);
  if (remaining > 0) return { completed: false, remaining };
  const now = iso();
  const { rows } = await db.query(
    `UPDATE outbound_campaigns SET status = 'stopped', metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_by = 'system', updated_at = NOW()
     WHERE id = $2 AND status = 'running' RETURNING *`,
    [JSON.stringify({ execution_state: "stopped", auto_completed_at: now, auto_completed_reason: "all_callable_records_exhausted",
      execution_control: { lastAction: "auto_complete", last_action: "auto_complete", updatedAt: now, updated_at: now, updatedBy: "system", updated_by: "system" } }), campaign.id],
  );
  await db.query(`UPDATE outbound_campaign_runs SET status = 'completed', stopped_at = COALESCE(stopped_at, NOW()), stopped_by = 'system', stop_reason = COALESCE(stop_reason, 'all_callable_records_exhausted'),
    metadata = COALESCE(metadata, '{}'::jsonb) || '{"auto_completed":true,"reason":"all_callable_records_exhausted"}'::jsonb, updated_at = NOW() WHERE campaign_id = $1 AND status = 'running'`, [campaign.id]);
  return { completed: Boolean(rows[0]), remaining: 0, campaign: rows[0] || null };
}

// Delivery evidence must reach this application even when the provider
// resource points its webhook elsewhere. Email delivery arrives through
// per-recipient reconciliation instead of a per-message webhook.
async function resolveWebhookUrl(channel) {
  try {
    if (channel === "sms") return (await import("../../sms/admin.mjs")).smsWebhookUrl();
    if (channel === "whatsapp") return (await import("../../whatsapp/webhook-url.mjs")).whatsappWebhookUrl();
  } catch { return null; }
  return null;
}

/**
 * Replies to a broadcast land in the inbound queues. Sending faster than agents
 * can answer only grows that backlog, so `reply.pause_when_reply_queue_waiting_over`
 * holds the next batch while more than that many inbound items of the same
 * channel are still waiting. Zero disables the check.
 */
export async function replyBacklogExceeded(db, channel, settings) {
  const limit = Number(settings?.reply?.pause_when_reply_queue_waiting_over) || 0;
  if (!(limit > 0)) return null;
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS waiting FROM acd_work_items
     WHERE channel = $1 AND direction = 'inbound' AND state IN ('open','queued') AND terminal_at IS NULL`,
    [channel],
  );
  const waiting = Number(rows?.[0]?.waiting || 0);
  return waiting > limit ? { waiting, limit } : null;
}

// One tick for one running campaign: budget → claim → prepare → send.
export async function runMessagingCampaignTick(pool, provider, campaign, { node = "messaging-worker", now = new Date(), settings: settingsOverride = null, outboundSettings: outboundOverride = null, webhookUrl: webhookOverride, templateRequest = null } = {}) {
  const outboundSettings = outboundOverride || await loadOutboundSettingsRow(pool);
  const settings = settingsOverride || messagingSettingsFrom(outboundSettings);
  const channel = campaign.channel;
  const summary = { campaignId: campaign.id, channel, claimed: 0, queued: 0, accepted: 0, failed: 0, suppressed: 0, skipped: 0, throttled: 0, budget: 0, limitedBy: null, node };
  if (!settings.enabled_channels[channel]) { await pauseMessagingCampaign(pool, campaign, "channel_disabled"); return { ...summary, paused: "channel_disabled" }; }
  const runtime = parse(campaign.metadata, {}).messaging_runtime || {};
  if (runtime.throttle_until && Date.parse(runtime.throttle_until) > now.getTime()) return { ...summary, waiting: "throttled" };
  if (runtime.next_batch_at && Date.parse(runtime.next_batch_at) > now.getTime()) return { ...summary, waiting: "batch_interval" };
  const backlog = await replyBacklogExceeded(pool, channel, settings);
  if (backlog) {
    await patchMessagingRuntime(pool, campaign.id, { next_batch_at: iso(new Date(now.getTime() + 60_000)), last_tick_at: iso(now), last_limited_by: "reply_backlog", reply_backlog: backlog.waiting });
    return { ...summary, waiting: "reply_backlog", limitedBy: "reply_backlog", reply_backlog: backlog.waiting };
  }
  const config = messagingCampaignConfig(campaign);
  const template = await loadMessagingTemplate(pool, channel, config.template[channel]?.template_id, { request: templateRequest });
  if (!template || template.status === "archived") { await pauseMessagingCampaign(pool, campaign, "template_unavailable"); return { ...summary, paused: "template_unavailable" }; }
  const senders = await loadMessagingSenders(pool, campaign, config, settings);
  if (!senders.length) { await pauseMessagingCampaign(pool, campaign, "missing_sender"); return { ...summary, paused: "missing_sender" }; }
  const mismatch = whatsappWabaMismatch(channel, template, senders);
  if (mismatch) { await pauseMessagingCampaign(pool, campaign, "template_waba_mismatch", mismatch); return { ...summary, paused: "template_waba_mismatch" }; }
  const pacing = effectiveMessagingPacing(campaign, outboundSettings);
  const webhookUrl = webhookOverride !== undefined ? webhookOverride : await resolveWebhookUrl(channel);

  // Budget and claim run under one lock so every node prices the same windows.
  let claimed = [];
  let counts;
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(`SELECT pg_advisory_xact_lock(${MESSAGING_RUNTIME_LOCK[0]}, ${MESSAGING_RUNTIME_LOCK[1]})`);
    const fresh = (await tx.query(`SELECT c.*, active_run.id AS active_run_id FROM outbound_campaigns c
      LEFT JOIN LATERAL (SELECT r.id FROM outbound_campaign_runs r WHERE r.campaign_id = c.id AND r.status = 'running' ORDER BY r.started_at DESC, r.id DESC LIMIT 1) active_run ON true
      WHERE c.id = $1 FOR UPDATE OF c`, [campaign.id])).rows[0];
    if (!fresh || fresh.status !== "running") { await tx.query("COMMIT"); return { ...summary, waiting: "not_running" }; }
    counts = await loadMessagingCounts(tx, { channel, campaignId: campaign.id });
    const budget = computeMessagingBudget({ pacing, counts });
    summary.budget = budget.budget; summary.limitedBy = budget.limitedBy;
    if (budget.budget > 0) {
      const run = fresh.active_run_id ? { id: fresh.active_run_id } : await startCampaignRun(tx, campaign.id, "system");
      claimed = await claimMessagingBatch(tx, fresh, run.id, budget.budget, { settings });
    }
    await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
  summary.claimed = claimed.length;

  if (!claimed.length) {
    if (summary.budget > 0) {
      const completion = await completeMessagingCampaignIfExhausted(pool, campaign);
      if (completion.completed) return { ...summary, completed: true };
    }
    await patchMessagingRuntime(pool, campaign.id, { next_batch_at: iso(new Date(now.getTime() + pacing.batch_interval_seconds * 1000)), last_tick_at: iso(now), last_budget: summary.budget, last_limited_by: summary.limitedBy });
    return summary;
  }

  const usedInBatch = new Map();
  let throttled = false;
  let blocked = null;
  let stopped = null;
  for (const [index, ledger] of claimed.entries()) {
    if (blocked) break;
    // A supervisor can pause or stop the campaign while the batch is running.
    // The claimed rows are already reserved, so they are released rather than
    // sent; without this check the whole batch would go out after the pause.
    const live = (await pool.query(`SELECT status FROM outbound_campaigns WHERE id = $1`, [campaign.id])).rows[0];
    if (live?.status !== "running") { stopped = live?.status || "missing"; break; }
    const contact = (await pool.query(`SELECT * FROM outbound_contact_records WHERE id = $1`, [ledger.contact_record_id])).rows[0] || null;
    let prepared;
    try {
      prepared = await prepareMessagingAttempt(pool, { campaign, config, settings, outboundSettings, template, ledger, contact, senders, pacing, counts, usedInBatch, batchIndex: index, webhookUrl });
    } catch (error) {
      executionLogger.error("messaging_prepare_failed", { campaignId: campaign.id, attemptId: ledger.id, ...outboundErrorPayload(error) });
      await setMessageState(pool, ledger.id, "failed_permanent", { failureReason: "prepare_failed", metadata: { reason_code: "prepare_failed", error: String(error?.message || error).slice(0, 300) } });
      summary.failed += 1;
      continue;
    }
    if (!prepared.ok) {
      if (prepared.campaignBlocked) blocked = prepared.campaignBlocked;
      if (prepared.state === "suppressed") summary.suppressed += 1;
      else if (prepared.state === "skipped") summary.skipped += 1;
      else if (prepared.state === "throttled") summary.throttled += 1;
      else summary.failed += 1;
      continue;
    }
    summary.queued += 1;
    if (throttled) { await setMessageState(pool, ledger.id, "throttled", { failureReason: "provider_throttled", metadata: { reason_code: "throttled", next_retry_at: minutesFromNow(settings.attempts.throttled_retry_minutes) } }); summary.throttled += 1; continue; }
    const sent = await sendMessagingAttempt(pool, provider, { campaign, ledger: prepared.ledger, command: prepared.command, settings });
    if (sent.ok) { summary.accepted += 1; continue; }
    summary.failed += 1;
    if (sent.classified?.throttled) { throttled = true; summary.throttled += 1; }
    if (sent.classified?.pause_campaign) blocked = sent.classified.reason_code;
  }

  if (stopped) {
    summary.cancelled = await releaseClaimedMessages(pool, claimed, `campaign_${stopped}`);
    return { ...summary, stopped };
  }
  if (blocked) {
    summary.cancelled = await releaseClaimedMessages(pool, claimed, blocked);
    await pauseMessagingCampaign(pool, campaign, blocked);
    return { ...summary, paused: blocked };
  }
  const breaker = await failureRateBreaker(pool, campaign, settings);
  if (breaker) {
    await pauseMessagingCampaign(pool, campaign, "failure_rate", `${breaker.percent}% of ${breaker.total} messages failed`);
    return { ...summary, paused: "failure_rate" };
  }
  await patchMessagingRuntime(pool, campaign.id, {
    next_batch_at: iso(new Date(now.getTime() + pacing.batch_interval_seconds * 1000)),
    ...(throttled ? { throttle_until: iso(new Date(now.getTime() + settings.safety.on_429_pause_seconds * 1000)), last_throttled_at: iso(now) } : { throttle_until: null }),
    last_tick_at: iso(now), last_batch: { claimed: summary.claimed, accepted: summary.accepted, failed: summary.failed, suppressed: summary.suppressed, skipped: summary.skipped, throttled: summary.throttled },
  });
  await notifyOutboundLiveCallsChanged(pool, { campaignId: campaign.id, channel, batch: summary.claimed }).catch(() => {});
  return summary;
}

export async function tickOutboundMessaging(pool, provider, { node = "messaging-worker", limit = 25 } = {}) {
  const results = [];
  let campaigns;
  try { campaigns = await loadMessagingCampaigns(pool); }
  catch (error) { return [{ routed: false, channel: "messaging", error: String(error?.message || error) }]; }
  if (!campaigns.length) return results;
  const outboundSettings = await loadOutboundSettingsRow(pool);
  const settings = messagingSettingsFrom(outboundSettings);
  try { await sweepStalledMessagingSends(pool); } catch (error) { results.push({ routed: false, channel: "messaging", error: String(error?.message || error) }); }
  for (const campaign of campaigns.slice(0, limit)) {
    try {
      const summary = await runMessagingCampaignTick(pool, provider, campaign, { node, settings, outboundSettings });
      if (summary.claimed || summary.paused || summary.completed) results.push(summary);
    } catch (error) {
      executionLogger.error("messaging_tick_failed", { campaignId: campaign.id, ...outboundErrorPayload(error) });
      results.push({ campaignId: campaign.id, routed: false, error: String(error?.message || error) });
    }
  }
  return results;
}

// Immediate test message for the campaign editor. Recorded on the ledger with
// attempt_reason 'test_send' and no contact so it never affects the audience.
export async function sendMessagingTest(pool, provider, { campaign, to, contact = null, settings: settingsOverride = null, outboundSettings: outboundOverride = null, webhookUrl, templateRequest = null }) {
  const outboundSettings = outboundOverride || await loadOutboundSettingsRow(pool);
  const settings = settingsOverride || messagingSettingsFrom(outboundSettings);
  const config = messagingCampaignConfig(campaign);
  const template = await loadMessagingTemplate(pool, campaign.channel, config.template[campaign.channel]?.template_id, { request: templateRequest });
  if (!template) throw Object.assign(new Error("Select a template before sending a test message"), { status: 400 });
  const senders = await loadMessagingSenders(pool, campaign, config, settings);
  if (!senders.length) throw Object.assign(new Error("Select at least one sending-enabled number"), { status: 400 });
  const destination = resolveMessagingDestination({ channel: campaign.channel, destinationFields: ["__test__"], rowData: { __test__: to }, contactMethods: {} });
  if (!destination.address) throw Object.assign(new Error("Enter a valid test destination"), { status: 400 });
  const testMode = settings.safety.test_mode;
  if (testMode.enabled && !testMode.allowlist.some((entry) => entry.replace(/\D/g, "") === destination.address.replace(/\D/g, "") || entry === destination.address.toLowerCase())) throw Object.assign(new Error("Test mode allows only allowlisted destinations"), { status: 403 });
  const sender = senders[0];
  const system = systemVariableValues({ campaign, senderAddress: sender.address, optOutInstructions: campaign.channel === "sms" ? settings.sms?.opt_out_footer_text : "", timezone: parse(outboundSettings, {}).callable_window?.timezone });
  const resolved = resolveVariableValues(config.variable_mapping, { rowData: parse(contact?.row_data, {}), contactMethods: parse(contact?.contact_methods, {}), system });
  const rendered = renderMessagingMessage({ channel: campaign.channel, template, values: resolved.values, settings, config, blankMissing: true });
  if (!rendered.ok) throw Object.assign(new Error(rendered.reason === "too_many_segments" ? "The message needs more parts than the workspace allows" : "The message could not be rendered"), { status: 400 });
  const { rows } = await pool.query(
    `INSERT INTO outbound_attempt_ledger (campaign_id, contact_record_id, status, channel, handler_type, claim_key, attempt_reason, message_state, to_address, sender_address, metadata)
     VALUES ($1, NULL, 'claimed', $2, 'queue', $3, 'test_send', 'queued', $4, $5, $6::jsonb) RETURNING *`,
    [campaign.id, campaign.channel, randomUUID(), destination.address, sender.address, JSON.stringify({ test: true, to_number: destination.address, from_number: sender.address, template_id: template.id, rendered: { text: rendered.text, encoding: rendered.segments?.encoding, parts: rendered.segments?.parts }, variables_used: resolved.values, missing_variables: rendered.missing, sample_contact_id: contact?.id || null })],
  );
  const url = webhookUrl !== undefined ? webhookUrl : await resolveWebhookUrl(campaign.channel);
  const command = buildProviderCommand(campaign, rows[0], sender, rendered, url, config, settings);
  const sent = await sendMessagingAttempt(pool, provider, { campaign, ledger: rows[0], command, settings });
  return { attempt: sent.ledger, text: rendered.text, segments: rendered.segments, accepted: sent.ok, state: sent.state, reason: sent.classified?.reason_code || null };
}
