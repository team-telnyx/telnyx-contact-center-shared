/**
 * Fast suggestion templates for Agent Assist (no LLM).
 *
 * Prefer these before calling Telnyx chat completions so the right panel
 * can update in milliseconds for standard intake questions.
 *
 * Resolution order (see resolveFastSuggestionTemplate):
 *  1. Explicit suggestionTemplate / "SAY:" hint on the workflow item
 *  2. GMR (or other) slot_name map
 *  3. Label that is already a full question (ends with ?)
 *  4. Generic “Could you provide the …” phrasing for slots
 */

export const GMR_SLOT_SUGGESTION_TEMPLATES = Object.freeze({
  caller_first_name: "Could you provide the caller's first name?",
  caller_last_name: "Could you provide the caller's last name?",
  callback_number: "What's a good callback number for you?",
  caller_facility: "Which facility are you calling from?",
  intent: "How can I help you today — new transport, status check, or something else?",
  pickup_facility: "What's the pickup facility name?",
  pickup_location: "Which department, room, or unit is the pickup from?",
  destination_facility: "What's the destination facility name?",
  transport_timing: "When does the patient need to be transported?",
  patient_name: "What is the patient's full name?",
  patient_dob: "What is the patient's date of birth?",
  patient_weight: "What is the patient's weight?",
  transport_reason: "What is the reason for transport?",
  iv_count: "How many IV drips does the patient have?",
  special_equipment: "Is any special equipment needed?",
  accompanying: "Will anyone be accompanying the patient?",
  weather_declined: "Has any air service declined this trip for weather?",
  other_aircraft: "Are any other aircraft currently responding?",
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
  slotTemplates = GMR_SLOT_SUGGESTION_TEMPLATES,
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
