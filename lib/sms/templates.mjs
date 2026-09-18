// Browser-safe SMS template helpers shared by Admin → SMS → Templates, the
// campaign editor preview and the broadcast runner. Variables use the same
// {{name}} syntax as voice flows and forms; positional numbering is not used.
import { smsSegments, SMS_MAX_PARTS } from "./segments.mjs";
import { smsError, SMS_MAX_BODY_CHARS } from "./policy.mjs";
import { normalizeTemplateLanguage } from "../messaging/template-languages.mjs";

export const SMS_TEMPLATE_CATEGORIES = Object.freeze(["marketing", "utility", "service"]);
export const SMS_TEMPLATE_STATUSES = Object.freeze(["active", "archived"]);
export const SMS_TEMPLATE_FOOTER_MODES = Object.freeze(["inherit", "none"]);
export const SMS_FOOTER_MAX_CHARS = 120;
export const EMPTY_SMS_TEMPLATE = Object.freeze({ name: "", category: "marketing", language: "en", body: "", footer_mode: "inherit", footer_text: "", sample_values: {}, status: "active" });

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

export function extractSmsTemplateVariables(body) {
  const names = [];
  for (const match of String(body || "").matchAll(VARIABLE_PATTERN)) if (!names.includes(match[1])) names.push(match[1]);
  return names;
}

// Substitute {{name}} references. Unknown variables stay literal and are
// reported so the caller can apply the campaign's missing-variable policy.
export function renderSmsTemplateBody(body, values = {}) {
  const missing = [];
  const text = String(body || "").replace(VARIABLE_PATTERN, (match, name) => {
    const value = values?.[name];
    if (value == null || String(value).trim() === "") { if (!missing.includes(name)) missing.push(name); return match; }
    return String(value);
  });
  return { text, missing };
}

/**
 * Which opt-out footer a message actually carries, and why.
 *
 * `footerText` is the workspace footer from Dialer → Settings → Messaging;
 * `templateFooterText` overrides it for one template. Choosing "no footer"
 * removes it unless the workspace requires one for compliance, and that case is
 * reported as `required` so the builder can explain it instead of silently
 * contradicting the selected mode.
 */
export function smsFooterDecision({ footerMode = "inherit", requireFooter = true, footerText = "", templateFooterText = "" } = {}) {
  const text = String(templateFooterText || "").trim() || String(footerText || "").trim();
  if (!text) return { text: "", reason: "none" };
  if (footerMode !== "none") return { text, reason: "template" };
  return requireFooter ? { text, reason: "required" } : { text: "", reason: "none" };
}

export function smsFooterText(options = {}) {
  return smsFooterDecision(options).text;
}

/**
 * Whether the message already carries the footer. It counts only as its own
 * line or as the tail of the message, never as any occurrence in running text:
 * a short custom footer such as "STOP" appears inside ordinary words
 * ("nonstop", "Stop by our store"), and treating that as an opt-out notice
 * would drop a legally required footer.
 */
export function smsFooterPresent(text, footer) {
  const needle = String(footer || "").trim().toLowerCase();
  if (!needle) return false;
  const body = String(text || "").trimEnd().toLowerCase();
  if (body.split("\n").some((line) => line.trim() === needle)) return true;
  // A footer written into the last line counts too, but only on a word
  // boundary: "nonstop" must not pass for a footer of "STOP".
  if (!body.endsWith(needle)) return false;
  const before = body.slice(0, body.length - needle.length).slice(-1);
  return before === "" || !/[\p{L}\p{N}]/u.test(before);
}

// Final message text with the opt-out footer appended, plus its segment stats.
export function composeSmsMessage({ body, values = {}, footerMode = "inherit", requireFooter = true, footerText = "", templateFooterText = "", blankMissing = false } = {}) {
  const rendered = renderSmsTemplateBody(body, values);
  let text = blankMissing ? rendered.text.replace(VARIABLE_PATTERN, "") : rendered.text;
  const decision = smsFooterDecision({ footerMode, requireFooter, footerText, templateFooterText });
  const appended = Boolean(decision.text) && !smsFooterPresent(text, decision.text);
  if (appended) text = `${text.trimEnd()}\n${decision.text}`;
  return { text, missing: rendered.missing, footer: decision.text, footerReason: decision.reason, footerAppended: appended, segments: smsSegments(text) };
}

export function normalizeSmsTemplateInput(input = {}) {
  const name = String(input.name || "").trim().slice(0, 120);
  if (!name) throw smsError("Template name is required");
  const body = String(input.body || "").replace(/\r\n/g, "\n").trim();
  if (!body) throw smsError("Template text is required");
  if (body.length > SMS_MAX_BODY_CHARS) throw smsError(`Template text is limited to ${SMS_MAX_BODY_CHARS} characters`);
  const category = SMS_TEMPLATE_CATEGORIES.includes(input.category) ? input.category : "marketing";
  const language = normalizeTemplateLanguage(input.language, "en");
  const footerMode = SMS_TEMPLATE_FOOTER_MODES.includes(input.footer_mode) ? input.footer_mode : "inherit";
  // Empty keeps the workspace footer; a value overrides it for this template.
  const footer_text = String(input.footer_text || "").replace(/\s+/g, " ").trim().slice(0, SMS_FOOTER_MAX_CHARS);
  const status = SMS_TEMPLATE_STATUSES.includes(input.status) ? input.status : "active";
  const variables = extractSmsTemplateVariables(body);
  const sampleSource = input.sample_values && typeof input.sample_values === "object" ? input.sample_values : {};
  const sample_values = Object.fromEntries(variables.map((variable) => [variable, String(sampleSource[variable] ?? "").slice(0, 200)]));
  const segments = smsSegments(body);
  if (segments.parts > SMS_MAX_PARTS) throw smsError(`The template would need ${segments.parts} parts; shorten it to at most ${SMS_MAX_PARTS}`);
  return { name, category, language, body, footer_mode: footerMode, footer_text, status, variables, sample_values };
}
