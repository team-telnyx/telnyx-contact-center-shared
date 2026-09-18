// Browser-safe WhatsApp template helpers shared by the administration builder,
// the agent template composer and the server validation. Mirrors the rules
// Meta applies to template definitions (variables, buttons, authentication).
import { TEMPLATE_LANGUAGES } from "../messaging/template-languages.mjs";
export const WHATSAPP_TEMPLATE_CATEGORIES = Object.freeze(["MARKETING", "UTILITY", "AUTHENTICATION"]);
export const WHATSAPP_TEMPLATE_HEADER_FORMATS = Object.freeze(["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT"]);
export const WHATSAPP_TEMPLATE_BUTTON_TYPES = Object.freeze(["QUICK_REPLY", "URL", "PHONE_NUMBER"]);
// Shared with the SMS template builder so both channels offer one list.
export const WHATSAPP_TEMPLATE_LANGUAGES = TEMPLATE_LANGUAGES;

export const templateComponent = (components = [], type) => (components || []).find((item) => String(item?.type || "").toUpperCase() === String(type).toUpperCase());
export const templateVariableIndexes = (text) => [...String(text || "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])).filter((v, i, all) => all.indexOf(v) === i).sort((a, b) => a - b);

export function templateBodyBoundaryError(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (/^\{\{\d+\}\}/.test(value)) return "Body text cannot start with a variable. Add text before the first {{n}} placeholder.";
  if (/\{\{\d+\}\}$/.test(value)) return "Body text cannot end with a variable. Add text or punctuation after the last {{n}} placeholder.";
  return "";
}
export function templateUrlButtonError(button = {}) {
  if (String(button.type || "").toUpperCase() !== "URL") return "";
  const url = String(button.url || "");
  const placeholders = [...url.matchAll(/\{\{(\d+)\}\}/g)];
  if (!placeholders.length) return "";
  if (placeholders.length !== 1 || Number(placeholders[0][1]) !== 1) return "Dynamic URL buttons have their own variable numbering and must use exactly {{1}}.";
  if (!url.endsWith("{{1}}")) return "The dynamic URL variable {{1}} must be placed at the end of the URL.";
  return "";
}
export const isAuthenticationTemplate = (template = {}) => String(template.category || "").toUpperCase() === "AUTHENTICATION"
  || (templateComponent(template.components, "BUTTONS")?.buttons || []).some((button) => String(button?.type || "").toUpperCase() === "OTP");

export function validateTemplateDefinitionComponents(components = [], category = "") {
  if (!Array.isArray(components)) return ["Template components must be an array."];
  const normalizedCategory = String(category || "").toUpperCase();
  const typeOf = (component) => String(component?.type || "").toUpperCase();
  const buttonsOf = () => templateComponent(components, "BUTTONS")?.buttons || [];
  if (normalizedCategory === "AUTHENTICATION" || (!normalizedCategory && buttonsOf().some((b) => typeOf(b) === "OTP"))) {
    const errors = [];
    const bodies = components.filter((c) => typeOf(c) === "BODY"), footers = components.filter((c) => typeOf(c) === "FOOTER"), buttons = components.filter((c) => typeOf(c) === "BUTTONS");
    if (components.some((c) => typeOf(c) === "HEADER")) errors.push("Authentication templates cannot include a header.");
    if (bodies.length !== 1) errors.push("Authentication templates require exactly one BODY component.");
    else if (bodies[0].text !== undefined || bodies[0].example !== undefined) errors.push("Authentication BODY must use Meta-generated text and cannot include text or example fields.");
    if (footers.length > 1) errors.push("Authentication templates can include at most one FOOTER component.");
    else if (footers.length === 1) {
      const minutes = Number(footers[0].code_expiration_minutes);
      if (footers[0].text !== undefined) errors.push("Authentication FOOTER cannot include custom text.");
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 90) errors.push("Authentication code expiration must be a whole number between 1 and 90 minutes.");
    }
    if (buttons.length !== 1) errors.push("Authentication templates require exactly one BUTTONS component.");
    else {
      const list = buttons[0].buttons || [];
      if (list.length !== 1 || typeOf(list[0]) !== "OTP" || String(list[0]?.otp_type || "").toUpperCase() !== "COPY_CODE") errors.push("Authentication templates require exactly one OTP copy-code button.");
      else if (!String(list[0]?.text || "").trim()) errors.push("Authentication copy-code button text is required.");
    }
    if (components.some((c) => !["BODY", "FOOTER", "BUTTONS"].includes(typeOf(c)))) errors.push("Authentication templates may only include BODY, FOOTER and BUTTONS components.");
    return errors;
  }
  const errors = [];
  const body = templateComponent(components, "BODY");
  if (!body || !String(body.text || "").trim()) errors.push("Body text is required.");
  const boundary = templateBodyBoundaryError(body?.text);
  if (boundary) errors.push(boundary);
  buttonsOf().forEach((button, index) => { const error = templateUrlButtonError(button); if (error) errors.push(`Button ${index + 1}: ${error}`); });
  return errors;
}

export function templateHeaderFormat(template) {
  const header = templateComponent(template?.components, "HEADER");
  if (!header) return "NONE";
  return String(header.format || (header.text ? "TEXT" : "NONE")).toUpperCase();
}

export function templatePreviewParts(template = {}) {
  const components = template.components || [];
  const header = templateComponent(components, "HEADER"), body = templateComponent(components, "BODY"), footer = templateComponent(components, "FOOTER");
  const buttons = templateComponent(components, "BUTTONS")?.buttons || [];
  if (!isAuthenticationTemplate(template)) return { header: header?.text || "", headerFormat: templateHeaderFormat(template), body: body?.text || "", footer: footer?.text || "", buttons };
  const minutes = Number(footer?.code_expiration_minutes);
  return { header: "", headerFormat: "NONE", body: `{{1}} is your verification code.${body?.add_security_recommendation ? " For your security, do not share this code." : ""}`,
    footer: Number.isInteger(minutes) && minutes > 0 ? `Expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.` : "", buttons };
}

// Variable fields an agent fills before sending a template.
export function templateVariableFields(template) {
  if (String(template?.category || "").toUpperCase() === "AUTHENTICATION") {
    return [{ key: "body:1", label: "OTP code", type: "body", parameterIndex: 1, defaultValue: "", copyCodeButtonIndex: 0 }];
  }
  const fields = [];
  for (const item of template?.components || []) {
    const type = String(item.type || "").toUpperCase();
    if (["HEADER", "BODY"].includes(type)) {
      const examples = type === "BODY" ? item.example?.body_text?.[0] || [] : item.example?.header_text || [];
      templateVariableIndexes(item.text).forEach((parameterIndex) => fields.push({ key: `${type.toLowerCase()}:${parameterIndex}`, label: `${type === "BODY" ? "Body" : "Header"} {{${parameterIndex}}}`,
        type: type.toLowerCase(), parameterIndex, defaultValue: examples[parameterIndex - 1] || "" }));
    }
    if (type === "BUTTONS") (item.buttons || []).forEach((button, buttonIndex) => {
      if (!String(button.url || "").includes("{{")) return;
      fields.push({ key: `button:${buttonIndex}`, label: `${button.text || `Button ${buttonIndex + 1}`} URL value`, type: "button", subType: "url", buttonIndex, defaultValue: button.example?.[0] || "" });
    });
  }
  return fields;
}

// Runtime components for POST /messages/whatsapp from the filled variables.
export function templateRuntimeComponents(fields, values, { mediaType = "", mediaUrl = "", filename = "" } = {}) {
  const grouped = new Map();
  for (const field of fields || []) {
    const key = field.type === "button" ? `button:${field.buttonIndex}` : field.type;
    if (!grouped.has(key)) grouped.set(key, { type: field.type, ...(field.type === "button" ? { sub_type: field.subType, index: field.buttonIndex } : {}), parameters: [] });
    grouped.get(key).parameters.push({ type: "text", text: String(values?.[field.key] ?? "") });
    if (Number.isInteger(field.copyCodeButtonIndex)) {
      const buttonKey = `button:${field.copyCodeButtonIndex}`;
      if (!grouped.has(buttonKey)) grouped.set(buttonKey, { type: "button", sub_type: "url", index: field.copyCodeButtonIndex, parameters: [] });
      grouped.get(buttonKey).parameters.push({ type: "text", text: String(values?.[field.key] ?? "") });
    }
  }
  const components = [...grouped.values()];
  const type = String(mediaType || "").toLowerCase();
  if (mediaUrl && ["image", "video", "document"].includes(type)) {
    components.unshift({ type: "header", parameters: [{ type, [type]: { link: mediaUrl, ...(type === "document" && filename ? { filename } : {}) } }] });
  }
  return components;
}

// Renders the template text with the agent's values for the message bubble.
export function renderTemplateText(template, values = {}) {
  const parts = templatePreviewParts(template);
  const fill = (text, scope) => String(text || "").replace(/\{\{(\d+)\}\}/g, (match, index) => values[`${scope}:${index}`] ?? match);
  return [parts.header && fill(parts.header, "header"), parts.body && fill(parts.body, "body"), parts.footer].filter(Boolean).join("\n");
}

const clone = (value) => (value ? JSON.parse(JSON.stringify(value)) : value);
// Template definition components from the administration form.
export function buildTemplateDefinitionComponents(form) {
  if (String(form.category || "").toUpperCase() === "AUTHENTICATION") {
    const components = [{ type: "BODY", ...(form.authenticationAddSecurityRecommendation ? { add_security_recommendation: true } : {}) }];
    if (form.authenticationCodeExpirationEnabled) components.push({ type: "FOOTER", code_expiration_minutes: Number(form.authenticationCodeExpirationMinutes) });
    components.push({ type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: String(form.authenticationCopyCodeText || "").trim() }] });
    return components;
  }
  const components = [];
  const format = String(form.headerFormat || "NONE").toUpperCase();
  const originalHeader = form.originalHeader || null;
  const originalFormat = String(originalHeader?.format || (originalHeader?.text ? "TEXT" : "NONE")).toUpperCase();
  const originalHandle = originalHeader?.example?.header_handle?.[0] || "";
  if (format === "TEXT" && String(form.headerText || "").trim()) {
    const variables = templateVariableIndexes(form.headerText);
    components.push({ type: "HEADER", format: "TEXT", text: form.headerText, ...(variables.length ? { example: { header_text: variables.map((index) => form.variableExamples?.[`header:${index}`] || "") } } : {}) });
  } else if (format !== "NONE" && format !== "TEXT") {
    const handle = String(form.headerMediaHandle || "");
    if (originalHeader && originalFormat === format && handle === originalHandle) components.push(clone(originalHeader));
    else components.push({ type: "HEADER", format, ...(handle ? { example: { header_handle: [handle] } } : {}) });
  }
  const bodyVariables = templateVariableIndexes(form.bodyText);
  components.push({ type: "BODY", text: form.bodyText, ...(bodyVariables.length ? { example: { body_text: [bodyVariables.map((index) => form.variableExamples?.[`body:${index}`] || "")] } } : {}) });
  if (String(form.footerText || "").trim()) components.push({ type: "FOOTER", text: form.footerText });
  if (form.buttons?.length) components.push({ type: "BUTTONS", buttons: form.buttons.map((button, index) => {
    if (button.type === "URL") return { type: "URL", text: button.text, url: button.url, ...(String(button.url).includes("{{") ? { example: [form.variableExamples?.[`button:${index}`] || "example"] } : {}) };
    if (button.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text: button.text, phone_number: button.phoneNumber };
    if (button.type === "OTP") return { type: "OTP", otp_type: "COPY_CODE", text: button.text || "Copy Code" };
    return { type: "QUICK_REPLY", text: button.text };
  }) });
  return components;
}

// Form state from an existing template definition (edit mode).
export function templateFormFromDefinition(template = {}) {
  const components = template.components || [];
  const header = templateComponent(components, "HEADER"), body = templateComponent(components, "BODY"), footer = templateComponent(components, "FOOTER");
  const buttons = templateComponent(components, "BUTTONS")?.buttons || [];
  const examples = {};
  (body?.example?.body_text?.[0] || []).forEach((value, index) => { examples[`body:${templateVariableIndexes(body?.text)[index] ?? index + 1}`] = value; });
  (header?.example?.header_text || []).forEach((value, index) => { examples[`header:${templateVariableIndexes(header?.text)[index] ?? index + 1}`] = value; });
  buttons.forEach((button, index) => { if (button.example?.[0]) examples[`button:${index}`] = button.example[0]; });
  return {
    name: template.name || "", category: String(template.category || "UTILITY").toUpperCase(), language: template.language || "en_US",
    headerFormat: templateHeaderFormat(template), headerText: header?.text || "", headerMediaHandle: header?.example?.header_handle?.[0] || "", originalHeader: header ? clone(header) : null,
    bodyText: body?.text || "", footerText: footer?.text || "", variableExamples: examples,
    buttons: buttons.filter((b) => String(b.type || "").toUpperCase() !== "OTP").map((b) => ({ type: String(b.type || "QUICK_REPLY").toUpperCase(), text: b.text || "", url: b.url || "", phoneNumber: b.phone_number || "" })),
    authenticationAddSecurityRecommendation: Boolean(body?.add_security_recommendation), authenticationCodeExpirationEnabled: Number.isInteger(Number(footer?.code_expiration_minutes)) && Number(footer?.code_expiration_minutes) > 0,
    authenticationCodeExpirationMinutes: Number(footer?.code_expiration_minutes) || 10, authenticationCopyCodeText: buttons.find((b) => String(b.type || "").toUpperCase() === "OTP")?.text || "Copy code",
  };
}
export const EMPTY_TEMPLATE_FORM = Object.freeze({ name: "", category: "UTILITY", language: "en_US", headerFormat: "NONE", headerText: "", headerMediaHandle: "", originalHeader: null, bodyText: "", footerText: "",
  variableExamples: {}, buttons: [], authenticationAddSecurityRecommendation: true, authenticationCodeExpirationEnabled: true, authenticationCodeExpirationMinutes: 10, authenticationCopyCodeText: "Copy code" });
