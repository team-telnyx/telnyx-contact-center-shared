// Server-side helpers shared by the campaign editor endpoints: sample contacts,
// single-contact preview rendering and the audience validation scan.
import { recordMatchesFilter } from "../execution.js";
import { messagingCampaignConfig } from "./campaign-config.mjs";
import { messagingSettingsFrom } from "./settings.mjs";
import { resolveMessagingDestination, normalizeEmailAddress } from "./destination.mjs";
import { loadMessagingTemplate, messagingTemplateVariableKeys, renderMessagingMessage } from "./templates.mjs";
import { resolveVariableValues, systemVariableValues } from "./variables.mjs";
import { allowedByTestMode, consentGranted } from "./suppression.mjs";

// Why the renderer refused, in the operator's terms.
const RENDER_REASONS = Object.freeze({
  header_media_required: "This template has a media header. Add the header media URL before starting the campaign.",
  consent_field_required: "Marketing templates need a consent field. Choose one under Audience, or turn off the consent requirement in Dialer settings.",
  template_not_approved: "This WhatsApp template is not approved by Meta and cannot start a conversation.",
  template_category_not_allowed: "This template's category is not allowed in Dialer settings.",
  template_uses_liquid_logic: "This template uses Liquid that campaigns render locally and cannot evaluate. Use plain {{variable}} placeholders.",
  unsubscribe_required: "The workspace requires an unsubscribe link. Add one to the template, or set an unsubscribe group in Dialer settings.",
  missing_subject: "The email has no subject.",
  missing_body: "The email has no body.",
});

const parse = (value, fallback = {}) => {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

export async function loadSampleContact(pool, { contactListId, contactRecordId = null, offset = 0 }) {
  if (!contactListId) return null;
  if (contactRecordId) {
    const { rows } = await pool.query(`SELECT * FROM outbound_contact_records WHERE id = $1 AND contact_list_id = $2`, [contactRecordId, contactListId]);
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    `SELECT * FROM outbound_contact_records WHERE contact_list_id = $1 ORDER BY COALESCE(created_at, 'epoch'::timestamptz) ASC, id ASC OFFSET $2 LIMIT 1`,
    [contactListId, Math.max(0, Number(offset) || 0)],
  );
  return rows[0] || null;
}

export async function countContacts(pool, contactListId) {
  if (!contactListId) return 0;
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM outbound_contact_records WHERE contact_list_id = $1`, [contactListId]);
  return Number(rows[0]?.n || 0);
}

// Render one contact through the campaign draft (unsaved drafts allowed).
export async function previewMessagingMessage(pool, { campaign, contact, outboundSettings, senderAddress = null, templateRequest = null }) {
  const channel = String(campaign?.channel || "sms").toLowerCase();
  const config = messagingCampaignConfig(campaign);
  const settings = messagingSettingsFrom(outboundSettings);
  const template = await loadMessagingTemplate(pool, channel, config.template[channel]?.template_id, { request: templateRequest });
  const destination = resolveMessagingDestination({ channel, destinationFields: config.destination_fields, rowData: contact?.row_data, contactMethods: contact?.contact_methods });
  const system = systemVariableValues({ campaign, senderAddress: senderAddress || "", optOutInstructions: settings.sms?.opt_out_footer_text, timezone: parse(outboundSettings, {}).callable_window?.timezone });
  const resolved = resolveVariableValues(config.variable_mapping, { rowData: parse(contact?.row_data, {}), contactMethods: parse(contact?.contact_methods, {}), system });
  const rendered = template ? renderMessagingMessage({ channel, template, values: resolved.values, settings, config, blankMissing: config.missing_variable_policy === "send_blank" }) : { ok: false, reason: "template_unavailable", text: "", missing: [], segments: null };
  const unmapped = template ? messagingTemplateVariableKeys(template, config).filter((key) => !config.variable_mapping.some((row) => row.key === key && (row.value || row.fallback))) : [];
  const warnings = [];
  if (!template) warnings.push("Select a template.");
  if (!destination.address) warnings.push(`No valid ${channel === "email" ? "email address" : "phone number"} in the selected destination fields.`);
  if (unmapped.length) warnings.push(`Unmapped variables: ${unmapped.join(", ")}.`);
  if (rendered.missing?.length) warnings.push(`No value for: ${rendered.missing.join(", ")} (policy: ${config.missing_variable_policy.replace("_", " ")}).`);
  if (rendered.reason === "too_many_segments") warnings.push(`The message needs ${rendered.segments?.parts} parts; the workspace allows ${settings.sms?.max_segments_per_message}.`);
  // Everything else the renderer refuses, named so the operator can act on it
  // instead of seeing an empty preview with no explanation.
  if (RENDER_REASONS[rendered.reason]) warnings.push(RENDER_REASONS[rendered.reason]);
  if (!consentGranted(config, contact?.row_data)) warnings.push("Consent field does not contain an accepted value.");
  if (destination.address && !allowedByTestMode(settings, destination.address)) warnings.push("Test mode is on and this destination is not on the allowlist, so the message would be suppressed.");
  return {
    ok: Boolean(template && destination.address && rendered.ok && !unmapped.length && (!rendered.missing?.length || config.missing_variable_policy === "send_blank")),
    channel, template: template ? { id: template.id, name: template.name, variables: template.variables } : null,
    destination, values: resolved.values, missing: rendered.missing || resolved.missing, unmapped,
    text: rendered.text || "", segments: rendered.segments || null, footer: rendered.footer || "", warnings,
    contact: contact ? { id: contact.id, row_data: parse(contact.row_data, {}), contact_methods: parse(contact.contact_methods, {}), validation_status: contact.validation_status } : null,
  };
}

// Scan the audience in keyset batches and count what the runner would do.
export async function validateMessagingAudience(pool, { campaign, outboundSettings, scanLimit = 10000, batchSize = 1000, sampleLimit = 10, templateRequest = null }) {
  const channel = String(campaign?.channel || "sms").toLowerCase();
  const config = messagingCampaignConfig(campaign);
  const settings = messagingSettingsFrom(outboundSettings);
  const template = await loadMessagingTemplate(pool, channel, config.template[channel]?.template_id, { request: templateRequest });
  const metadata = parse(campaign?.metadata, {});
  const filterId = metadata.contact_list_filter_id || metadata.filter_id || null;
  const filter = filterId ? (await pool.query(`SELECT conditions FROM outbound_contact_filters WHERE id = $1 AND status = 'active'`, [filterId])).rows[0] : null;
  const conditions = Array.isArray(filter?.conditions) ? filter.conditions : [];
  const dncListId = metadata.dnc_list_id || null;
  const counts = { total: await countContacts(pool, campaign.contact_list_id), scanned: 0, sendable: 0, missing_destination: 0, filtered_out: 0, dnc: 0, opted_out: 0, consent_missing: 0, test_mode_allowlist: 0, missing_variables: 0, too_many_segments: 0, not_valid: 0, estimated_parts: 0 };
  const missingByVariable = {};
  const problems = [];
  const system = systemVariableValues({ campaign, senderAddress: "", optOutInstructions: settings.sms?.opt_out_footer_text, timezone: parse(outboundSettings, {}).callable_window?.timezone });
  let lastCreatedAt = null;
  let lastId = null;
  while (counts.scanned < scanLimit) {
    // The cursor stays a Postgres text timestamp: a JavaScript Date would
    // truncate microseconds and re-read rows created in the same millisecond.
    const { rows } = await pool.query(
      `SELECT id, row_data, contact_methods, validation_status, COALESCE(created_at, 'epoch'::timestamptz)::text AS created_cursor FROM outbound_contact_records
       WHERE contact_list_id = $1 AND ($2::timestamptz IS NULL OR (COALESCE(created_at, 'epoch'::timestamptz), id) > ($2::timestamptz, $3::uuid))
       ORDER BY COALESCE(created_at, 'epoch'::timestamptz) ASC, id ASC LIMIT $4`,
      [campaign.contact_list_id, lastCreatedAt, lastId, Math.min(batchSize, scanLimit - counts.scanned)],
    );
    if (!rows.length) break;
    const addresses = rows.map((row) => resolveMessagingDestination({ channel, destinationFields: config.destination_fields, rowData: row.row_data, contactMethods: row.contact_methods }));
    const phoneDigits = addresses.map((entry) => entry.address).filter(Boolean).map((address) => (channel === "email" ? normalizeEmailAddress(address) : address.replace(/\D/g, ""))).filter(Boolean);
    const dnc = new Set();
    if (dncListId && phoneDigits.length) {
      const hits = await pool.query(
        `SELECT e.normalized_value FROM outbound_dnc_entries e JOIN outbound_dnc_lists l ON l.id = e.dnc_list_id AND l.status = 'active'
         WHERE e.dnc_list_id = $1 AND e.value_type = $2 AND e.normalized_value = ANY($3::text[])`,
        [dncListId, channel === "email" ? "email" : "phone", channel === "email" ? phoneDigits : [...phoneDigits, ...phoneDigits.map((digits) => `+${digits}`)]],
      );
      for (const hit of hits.rows) dnc.add(String(hit.normalized_value).replace(/^\+/, ""));
    }
    const optedOut = new Set();
    if (channel === "sms" && phoneDigits.length) {
      const hits = await pool.query(`SELECT customer_address FROM cc_sms_threads WHERE opted_out_at IS NOT NULL AND customer_address = ANY($1::text[])`, [addresses.map((entry) => entry.address).filter(Boolean)]);
      for (const hit of hits.rows) optedOut.add(hit.customer_address);
      const learned = await pool.query(`SELECT DISTINCT to_address FROM outbound_attempt_ledger WHERE channel = $1 AND to_address = ANY($2::text[]) AND COALESCE(metadata->>'reason_code','') = 'opted_out'`, [channel, addresses.map((entry) => entry.address).filter(Boolean)]);
      for (const hit of learned.rows) optedOut.add(hit.to_address);
    }
    rows.forEach((row, index) => {
      counts.scanned += 1;
      const rowData = parse(row.row_data, {});
      const problem = (reason, detail) => { if (problems.length < sampleLimit) problems.push({ contact_record_id: row.id, reason, detail: detail || null, row_data: rowData }); };
      if (row.validation_status !== "valid") { counts.not_valid += 1; problem("not_valid", row.validation_status); return; }
      const address = addresses[index].address;
      if (!address) { counts.missing_destination += 1; problem("missing_destination"); return; }
      if (conditions.length && !recordMatchesFilter(rowData, conditions)) { counts.filtered_out += 1; return; }
      const key = channel === "email" ? address : address.replace(/\D/g, "");
      if (dnc.has(key)) { counts.dnc += 1; problem("dnc_match", address); return; }
      if (optedOut.has(address)) { counts.opted_out += 1; problem("opted_out", address); return; }
      if (!consentGranted(config, rowData)) { counts.consent_missing += 1; problem("consent_missing", config.consent.field); return; }
      // Test mode suppresses everything off the allowlist at send time, so the
      // estimate has to apply it too instead of promising the whole list.
      if (!allowedByTestMode(settings, address)) { counts.test_mode_allowlist += 1; problem("test_mode_allowlist", address); return; }
      if (!template) return;
      const resolved = resolveVariableValues(config.variable_mapping, { rowData, contactMethods: parse(row.contact_methods, {}), system });
      const rendered = renderMessagingMessage({ channel, template, values: resolved.values, settings, config, blankMissing: true });
      const unmapped = messagingTemplateVariableKeys(template, config).filter((variable) => !config.variable_mapping.some((entry) => entry.key === variable && (entry.value || entry.fallback)));
      const missing = [...new Set([...(rendered.missing || []), ...unmapped])];
      if (missing.length && config.missing_variable_policy !== "send_blank") {
        counts.missing_variables += 1;
        for (const variable of missing) missingByVariable[variable] = (missingByVariable[variable] || 0) + 1;
        problem("missing_variables", missing.join(", "));
        return;
      }
      if (!rendered.ok) { counts.too_many_segments += 1; problem(rendered.reason || "render_failed", rendered.segments ? `${rendered.segments.parts} parts` : null); return; }
      counts.sendable += 1;
      counts.estimated_parts += Number(rendered.segments?.parts || 1);
    });
    const last = rows[rows.length - 1];
    lastCreatedAt = last.created_cursor;
    lastId = last.id;
    if (rows.length < Math.min(batchSize, scanLimit - counts.scanned + rows.length)) break;
  }
  return { ok: Boolean(template) && counts.sendable > 0, template_selected: Boolean(template), limited: counts.total > scanLimit, scan_limit: scanLimit, counts, missing_by_variable: missingByVariable, problems, generated_at: new Date().toISOString() };
}
