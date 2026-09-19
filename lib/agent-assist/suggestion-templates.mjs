/**
 * Fast suggestion templates for Agent Assist (no LLM).
 *
 * Prefer these before calling Telnyx chat completions so the right panel
 * can update in milliseconds for standard intake questions.
 *
 * Resolution order (see resolveFastSuggestionTemplate):
 *  1. Explicit suggestionTemplate / "SAY:" hint on the workflow item
 *  2. slot_name map
 *  3. Label that is already a full question (ends with ?)
 *  4. Generic “Could you provide the …” phrasing for slots
 */

export const MEDICAL_TRANSPORT_SLOT_TEMPLATES = Object.freeze({
  // Caller Identification
  intent: "How can I help you today?",
  caller_first_name: "May I have your first name?",
  caller_last_name: "And your last name?",
  caller_facility: "What facility are you calling from?",
  callback_number: "In case we get disconnected, can I get a callback number?",
  // Pickup Information
  pickup_facility: "What's the name of the pickup facility?",
  pickup_address: "What's the address for the pickup location?",
  pickup_department: "Which department is the patient in?",
  pickup_room: "What's the room number?",
  pickup_bed: "Is there a bed number?",
  sending_physician: "Who is the sending physician?",
  // Destination Information
  destination_facility: "What's the name of the destination facility?",
  destination_address: "What's the address for the destination?",
  destination_department: "Which department will the patient be going to?",
  destination_room: "What's the room number?",
  destination_bed: "Is there a bed number assigned?",
  receiving_physician: "Who is the receiving physician?",
  transport_timing: "When does the patient need to be transported?",
  // Patient Information
  patient_name: "Can I have the patient's full name?",
  patient_dob: "Can I have the patient's date of birth?",
  patient_weight: "What's the patient's weight?",
  // Transport Details
  transport_reason: "What's the reason for transport today?",
  iv_count: "Does the patient have any IV drips, and if so, how many?",
  special_equipment: "Will the patient need any special equipment for transport, such as oxygen or a ventilator?",
  accompanying: "Are there any family members or other passengers accompanying the patient?",
  trip_notes: "Is there anything else the transport crew should know?",
  weather_declined: "Have any other air services declined for weather?",
  other_aircraft: "Is any other aircraft currently responding?",
});

const SAY_HINT_RE = /^\s*(?:say|script|suggest)\s*:\s*(.+)$/i;

export function slotNounPhrase(label) {
  const raw = String(label || "").trim();
  if (!raw || raw.endsWith("?")) return null;
  const phrase = raw
    .toLowerCase()
    .replace(/^patient\b(?!')/, "patient's")
    .replace(/\biv\b/g, "IV")
    .replace(/\bicu\b/g, "ICU")
    .replace(/\bdob\b/g, "DOB");
  return `the ${phrase}`;
}

export function phraseSlotCollection(label) {
  const raw = String(label || "").trim();
  if (!raw) return null;
  if (raw.endsWith("?")) return raw.charAt(0).toUpperCase() + raw.slice(1);
  return `Could you provide ${slotNounPhrase(label)}?`;
}

/**
 * Pull an explicit spoken script from workflow authoring fields.
 * Supports:
 *   - suggestionTemplate: "What's the callback number?"
 *   - prompt_hint / hints entry: "SAY: What's the callback number?"
 */
export function extractExplicitSuggestionScript({
  suggestionTemplate,
  itemPromptHint,
  itemHints,
} = {}) {
  const direct = String(suggestionTemplate || "").trim();
  if (direct) return direct;

  const candidates = [
    itemPromptHint,
    ...(Array.isArray(itemHints) ? itemHints : []),
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const match = candidate.match(SAY_HINT_RE);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

function interpolateTemplate(template, { agentName, brandName, prefilledSlots } = {}) {
  let text = String(template || "").trim();
  if (!text) return null;

  const agent = agentName && agentName !== "the agent" ? agentName : "your agent";
  const brand = brandName && brandName !== "the company" ? brandName : null;

  text = text
    .replace(/\{\{\s*agent_name\s*\}\}/gi, agent)
    .replace(/\{\{\s*brand_name\s*\}\}/gi, brand || "us")
    .replace(/\[Your Name\]/gi, agent)
    .replace(/\[Agent Name\]/gi, agent);

  if (prefilledSlots && typeof prefilledSlots === "object") {
    for (const [key, value] of Object.entries(prefilledSlots)) {
      if (value === null || value === undefined || value === "") continue;
      const re = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi");
      text = text.replace(re, String(value));
    }
  }

  return text.trim() || null;
}

/**
 * Resolve a fast suggestion without calling an LLM.
 * Returns null when the caller should fall through to AI wording.
 */
export function resolveFastSuggestionTemplate({
  itemType,
  itemLabel,
  slotName,
  suggestionTemplate,
  itemPromptHint,
  itemHints,
  targetMode,
  agentName,
  brandName,
  prefilledSlots,
  slotTemplates = MEDICAL_TRANSPORT_SLOT_TEMPLATES,
  allowGenericSlot = true,
} = {}) {
  // Confirmation / prerequisite wording stays in generate-suggestion route
  // (needs captured values / blocked item). Skip here for collect flows.
  if (targetMode === "confirm_slot" || targetMode === "collect_prerequisite") {
    return null;
  }

  const explicit = extractExplicitSuggestionScript({
    suggestionTemplate,
    itemPromptHint,
    itemHints,
  });
  if (explicit) {
    return interpolateTemplate(explicit, { agentName, brandName, prefilledSlots });
  }

  const key = String(slotName || "").trim();
  if (key && slotTemplates[key]) {
    return interpolateTemplate(slotTemplates[key], {
      agentName,
      brandName,
      prefilledSlots,
    });
  }

  if (!allowGenericSlot) return null;

  if (itemType === "slot") {
    return phraseSlotCollection(itemLabel);
  }

  const label = String(itemLabel || "").trim();
  if (label.endsWith("?")) {
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  return null;
}
