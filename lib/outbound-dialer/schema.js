export const OUTBOUND_CHANNELS = ["voice", "sms", "whatsapp"];

export const OUTBOUND_CAMPAIGN_MODES = [
  "preview",
  "progressive",
  "agentless_ai",
  "agentless_flow",
  "power",
  "predictive",
];

export const OUTBOUND_HANDLER_TYPES = ["queue", "ai_assistant", "call_flow"];

export const OUTBOUND_CONTACT_FIELD_TYPES = [
  "text",
  "boolean",
  "number",
  "date",
  "datetime",
  "enum",
  "select",
  "phone",
  "email",
  "first_name",
  "last_name",
  "display_name",
  "company",
  "url",
  "currency",
];

export const OUTBOUND_STANDARD_CONTACT_COLUMNS = [
  { name: "first_name", type: "text", required: false },
  { name: "last_name", type: "text", required: false },
  { name: "phone_number", type: "phone", required: true },
  { name: "email", type: "email", required: false },
  { name: "timezone", type: "text", required: false },
  { name: "country", type: "text", required: false },
  { name: "consent_status", type: "select", required: true },
  { name: "last_attempt_at", type: "datetime", required: false },
];

const CONTACT_FIELD_TYPE_ALIASES = {
  firstname: "first_name",
  first_name: "first_name",
  first: "first_name",
  lastname: "last_name",
  last_name: "last_name",
  last: "last_name",
  displayname: "display_name",
  display_name: "display_name",
  name: "display_name",
  companyname: "company",
  company_name: "company",
  company: "company",
};

export function normalizeContactFieldType(type, fallback = "text") {
  const raw = String(type || "").trim();
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (OUTBOUND_CONTACT_FIELD_TYPES.includes(normalized)) return normalized;
  const compact = normalized.replace(/_/g, "");
  return CONTACT_FIELD_TYPE_ALIASES[normalized] || CONTACT_FIELD_TYPE_ALIASES[compact] || fallback;
}

export function normalizeContactFieldSchema(schema = []) {
  const seen = new Set();
  return (Array.isArray(schema) ? schema : [])
    .map((field) => {
      const name = String(field?.name || "").trim();
      return {
        name,
        type: normalizeContactFieldType(field?.type),
        required: Boolean(field?.required),
        label: String(field?.label || name).trim() || name,
      };
    })
    .filter((field) => field.name && !seen.has(field.name) && seen.add(field.name));
}

export function createDefaultOutboundCampaign(overrides = {}) {
  return {
    name: "Untitled outbound campaign",
    status: "draft",
    channel: "voice",
    mode: "preview",
    handler_type: "queue",
    handler_ref: "",
    contact_list_id: null,
    attached_form_id: null,
    pacing_config: { strategy: "per_available_agent", ratio: 1, supervisorApproval: true },
    concurrency_config: { maxConcurrent: 10, perAgentLimit: 1 },
    dialing_windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "18:00", timezonePolicy: "contact" }],
    retry_policy: { maxAttempts: 4, minDelayHours: 6, exhaustAfterDays: 7 },
    amd_config: { enabled: true, humanConfidenceThreshold: 0.74, voicemailAction: "hangup" },
    form_variable_mapping: [],
    metadata: {},
    ...overrides,
  };
}
