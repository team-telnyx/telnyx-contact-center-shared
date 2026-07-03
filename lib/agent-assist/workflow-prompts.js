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
    includeSentiment ? "Include sentiment and sentiment_score based only on the current transcription segment." : null,
  ].filter(Boolean).join("\n");

  return `You are an expert contact center AI assistant that analyzes customer service call transcriptions.
Your task is to analyze each transcription segment and determine which workflow items have been completed.

## Workflow Context

**Pending Items to Detect:**
${itemsList}

**Previously Filled Slots:**
${filledSlotsStr}

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
export function buildWorkflowAnalysisUserPrompt({ transcript, speaker }) {
  const speakerLabel = speaker === "inbound" ? "Customer" 
    : speaker === "outbound" ? "Agent" 
    : speaker === "customer" ? "Customer"
    : speaker === "agent" ? "Agent"
    : "Speaker";
    
  return `Analyze this transcription segment:

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
