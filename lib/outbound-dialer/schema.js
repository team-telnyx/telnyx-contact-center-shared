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
