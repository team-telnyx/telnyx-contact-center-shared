const CONTACT_VARIABLE_FIELDS = [
  "first_name",
  "last_name",
  "display_name",
  "company_name",
  "job_title",
  "department",
  "phone",
  "mobile",
  "email_address_1",
  "email_address_2",
  "address_street",
  "address_city",
  "address_state",
  "address_zip",
  "address_country",
  "notes",
];

export function clampContactMemoryLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(5, Math.max(1, parsed)) : 5;
}

export function extractDynamicVariablesTarget(body) {
  if (body?.data?.event_type !== "assistant.initialization") return "";
  return String(body?.data?.payload?.telnyx_end_user_target || "").trim();
}

export function normalizeContactTarget(value) {
  const target = String(value || "").trim();
  if (target.includes("@")) return { raw: target, email: target.toLowerCase(), digits: "" };
  return { raw: target, email: "", digits: target.replace(/\D/g, "") };
}

export function contactToDynamicVariables(contact) {
  if (!contact) return {};
  const variables = { contact_id: contact.id };
  for (const field of CONTACT_VARIABLE_FIELDS) {
    const value = contact[field];
    if (value !== null && value !== undefined && value !== "") variables[field] = value;
  }
  const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
  if (fullName) variables.full_name = fullName;
  return variables;
}

export function buildContactDynamicVariablesResponse({ contact, target, limit }) {
  const memoryLimit = clampContactMemoryLimit(limit);
  const safeTarget = String(target || "").replace(/[&\r\n]/g, "");
  const metadata = { telnyx_end_user_target: safeTarget };
  const filter = contact?.id
    ? `metadata->contact_id=eq.${contact.id}`
    : `metadata->telnyx_end_user_target=eq.${safeTarget}`;
  if (contact?.id) metadata.contact_id = contact.id;

  return {
    dynamic_variables: contactToDynamicVariables(contact),
    memory: {
      conversation_query: `${filter}&limit=${memoryLimit}&order=last_message_at.desc`,
    },
    conversation: { metadata },
  };
}
