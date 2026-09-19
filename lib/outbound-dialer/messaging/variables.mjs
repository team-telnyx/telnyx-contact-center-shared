// Browser-safe variable mapping for messaging campaigns: template variables are
// filled from contact-list columns, contact-method slots, static text or system
// values. Named ({{first_name}}) and positional (body:1) variables share one shape.
export const VARIABLE_SOURCES = Object.freeze(["contact_field", "contact_method", "static", "system"]);

export const SYSTEM_VARIABLES = Object.freeze([
  { key: "campaign_name", label: "Campaign name" },
  { key: "sender_address", label: "Sender number or address" },
  { key: "today", label: "Today's date" },
  { key: "opt_out_instructions", label: "Opt-out instructions (SMS)" },
  { key: "unsubscribe_url", label: "Unsubscribe link (email)" },
]);

export const MISSING_VARIABLE_POLICIES = Object.freeze(["skip", "fallback", "send_blank"]);

const normalizeName = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const ALIASES = {
  firstname: ["first", "givenname", "name"],
  lastname: ["last", "surname", "familyname"],
  displayname: ["fullname", "name"],
  company: ["companyname", "organisation", "organization"],
  phone: ["phonenumber", "mobile", "msisdn", "tel"],
  email: ["emailaddress", "mail"],
};

export function normalizeVariableMapping(mapping = []) {
  const seen = new Set();
  return (Array.isArray(mapping) ? mapping : []).map((row) => {
    const key = String(row?.key ?? row?.variable ?? "").trim();
    const source = VARIABLE_SOURCES.includes(row?.source) ? row.source : "contact_field";
    return {
      key,
      source,
      value: String(row?.value ?? row?.field ?? "").trim().slice(0, 1000),
      fallback: String(row?.fallback ?? "").trim().slice(0, 500),
    };
  }).filter((row) => row.key && !seen.has(row.key) && seen.add(row.key));
}

// Keep rows for variables that still exist and add empty rows for new ones so
// the editor always shows every variable a template needs.
export function mergeVariableMapping(existing = [], variableKeys = []) {
  const current = normalizeVariableMapping(existing);
  const keys = [...new Set((Array.isArray(variableKeys) ? variableKeys : []).map((key) => String(key || "").trim()).filter(Boolean))];
  return keys.map((key) => current.find((row) => row.key === key) || { key, source: "contact_field", value: "", fallback: "" });
}

// Propose contact fields for variables by normalized name and common aliases.
export function autoMapVariables(variableKeys = [], fieldNames = [], existing = []) {
  const fields = (Array.isArray(fieldNames) ? fieldNames : []).map((name) => String(name || "").trim()).filter(Boolean);
  const byNormalized = new Map(fields.map((name) => [normalizeName(name), name]));
  return mergeVariableMapping(existing, variableKeys).map((row) => {
    if (row.value) return row;
    const wanted = normalizeName(row.key.replace(/^(body|header|button):\d+$/, ""));
    if (!wanted) return row;
    const direct = byNormalized.get(wanted);
    if (direct) return { ...row, source: "contact_field", value: direct };
    const alias = (ALIASES[wanted] || []).map((candidate) => byNormalized.get(candidate)).find(Boolean);
    return alias ? { ...row, source: "contact_field", value: alias } : row;
  });
}

const slotValue = (contactMethods = {}, slot = "") => {
  const [group, name] = String(slot || "").split(":");
  const value = contactMethods?.[group]?.[name];
  return value == null ? "" : String(value).trim();
};

const stringValue = (value) => {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
};

// Resolve every mapped variable for one contact. Missing values honour the
// fallback first; the caller decides what a remaining gap means (skip / blank).
export function resolveVariableValues(mapping = [], { rowData = {}, contactMethods = {}, system = {} } = {}) {
  const values = {};
  const missing = [];
  for (const row of normalizeVariableMapping(mapping)) {
    let resolved = "";
    if (row.source === "contact_field") resolved = stringValue(rowData?.[row.value]);
    else if (row.source === "contact_method") resolved = slotValue(contactMethods, row.value);
    else if (row.source === "static") resolved = row.value;
    else if (row.source === "system") resolved = stringValue(system?.[row.value]);
    if (!resolved && row.fallback) resolved = row.fallback;
    if (!resolved) missing.push(row.key);
    values[row.key] = resolved;
  }
  return { values, missing };
}

export function systemVariableValues({ campaign, senderAddress, optOutInstructions, unsubscribeUrl, timezone, now = new Date() } = {}) {
  let today;
  try { today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
  catch { today = now.toISOString().slice(0, 10); }
  return {
    campaign_name: campaign?.name || "",
    sender_address: senderAddress || "",
    today,
    opt_out_instructions: optOutInstructions || "",
    unsubscribe_url: unsubscribeUrl || "",
  };
}

// Named {{variable}} placeholders of an e-mail subject or body. The campaign
// editor and the server-side renderer share this, so the variables a campaign
// must map are exactly the ones the runner substitutes.
export const EMAIL_VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

export function extractEmailTemplateVariables(...sources) {
  const names = [];
  for (const source of sources) for (const match of String(source || "").matchAll(EMAIL_VARIABLE_PATTERN)) if (!names.includes(match[1])) names.push(match[1]);
  return names;
}

const variableKey = (variable) => (typeof variable === "string" ? variable : variable?.key);

/**
 * Variables an e-mail campaign adds by overriding the subject. They are not in
 * the stored template, so without this they would never be mapped, never be
 * reported as missing, and would be blanked out of every sent subject.
 */
export function subjectOverrideVariables(template, config = {}) {
  if (template?.channel !== "email") return [];
  const override = String(config?.template?.email?.subject_override || "").trim();
  if (!override) return [];
  const known = new Set((template.variables || []).map(variableKey));
  return extractEmailTemplateVariables(override).filter((key) => !known.has(key));
}

/** The variables a campaign has to map: the template's, plus the subject-only ones when the campaign config is given. */
export function messagingTemplateVariableKeys(template, config = null) {
  const keys = (template?.variables || []).map(variableKey).filter(Boolean);
  return config ? [...keys, ...subjectOverrideVariables(template, config)] : keys;
}
