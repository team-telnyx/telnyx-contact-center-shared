import assert from "node:assert/strict";
import test from "node:test";
import { composeSmsMessage, extractSmsTemplateVariables, normalizeSmsTemplateInput, renderSmsTemplateBody, smsFooterDecision, smsFooterPresent } from "../lib/sms/templates.mjs";
import { normalizeTemplateLanguage, templateLanguage } from "../lib/messaging/template-languages.mjs";
import { describeEmailTemplate, describeSmsTemplate, messagingTemplateVariableKeys, renderMessagingMessage, subjectOverrideVariables, usesUnsupportedLiquid } from "../lib/outbound-dialer/messaging/templates.mjs";

test("SMS templates extract named variables once and render them", () => {
  const body = "Hi {{ first_name }}, your order {{order_id}} ships {{first_name}}.";
  assert.deepEqual(extractSmsTemplateVariables(body), ["first_name", "order_id"]);
  const rendered = renderSmsTemplateBody(body, { first_name: "Anna" });
  assert.equal(rendered.text, "Hi Anna, your order {{order_id}} ships Anna.");
  assert.deepEqual(rendered.missing, ["order_id"]);
});

test("composed SMS appends the opt-out footer once and reports segments", () => {
  const composed = composeSmsMessage({ body: "Hello {{name}}", values: { name: "Anna" }, footerText: "Reply STOP to opt out" });
  assert.equal(composed.text, "Hello Anna\nReply STOP to opt out");
  assert.equal(composed.segments.encoding, "GSM-7");
  assert.equal(composed.segments.parts, 1);
  const already = composeSmsMessage({ body: "Hello. Reply STOP to opt out", values: {}, footerText: "Reply STOP to opt out" });
  assert.equal(already.text, "Hello. Reply STOP to opt out");
  const none = composeSmsMessage({ body: "Hello", values: {}, footerMode: "none", requireFooter: false, footerText: "Reply STOP" });
  assert.equal(none.text, "Hello");
  assert.equal(none.footerReason, "none");
  const forced = composeSmsMessage({ body: "Hello", values: {}, footerMode: "none", requireFooter: true, footerText: "Reply STOP" });
  assert.equal(forced.text, "Hello\nReply STOP");
  assert.equal(forced.footerReason, "required", "compliance keeps the footer and says so instead of contradicting the mode silently");
  const blank = composeSmsMessage({ body: "Hi {{name}}!", values: {}, footerText: "", blankMissing: true });
  assert.equal(blank.text, "Hi !");
  assert.deepEqual(blank.missing, ["name"]);
});

test("template input normalization validates name, body, category and samples", () => {
  const template = normalizeSmsTemplateInput({ name: "  Promo  ", body: "Cześć {{first_name}}, rabat {{code}}", category: "utility", language: "PL", footer_mode: "none", sample_values: { first_name: "Anna", stale: "x" } });
  assert.equal(template.name, "Promo");
  assert.equal(template.category, "utility");
  assert.equal(template.language, "pl");
  assert.equal(template.footer_mode, "none");
  assert.deepEqual(template.variables, ["first_name", "code"]);
  assert.deepEqual(template.sample_values, { first_name: "Anna", code: "" });
  assert.throws(() => normalizeSmsTemplateInput({ name: "", body: "x" }), /name is required/);
  assert.throws(() => normalizeSmsTemplateInput({ name: "x", body: "  " }), /text is required/);
  assert.throws(() => normalizeSmsTemplateInput({ name: "x", body: "a".repeat(1601) }), /limited to 1600/);
});

test("messaging descriptor renders SMS with workspace footer and segment cap", () => {
  const template = describeSmsTemplate({ id: "t1", name: "Promo", category: "marketing", language: "pl", status: "active", body: "Cześć {{first_name}}", variables: [], sample_values: {} });
  assert.deepEqual(template.variables, [{ key: "first_name", label: "first_name", kind: "named", required: true }]);
  const settings = { sms: { require_opt_out_footer: true, opt_out_footer_text: "STOP aby zrezygnować", max_segments_per_message: 1 } };
  const ok = renderMessagingMessage({ channel: "sms", template, values: { first_name: "Anna" }, settings, config: {} });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "Cześć Anna\nSTOP aby zrezygnować");
  assert.equal(ok.segments.encoding, "UCS-2");
  const long = renderMessagingMessage({ channel: "sms", template: { ...template, body: "x".repeat(200) }, values: {}, settings, config: {} });
  assert.equal(long.ok, false);
  assert.equal(long.reason, "too_many_segments");
  const missing = renderMessagingMessage({ channel: "whatsapp", template, values: {}, settings, config: {} });
  assert.equal(missing.ok, false);
});

test("the opt-out footer follows the workspace policy and the template override", () => {
  const workspace = { footerText: "Reply STOP to opt out", requireFooter: true };
  // "Append footer" uses the template text when set, otherwise the workspace one.
  assert.deepEqual(smsFooterDecision({ ...workspace, footerMode: "inherit" }), { text: "Reply STOP to opt out", reason: "template" });
  assert.deepEqual(smsFooterDecision({ ...workspace, footerMode: "inherit", templateFooterText: "  Wyślij STOP  " }), { text: "Wyślij STOP", reason: "template" });
  // "No footer" removes it once the workspace stops requiring one.
  assert.deepEqual(smsFooterDecision({ ...workspace, footerMode: "none" }), { text: "Reply STOP to opt out", reason: "required" });
  assert.deepEqual(smsFooterDecision({ ...workspace, footerMode: "none", requireFooter: false }), { text: "", reason: "none" });
  // A workspace without a configured footer appends nothing.
  assert.deepEqual(smsFooterDecision({ footerMode: "inherit", requireFooter: true, footerText: "" }), { text: "", reason: "none" });
  const overridden = composeSmsMessage({ body: "Hi", footerMode: "inherit", requireFooter: true, footerText: "Reply STOP to opt out", templateFooterText: "STOP = rezygnacja" });
  assert.equal(overridden.text, "Hi\nSTOP = rezygnacja");
  assert.equal(overridden.footerAppended, true);
});

test("template languages come from the shared catalogue and keep their canonical code", () => {
  assert.equal(templateLanguage("pt-br").name, "Portuguese (Brazil)");
  assert.equal(templateLanguage("PL").flag, "🇵🇱");
  assert.equal(templateLanguage("klingon"), null);
  assert.equal(normalizeTemplateLanguage("pt-BR"), "pt_BR");
  assert.equal(normalizeTemplateLanguage("EN"), "en");
  assert.equal(normalizeTemplateLanguage("x-custom!"), "x_custom");
  assert.equal(normalizeTemplateLanguage(""), "en");
  const template = normalizeSmsTemplateInput({ name: "Promo", body: "Olá", language: "pt-BR", footer_text: "  STOP   para   sair " });
  assert.equal(template.language, "pt_BR");
  assert.equal(template.footer_text, "STOP para sair", "footer text is collapsed and trimmed");
  assert.equal(normalizeSmsTemplateInput({ name: "Promo", body: "Hi", footer_text: "x".repeat(200) }).footer_text.length, 120);
});

test("campaign rendering prefers the template footer over the workspace default", () => {
  const settings = { sms: { require_opt_out_footer: true, opt_out_footer_text: "Reply STOP to opt out", max_segments_per_message: 3 } };
  const template = describeSmsTemplate({ id: "t1", name: "Promo", category: "marketing", language: "pl", status: "active", body: "Cześć", variables: [], sample_values: {}, footer_text: "STOP kończy" });
  assert.equal(template.footer_text, "STOP kończy");
  assert.equal(renderMessagingMessage({ channel: "sms", template, values: {}, settings, config: {} }).text, "Cześć\nSTOP kończy");
  const inherited = describeSmsTemplate({ id: "t2", name: "Plain", category: "marketing", language: "pl", status: "active", body: "Cześć", variables: [], sample_values: {} });
  assert.equal(renderMessagingMessage({ channel: "sms", template: inherited, values: {}, settings, config: {} }).text, "Cześć\nReply STOP to opt out");
});

test("a short opt-out footer is only skipped when it stands as its own line", () => {
  // "STOP" occurs inside ordinary words; treating that as an opt-out notice
  // would drop a footer the workspace requires.
  assert.equal(smsFooterPresent("Stop by our store today", "STOP"), false);
  assert.equal(smsFooterPresent("We are open nonstop", "STOP"), false);
  assert.equal(smsFooterPresent("Sale today\nSTOP", "STOP"), true);
  assert.equal(smsFooterPresent("Sale today STOP", "STOP"), true, "a trailing footer still counts");
  const composed = composeSmsMessage({ body: "Stop by our store today", values: {}, footerText: "STOP", requireFooter: true });
  assert.equal(composed.text, "Stop by our store today\nSTOP");
  assert.equal(composed.footerAppended, true);
  const already = composeSmsMessage({ body: "Sale today\nSTOP", values: {}, footerText: "STOP", requireFooter: true });
  assert.equal(already.footerAppended, false, "the footer is never doubled");
});

test("campaign rendering refuses a media header without media and marketing without consent", () => {
  const settings = { whatsapp: { allowed_template_categories: ["MARKETING", "UTILITY"], require_consent_for_marketing: true } };
  const base = { channel: "whatsapp", id: "t1", name: "Promo", category: "MARKETING", language: "en", status: "APPROVED", approved: true, header_format: "IMAGE", components: [], variables: [], body: "Hi" };
  const noMedia = renderMessagingMessage({ channel: "whatsapp", template: base, values: {}, settings, config: { consent: { field: "opt_in" } } });
  assert.equal(noMedia.ok, false);
  assert.equal(noMedia.reason, "header_media_required");
  const withMedia = { consent: { field: "opt_in" }, template: { whatsapp: { header_media: { type: "image", url: "https://example.com/a.jpg" } } } };
  assert.equal(renderMessagingMessage({ channel: "whatsapp", template: base, values: {}, settings, config: withMedia }).ok, true);
  const noConsent = renderMessagingMessage({ channel: "whatsapp", template: base, values: {}, settings, config: { ...withMedia, consent: { field: "" } } });
  assert.equal(noConsent.reason, "consent_field_required");
  const utility = renderMessagingMessage({ channel: "whatsapp", template: { ...base, category: "UTILITY" }, values: {}, settings, config: { ...withMedia, consent: { field: "" } } });
  assert.equal(utility.ok, true, "only marketing templates need the consent field");
});

test("email templates reject unsupported Liquid and map variables added by a subject override", () => {
  assert.equal(usesUnsupportedLiquid("Hi {{ first_name }}"), false);
  assert.equal(usesUnsupportedLiquid("Hi {{ first_name | upcase }}"), true, "filters are evaluated remotely, not here");
  assert.equal(usesUnsupportedLiquid("{% if vip %}Hi{% endif %}"), true);
  assert.equal(usesUnsupportedLiquid("Items {{ items[0] }}"), true);
  const template = describeEmailTemplate({ id: "e1", name: "Promo", subject: "Your order {{order_id}}", text_body: "Hi {{first_name}}" });
  assert.deepEqual(messagingTemplateVariableKeys(template), ["order_id", "first_name"]);
  const config = { template: { email: { subject_override: "Order {{order_id}} with {{promo_code}}" } } };
  assert.deepEqual(messagingTemplateVariableKeys(template, config), ["order_id", "first_name", "promo_code"]);
  assert.deepEqual(subjectOverrideVariables(template, config), ["promo_code"]);
  const settings = { email: { require_unsubscribe: false } };
  const rendered = renderMessagingMessage({ channel: "email", template, values: { order_id: "42", first_name: "Anna" }, settings, config });
  assert.equal(rendered.ok, false, "the override variable is reported instead of being blanked out");
  assert.deepEqual(rendered.missing, ["promo_code"]);
});
