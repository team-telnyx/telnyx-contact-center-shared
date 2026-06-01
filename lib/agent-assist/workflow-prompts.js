/**
 * Workflow Analysis Prompt Templates
 * 
 * Generates prompts for GPT-4o to analyze transcripts and detect
 * workflow item completion and slot extraction.
 */

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
}) {
  const itemsList = pendingItems.map((item, index) => {
    let itemDesc = `${index + 1}. ID: ${item.item_id}
   Type: ${item.type}
   Label: "${item.label}"
   Stage: ${item.stage_name}`;
    
    if (item.prompt_hint) {
      itemDesc += `\n   Detection hints: "${item.prompt_hint}"`;
    }
    
    if (item.type === "slot") {
      itemDesc += `\n   Slot: ${item.slot_name} (${item.slot_type || "text"})`;
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

4. **Slot items** - Extract specific values from the conversation
   - Example: "My name is John Smith" -> customer_name = "John Smith"
   - Example: "Account number is 123456" -> account_number = "123456"
   - Use the validation pattern if provided to verify extracted values

## Confidence Scoring

- 0.95-1.0: Very confident - explicit match, clear statement
- 0.85-0.94: Confident - strong match, can auto-complete
- 0.70-0.84: Moderate - decent match, suggest to agent
- 0.60-0.69: Low - possible match, mention as suggestion
- Below 0.60: Don't include

## Response Format

Respond ONLY with valid JSON in this exact format:
{
  "completed_items": [
    {
      "item_id": "uuid-of-item",
      "confidence": 0.95,
      "extracted_value": "value if slot type",
      "source_text": "relevant portion of transcript"
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
  const itemLines = pendingItems.map((item) => {
    const parts = [
      item.item_id,
      `type=${item.type}`,
      item.label,
      item.slot_name ? `slot=${item.slot_name}` : null,
      item.slot_type ? `slot_type=${item.slot_type}` : null,
      item.prompt_hint ? `hints=${item.prompt_hint}` : null,
      item.slot_validation ? `validation=${item.slot_validation}` : null,
    ].filter(Boolean);
    return `- ${parts.join(" | ")}`;
  }).join("\n");

  const filledSlotsStr = Object.keys(slotsFilled || {}).length > 0
    ? JSON.stringify(slotsFilled)
    : "{}";

  const extraFields = [];
  if (includeIntent) {
    extraFields.push(`"detected_intent":"brief intent description"`);
  }
  if (includeSentiment) {
    extraFields.push(`"sentiment":"positive|neutral|negative"`);
    extraFields.push(`"sentiment_score":50`);
  }
  const extraFieldsStr = extraFields.length ? `,${extraFields.join(",")}` : "";

  const systemPrompt = `You are a JSON API. Return only valid JSON. No prose, markdown, or reasoning.
Schema: {"completed_items":[{"item_id":"listed ID","confidence":0.95,"extracted_value":"slot value","source_text":"supporting transcript"}]${extraFieldsStr}}
Rules: extract only explicit transcript values/actions; use only listed IDs; confidence 0.60-1.00; omit uncertain matches below 0.60.
Type rules: action = agent performs or mentions the action; question = agent asks it or customer answers it; topic = topic is discussed; slot = extract the specific value from conversation and validate when validation is listed.
Filled slots: ${filledSlotsStr}
Items:
${itemLines}`;
  
  const transcriptList = transcripts.map((t, i) => {
    const speakerLabel = t.speaker === "inbound" || t.speaker === "customer" ? "Customer"
      : t.speaker === "outbound" || t.speaker === "agent" ? "Agent"
      : "Speaker";
    return `[${i + 1}] ${speakerLabel}: "${t.transcript}"`;
  }).join("\n");
  
  const userPrompt = `Analyze these transcription segments in sequence:

${transcriptList}

Consider the context from all segments when detecting completed items.
Return ONLY one valid JSON object matching the schema from the system prompt.
Do not include reasoning, markdown, code fences, or explanatory text.`;

  return { systemPrompt, userPrompt };
}
