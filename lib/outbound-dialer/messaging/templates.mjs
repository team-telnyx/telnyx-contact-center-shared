// Server-side template descriptors for messaging campaigns. Every channel
// exposes the same shape so the campaign editor, the preview endpoint and the
// broadcast runner never branch on storage details.
import { composeSmsMessage, extractSmsTemplateVariables } from "../../sms/templates.mjs";
import { templateHeaderFormat, templatePreviewParts, templateRuntimeComponents, templateVariableFields, renderTemplateText } from "../../whatsapp/templates.mjs";
import { buildWhatsAppTemplateMessage } from "../../whatsapp/policy.mjs";
import { EMAIL_VARIABLE_PATTERN, extractEmailTemplateVariables, messagingTemplateVariableKeys, subjectOverrideVariables } from "./variables.mjs";

// The variable helpers live in the browser-safe variables module, so the
// campaign editor derives the same list; the server modules keep importing
// them from here.
export { extractEmailTemplateVariables, messagingTemplateVariableKeys, subjectOverrideVariables };

// Header formats Meta renders from a media link supplied per message.
export const MEDIA_HEADER_FORMATS = Object.freeze(["IMAGE", "VIDEO", "DOCUMENT"]);

export function describeSmsTemplate(row) {
  if (!row) return null;
  const variables = Array.isArray(row.variables) && row.variables.length ? row.variables : extractSmsTemplateVariables(row.body);
  return {
    channel: "sms",
    id: row.id,
    name: row.name,
    category: row.category,
    language: row.language,
    status: row.status,
    body: row.body,
    footer_mode: row.footer_mode || "inherit",
    footer_text: row.footer_text || "",
    sample_values: row.sample_values && typeof row.sample_values === "object" ? row.sample_values : {},
    variables: variables.map((key) => ({ key, label: key, kind: "named", required: true })),
    updated_at: row.updated_at || null,
  };
}

// Meta templates carry positional {{1}} placeholders per component; the field
// keys ("body:1", "header:1", "button:0") are the campaign variable keys.
export function describeWhatsAppTemplate(row) {
  if (!row) return null;
  const fields = templateVariableFields(row);
  const parts = templatePreviewParts(row);
  const status = String(row.status || "").toUpperCase();
  return {
    channel: "whatsapp",
    id: row.id,
    name: row.name,
    category: String(row.category || "").toUpperCase(),
    language: row.language,
    status,
    approved: status === "APPROVED",
    waba_id: String(row.whatsapp_business_account?.waba_id || row.whatsapp_business_account?.id || row.waba_id || ""),
    body: [parts.header, parts.body, parts.footer].filter(Boolean).join("\n"),
    header_format: templateHeaderFormat(row),
    components: Array.isArray(row.components) ? row.components : [],
    sample_values: Object.fromEntries(fields.map((field) => [field.key, field.defaultValue || ""])),
    variables: fields.map((field) => ({ key: field.key, label: field.label, kind: "positional", required: true })),
    updated_at: row.updated_at || null,
  };
}

// Telnyx hosts email templates and renders Liquid at send time. Campaigns
// render locally instead, so the preview, the audience scan and the sent
// message all come from one substitution (EMAIL_VARIABLE_PATTERN in variables.mjs).
// Anything Telnyx would evaluate as Liquid that this renderer cannot: a tag
// (`{% if %}`), or an output expression that is not a bare `{{ name }}` —
// filters (`{{ name | upcase }}`), lookups (`{{ items[0] }}`) and the like.
const LIQUID_TAG_PATTERN = /\{%/;
const LIQUID_EXPRESSION_PATTERN = /\{\{(?!\s*[A-Za-z_][\w.]*\s*\}\})/;

export function usesUnsupportedLiquid(...sources) {
  return sources.some((source) => LIQUID_TAG_PATTERN.test(String(source || "")) || LIQUID_EXPRESSION_PATTERN.test(String(source || "")));
}

export function describeEmailTemplate(row) {
  if (!row) return null;
  const subject = row.subject || "";
  const html = row.html_body || row.html || "";
  const text = row.text_body || row.text || "";
  return {
    channel: "email",
    id: row.id,
    name: row.name || subject || row.id,
    category: "email",
    language: row.language || "",
    status: "active",
    subject,
    html_body: html,
    text_body: text,
    body: text || htmlToText(html),
    uses_liquid_logic: usesUnsupportedLiquid(subject, html, text),
    sample_values: {},
    variables: extractEmailTemplateVariables(subject, html, text).map((key) => ({ key, label: key, kind: "named", required: true })),
    updated_at: row.updated_at || null,
  };
}

// Plain-text alternative for an HTML-only template, so every campaign email
// carries a text part.
const HTML_ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };

/** Strips tags until the result stops changing, so a nested `<<b>b>` cannot leave a live tag behind. */
function stripTags(value) {
  let previous;
  let current = value;
  do {
    previous = current;
    current = current.replace(/<[^>]+>/g, "");
  } while (current !== previous);
  return current;
}

export function htmlToText(html) {
  const withBreaks = String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<\/(p|div|h[1-6])>/gi, "\n\n")
    .replace(/<\/(tr|li)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ");
  return stripTags(withBreaks)
    // One pass over the entities, never a chain of replaces: decoding &amp;
    // before &lt; turns the literal text "&amp;lt;" into "<" — the input said
    // "&lt;" and the reader should see "&lt;".
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (whole, name) => HTML_ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function listMessagingTemplates(pool, channel, { includeArchived = false, request = null } = {}) {
  if (channel === "sms") {
    const { rows } = await pool.query(`SELECT * FROM cc_sms_templates ${includeArchived ? "" : "WHERE status='active'"} ORDER BY name`);
    return rows.map(describeSmsTemplate);
  }
  if (channel === "whatsapp") {
    const send = request || (await import("../../whatsapp/provider.mjs")).whatsappRequest;
    const result = await send("/whatsapp/message_templates?page[size]=100&page[number]=1");
    const templates = (Array.isArray(result?.data) ? result.data : []).map(describeWhatsAppTemplate);
    // Only Meta-approved templates can start a business-initiated conversation.
    return (includeArchived ? templates : templates.filter((template) => template.approved)).sort((a, b) => a.name.localeCompare(b.name));
  }
  if (channel === "email") {
    const send = request || (await import("../../email/provider.mjs")).emailRequest;
    const result = await send("/email_templates?page_size=100");
    return (Array.isArray(result?.data) ? result.data : []).map(describeEmailTemplate).sort((a, b) => a.name.localeCompare(b.name));
  }
  return [];
}

export async function loadMessagingTemplate(pool, channel, templateId, { request = null } = {}) {
  if (!templateId) return null;
  if (channel === "sms") {
    const { rows } = await pool.query(`SELECT * FROM cc_sms_templates WHERE id=$1`, [templateId]);
    return describeSmsTemplate(rows[0]);
  }
  if (channel === "whatsapp") {
    const { whatsappId } = await import("../../whatsapp/provider.mjs");
    const send = request || (await import("../../whatsapp/provider.mjs")).whatsappRequest;
    const result = await send(`/whatsapp/message_templates/${whatsappId(String(templateId))}`);
    return describeWhatsAppTemplate(result?.data);
  }
  if (channel === "email") {
    const { emailId } = await import("../../email/provider.mjs");
    const send = request || (await import("../../email/provider.mjs")).emailRequest;
    const result = await send(`/email_templates/${emailId(String(templateId))}`);
    return describeEmailTemplate(result?.data);
  }
  return null;
}

const fillNamed = (source, values, blankMissing) => String(source || "").replace(EMAIL_VARIABLE_PATTERN, (match, name) => {
  const value = values?.[name];
  if (value == null || String(value).trim() === "") return blankMissing ? "" : match;
  return String(value);
});

// Render the final message for one contact. `missing` lists variables without a
// value; the caller applies the campaign's missing-variable policy.
export function renderMessagingMessage({ channel, template, values = {}, settings = {}, config = {}, blankMissing = false } = {}) {
  if (!template) return { ok: false, reason: "template_unavailable" };
  if (channel === "sms") {
    const smsSettings = settings?.sms || {};
    const composed = composeSmsMessage({
      body: template.body,
      values,
      footerMode: config?.template?.sms?.footer_mode || template.footer_mode || "inherit",
      requireFooter: smsSettings.require_opt_out_footer !== false,
      footerText: smsSettings.opt_out_footer_text || "",
      templateFooterText: config?.template?.sms?.footer_text || template.footer_text || "",
      blankMissing,
    });
    const maxParts = Number(smsSettings.max_segments_per_message) || 10;
    return {
      ok: composed.segments.parts > 0 && composed.segments.parts <= maxParts && !composed.segments.tooLong,
      reason: composed.segments.parts > maxParts || composed.segments.tooLong ? "too_many_segments" : null,
      text: composed.text,
      footer: composed.footer,
      missing: composed.missing,
      segments: composed.segments,
      preview: { kind: "sms", text: composed.text },
    };
  }
  if (channel === "whatsapp") {
    const whatsappSettings = settings?.whatsapp || {};
    const missing = (template.variables || []).map((variable) => variable.key).filter((key) => String(values?.[key] ?? "").trim() === "");
    if (!template.approved) return { ok: false, reason: "template_not_approved", missing, preview: { kind: "whatsapp", text: template.body } };
    const allowed = whatsappSettings.allowed_template_categories || [];
    if (allowed.length && !allowed.includes(template.category)) return { ok: false, reason: "template_category_not_allowed", missing, preview: { kind: "whatsapp", text: template.body } };
    if (MEDIA_HEADER_FORMATS.includes(String(template.header_format || "").toUpperCase()) && !String(config?.template?.whatsapp?.header_media?.url || "").trim()) {
      return { ok: false, reason: "header_media_required", missing, preview: { kind: "whatsapp", text: template.body } };
    }
    if (whatsappSettings.require_consent_for_marketing !== false && template.category === "MARKETING" && !String(config?.consent?.field || "").trim()) {
      return { ok: false, reason: "consent_field_required", missing, preview: { kind: "whatsapp", text: template.body } };
    }
    const fields = templateVariableFields({ components: template.components, category: template.category });
    const media = config?.template?.whatsapp?.header_media || null;
    const components = templateRuntimeComponents(fields, values, media ? { mediaType: media.type, mediaUrl: media.url, filename: media.filename } : {});
    const text = renderTemplateText({ components: template.components, category: template.category }, values);
    const message = buildWhatsAppTemplateMessage({ templateId: template.id, name: template.name, language: template.language, components });
    return {
      ok: missing.length === 0 || blankMissing,
      reason: missing.length && !blankMissing ? "missing_variables" : null,
      text, message, missing, preview: { kind: "whatsapp", text },
    };
  }
  if (channel === "email") {
    const emailSettings = settings?.email || {};
    const keys = messagingTemplateVariableKeys(template, config);
    const missing = keys.filter((key) => String(values?.[key] ?? "").trim() === "");
    // Liquid conditionals and loops are evaluated by Telnyx at send time, which
    // a per-contact campaign preview and audience scan cannot do. Refuse rather
    // than send raw Liquid to the customer.
    if (template.uses_liquid_logic || usesUnsupportedLiquid(config?.template?.email?.subject_override)) {
      return { ok: false, reason: "template_uses_liquid_logic", missing, preview: { kind: "email", subject: template.subject, text: template.body } };
    }
    const subject = fillNamed(config?.template?.email?.subject_override || template.subject, values, blankMissing);
    const html = fillNamed(template.html_body, values, blankMissing);
    const text = fillNamed(template.text_body, values, blankMissing) || htmlToText(html);
    const unsubscribeGroupId = String(emailSettings.unsubscribe_group_id || "").trim();
    const unsubscribeUrl = String(values?.unsubscribe_url || "").trim();
    if (emailSettings.require_unsubscribe !== false && !unsubscribeGroupId && !unsubscribeUrl && !/https?:\/\/[^\s"'<>]*unsubscribe/i.test(`${html}\n${text}`)) {
      return { ok: false, reason: "unsubscribe_required", missing, preview: { kind: "email", subject, text } };
    }
    const headers = {};
    if (emailSettings.add_list_unsubscribe_header !== false) {
      if (unsubscribeUrl) { headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`; headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"; }
      else if (!unsubscribeGroupId && config?.sender?.email?.reply_to) headers["List-Unsubscribe"] = `<mailto:${config.sender.email.reply_to}?subject=unsubscribe>`;
    }
    if (!subject.trim()) return { ok: false, reason: "missing_subject", missing, preview: { kind: "email", subject, text } };
    if (!text.trim() && !html.trim()) return { ok: false, reason: "missing_body", missing, preview: { kind: "email", subject, text } };
    return {
      ok: missing.length === 0 || blankMissing,
      reason: missing.length && !blankMissing ? "missing_variables" : null,
      subject, html, text, headers, missing,
      ...(unsubscribeGroupId ? { unsubscribe_group_id: unsubscribeGroupId } : {}),
      preview: { kind: "email", subject, text, html },
    };
  }
  return { ok: false, reason: `channel_${channel}_not_available` };
}
