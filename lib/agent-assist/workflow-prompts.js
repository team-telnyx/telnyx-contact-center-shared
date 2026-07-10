/**
 * Workflow Analysis Prompt Templates
 * 
 * Generates prompts for GPT-4o to analyze transcripts and detect
 * workflow item completion and slot extraction.
 */

function formatCompletionTrigger(trigger) {
  if (trigger === "customer") return "Customer only";
  if (trigger === "either") return "Either speaker";
  return "Agent only";
}

/**
 * Build the system prompt for workflow analysis
 * @param {Object} options - Prompt options
 * @param {Array} options.pendingItems - Array of pending workflow items
 * @param {Object} options.slotsFilled - Already filled slots
 * @param {boolean} [options.includeIntent] - Include intent detection in response
 * @param {boolean} [options.includeSentiment] - Include sentiment analysis in response
 * @returns {string} System prompt
 */
export function buildWorkflowAnalysisSystemPrompt({
  pendingItems,
  slotsFilled,
  includeIntent = false,
  includeSentiment = false,
  confidenceThreshold = 0.95,
  currentTarget = null,
}) {
  // The app marks a slot "low-confidence" (and shows alternative chips) when the
  // returned confidence is below the workflow's threshold — so alternatives must
  // be requested against that threshold, not the model's subjective "confident".
  const alternativesThreshold =
    typeof confidenceThreshold === "number" && confidenceThreshold > 0 && confidenceThreshold <= 1
      ? confidenceThreshold
      : 0.95;

  const itemsList = pendingItems.map((item, index) => {
    let itemDesc = `${index + 1}. ID: ${item.item_id}
   Type: ${item.type}
   Label: "${item.label}"
   Stage: ${item.stage_name}`;
    
    if (item.prompt_hint) {
      itemDesc += `\n   Detection hints: "${item.prompt_hint}"`;
    }

    itemDesc += `\n   Completion trigger: ${formatCompletionTrigger(item.completion_trigger)}`;
    
    if (item.type === "slot") {
      itemDesc += `\n   Slot: ${item.slot_name} (${item.slot_type || "text"})`;
      if (Array.isArray(item.slot_options) && item.slot_options.length > 0) {
        itemDesc += `\n   Allowed options (choose the closest match): ${item.slot_options.join(", ")}`;
      }
      if (item.slot_validation) {
        itemDesc += `\n   Validation: ${item.slot_validation}`;
      }
    }
    
    return itemDesc;
  }).join("\n\n");

  const filledSlotsStr = Object.keys(slotsFilled).length > 0
    ? JSON.stringify(slotsFilled, null, 2)
    : "None yet";

  // The slot the agent is currently collecting (the earliest open slot). Used to
  // disambiguate an answer whose surface form could match several slots — e.g. a
  // destination hospital that STT mangled into something that looks like a
  // person's name must fill the facility slot, not a patient-name slot.
  const focusLabel = currentTarget && (currentTarget.label || currentTarget.slotName);
  const currentFocusStr = focusLabel
    ? `\n\n## Current Collection Focus\n\nThe agent is currently asking the customer for: **${currentTarget.label || currentTarget.slotName}**${currentTarget.slotName ? ` (slot: \`${currentTarget.slotName}\`)` : ""}.\n\n- Treat the customer's direct answer as the value for THIS slot when it plausibly fits, before matching it to any other pending slot.\n- The surface form can mislead, especially with speech-to-text errors: a facility/organization name may sound like a person's name (e.g. a destination hospital heard as "John Meyer" / "John Miller" is really "John Muir Hospital") — assign it to the facility/location slot, NOT a patient-name or caller-name slot. A name given while the focus is a facility/location slot is almost always that facility.\n- If the focus slot is a yes/no (boolean) slot, a bare affirmative or negative from the customer ("yes" / "yeah" / "correct" / "no" / "nope" / "none" / "not that we know of") is the answer to THIS slot — return it as the boolean value for the focus slot (yes -> true, no -> false), not for a different yes/no slot elsewhere. A "no" is a real captured value (false), not a missing answer.\n- This focus is a tie-breaker for ambiguous answers, not a hard filter: still capture a value the customer CLEARLY volunteers for a different, explicitly-named slot (e.g. "the patient's date of birth is ...").`
    : "";

  const extraFields = [];
  if (includeIntent) {
    extraFields.push(`  "detected_intent": "brief intent description (2-3 words)"`);
  }
  if (includeSentiment) {
    extraFields.push(`  "sentiment": "positive|neutral|negative"`);
    extraFields.push(`  "sentiment_score": 50`);
  }
  const extraFieldsStr = extraFields.length > 0
    ? `,\n${extraFields.join(",\n")}`
    : "";

  const extraInstructions = [
    includeIntent ? "Include detected_intent only when the transcript clearly indicates the caller or agent intent." : null,
    includeSentiment ? "Include sentiment and sentiment_score based only on the current transcription segment. Judge sentiment from the caller's EMOTIONAL STATE (calm, cooperative, frustrated, distressed), NOT from the grammatical polarity of a factual answer. A factual or operational/clinical NEGATIVE is neutral, not negative — a plain \"no\" to an intake question carries no bad sentiment. Treat these as NEUTRAL: \"No other aircraft are responding\", \"No air service declined\", \"No one is accompanying the patient\", \"No isolation precautions\", \"No known allergies\", \"No\". Only use negative sentiment when the caller actually expresses dissatisfaction, urgency, distress, anger, or a problem (e.g. \"this is taking too long\", \"the patient is crashing\")." : null,
  ].filter(Boolean).join("\n");

  return `You are an expert contact center AI assistant that analyzes customer service call transcriptions.
Your task is to analyze each transcription segment and determine which workflow items have been completed.

## Workflow Context

**Pending Items to Detect:**
${itemsList}

**Previously Filled Slots:**
${filledSlotsStr}${currentFocusStr}

## Detection Guidelines

1. **Action items** - Detect when the agent performs or mentions the action
   - Example: "Thank you for calling" -> greeting action completed
   - Example: "My name is John" -> introduce yourself action completed

2. **Question items** - Detect when the question is asked (by agent) or answered (by customer)
   - Example: "Can I verify your account?" -> verification question asked

3. **Topic items** - Detect when the topic is discussed
   - Example: Discussion about billing issue -> billing topic addressed

4. **Speaker trigger rule** - Only evaluate an item when the transcript speaker matches its Completion trigger
   - Customer trigger: only customer/inbound statements can complete or suggest the item
   - Agent trigger: only agent/outbound statements can complete or suggest the item
   - Either trigger: either speaker can complete or suggest the item

5. **Slot items** - Extract specific values from the conversation
   - Example: "My name is John Smith" -> customer_name = "John Smith"
   - Example: "Account number is 123456" -> account_number = "123456"
   - For slot items, extracted_value must be a non-empty concrete value from the matching speaker
   - Do not complete a slot when the transcript only asks for the value; wait for the matching speaker to provide the answer
   - Use the validation pattern if provided to verify extracted values

## Slot Value Extraction Rules

- **Match each value to the correct slot.** Assign a value only to the slot whose Label/hints describe it. NEVER place an answer in an unrelated slot. If a provided value does not match any pending slot, omit it instead of forcing it into a different slot. Example: a sending/receiving physician's name must NOT fill a patient-name slot; a department name must NOT fill a "reason for transport" slot.
- **One utterance can fill multiple slots.** When a single statement contains values for several pending slots, return a SEPARATE completed_items entry for each. Example: "ICU, room 412, bed B" -> department="ICU", room="412", bed="B". Example: "Michael Anderson, born March 12 1968" -> patient name AND date of birth.
- **Names:** When SEPARATE first-name and last-name slots both exist and the caller gives a full name, split it — the final word is the last name and the remaining word(s) are the first name (e.g., "Sarah Thompson" -> first="Sarah", last="Thompson"; "Mary Jo Cline" -> first="Mary Jo", last="Cline"). If only a single combined name slot exists, use the whole name.
- **Boolean slots (type "boolean"):** interpret the answer as true/false. Affirmatives (yes, yeah, correct, we do, there is) -> true. Negatives (no, none, nobody, we don't, there isn't) -> false. A negative answer IS a valid captured value (false) — capture it; do NOT treat "no" as missing or as a problem. Applies e.g. to accompanying-person and air-safety questions ("No other aircraft responding" -> false; "No isolation precautions" -> false).
- **Number slots:** extract the numeric value only (e.g., "two IV drips" -> 2).
- **Date slots:** normalize to ISO YYYY-MM-DD when the full date is determinable (e.g., "March 12, 1968" -> "1968-03-12").
- **Select slots:** choose the closest matching option from the slot's allowed options when options are provided.
- **Free-text notes / details slots.** For a free-text notes/comments/details slot (e.g. "Trip notes", "Additional details", "Special instructions"), capture the customer's relevant statement(s) VERBATIM as the value, even when the answer is a full conversational sentence rather than a discrete datum. Do not require the answer to look like structured data, and do not drop it for length — capture the whole note. Example: asked for trip notes, "He is stable right now, but they want him moved quickly" -> extracted_value "He is stable right now, but they want him moved quickly". When the note spans several utterances, each substantive utterance is a valid value for the same slot (the app accumulates them).
- **No information available.** When the customer clearly says they do NOT have or know the value being asked (e.g., "I don't have a room yet", "no room/bed assigned", "not sure", "unknown", "none yet", "N/A", "to be determined"), that IS a valid captured value: return the slot's \`extracted_value\` as \`"N/A"\` so the workflow can advance instead of stalling on a value that does not exist. Apply this ONLY to the slot currently being collected — never mark an unrelated slot "N/A". Do not use "N/A" when the customer simply hasn't answered yet or is still thinking.

## Alternatives (for low-confidence slots)

For every slot you return, also include an \`alternatives\` array so the agent can confirm or pick a value:
- **Empty array \`[]\`** only when your \`confidence\` for that slot is **>= ${alternativesThreshold}**.
- **2-3 candidate entries** whenever your \`confidence\` is **below ${alternativesThreshold}** (the app treats those as low-confidence and shows the alternatives), or when the value is a mishearing / ambiguous / has multiple plausible readings — each shaped as \`{ "value": ..., "confidence": ... }\`, sorted by descending confidence.
- Each alternative \`value\` must be normalized the same way as the primary \`extracted_value\`; each \`confidence\` is a number between 0 and 1.
- Alternatives are suggestions for the agent to confirm or choose from; they never override the primary \`extracted_value\`. Example: heard "I see you" for a department -> extracted_value "ICU", alternatives [{ "value": "CCU", "confidence": 0.4 }].

## Speech-to-Text Mishearing Tolerance

The transcript is machine-generated and often contains phonetic errors, especially for short medical terms, acronyms, and single letters. Interpret an obvious mishearing as the intended in-domain value **when the slot's Label/hints/options make the intended value clear**; otherwise keep the literal transcript. Do NOT invent values.

- **Acronyms / departments:** "I see you" / "icu" / "I.C.U." -> "ICU"; "e.d." / "eddie" -> "ED"; "see see you" -> "CCU"; "oh R" -> "OR"; "add mission" -> "admission".
- **Single-letter bed / room designations:** the caller often spells one letter. "bed be" / "bedby" / "bed bee" / "the bed is b" -> "B"; "bed see" -> "C"; "bed dee" -> "D". Only reduce to just the letter/number for a slot **dedicated** to a single bed or room designation. For a **combined** location slot (e.g. one labeled "department/room" or "pickup location"), keep the full value — "ICU room 412 bed B" -> "ICU room 412 bed B", not just "B".
- **Numbers said as words** -> digits (e.g., "four twelve" for a room -> "412").
- Only apply a correction when the expected slot type/options make the intended term unambiguous. When unsure, prefer a lower confidence over guessing.

## Confidence Scoring

Return a confidence score from 0.0 to 1.0 that reflects how certain you are that the transcript supports this workflow item or slot value.

- Use high confidence only when the transcript explicitly and clearly supports the item/value.
- Use lower confidence when the value is inferred, ambiguous, partially heard, or context-dependent.
- Do not decide whether an item is completed or suggested. The application will compare your confidence score against the workflow's configured confidence threshold.
- Include detected slot values when there is meaningful evidence in the transcript, even if confidence is low.
- Do not include items with no transcript evidence.

## Response Format

Respond ONLY with valid JSON in this exact format:
{
  "completed_items": [
    {
      "item_id": "uuid-of-item",
      "confidence": 0.95,
      "extracted_value": "value if slot type",
      "source_text": "relevant portion of transcript",
      "alternatives": []
    }
  ]${extraFieldsStr}
}

If no items were completed, return an empty array for completed_items.
${extraInstructions}`;
}

/**
 * Build the user prompt for workflow analysis
 * @param {Object} options - Prompt options
 * @param {string} options.transcript - The transcript text to analyze
 * @param {string} options.speaker - Speaker identifier (customer, agent, inbound, outbound)
 * @returns {string} User prompt
 */
export function buildWorkflowAnalysisUserPrompt({ transcript, speaker, recentContext = [] }) {
  const label = (sp) => (sp === "inbound" || sp === "customer") ? "Customer"
    : (sp === "outbound" || sp === "agent") ? "Agent"
    : "Speaker";
  const speakerLabel = label(speaker);

  // The preceding lines (usually the agent's question) let the analyzer
  // interpret a short/bare answer like "No" or "ICU" — WITHOUT them, a bare
  // answer is ambiguous and gets dropped or mis-filed. Context is read-only.
  let contextBlock = "";
  if (Array.isArray(recentContext) && recentContext.length > 0) {
    const lines = recentContext
      .filter((c) => c && c.text)
      .map((c) => `${label(c.speaker)}: "${c.text}"`)
      .join("\n");
    if (lines) {
      contextBlock = `Recent conversation (context ONLY — use it to interpret the new segment below; do NOT extract any values from these earlier lines):
${lines}

`;
    }
  }

  return `${contextBlock}Analyze ONLY this NEW transcription segment (extract values from this line, using the context above to interpret it):

Speaker: ${speakerLabel}
Transcript: "${transcript}"`;
}

/**
 * Build a batch analysis prompt for multiple transcripts
 * @param {Object} options - Prompt options  
 * @param {Array} options.transcripts - Array of {transcript, speaker, timestamp} objects
 * @param {Array} options.pendingItems - Array of pending workflow items
 * @param {Object} options.slotsFilled - Already filled slots
 * @returns {Object} System and user prompts
 */
export function buildBatchAnalysisPrompt({
  transcripts,
  pendingItems,
  slotsFilled,
  includeIntent = false,
  includeSentiment = false,
}) {
  const systemPrompt = buildWorkflowAnalysisSystemPrompt({
    pendingItems,
    slotsFilled,
    includeIntent,
    includeSentiment,
  });
  
  const transcriptList = transcripts.map((t, i) => {
    const speakerLabel = t.speaker === "inbound" ? "Customer" 
      : t.speaker === "outbound" ? "Agent" 
      : "Speaker";
    return `[${i + 1}] ${speakerLabel}: "${t.transcript}"`;
  }).join("\n");
  
  const userPrompt = `Analyze these transcription segments in sequence:

${transcriptList}

Consider the context from all segments when detecting completed items.`;

  return { systemPrompt, userPrompt };
}
