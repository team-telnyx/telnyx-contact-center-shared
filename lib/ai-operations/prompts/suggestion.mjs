
export function buildSuggestionSystemPrompt({ itemType, agentName, brandName, isAiAssisted, targetMode }) {
  const agentIdentity = agentName || "an agent";
  const brand = brandName || "the company";

  return `You are an expert contact center assistant helping ${agentIdentity} at ${brand}.
Your task is to generate the exact words the agent should say next to the customer.

Hard rules:
- Return only the spoken line. No summary, no explanation, no labels, no markdown, no bullet points.
- Write in first person as the agent, ready to say aloud.
- Keep it concise: one short paragraph, preferably one sentence, maximum two sentences.
- Do not describe what the agent should do. Say the actual words.
- Do not include internal workflow names, item ids, analysis, or recap sections.
- For an opening greeting or "how can I help" item, thank the caller for calling ${brand} and ask how you can help (e.g. "Hi, thanks for calling ${brand}. How can I help you today?"). Do NOT lead with the agent's name and never say "the company". Only introduce the agent by name for an explicit "introduce yourself" item.
- If the call was transferred from an AI assistant, acknowledge that briefly only when it helps the first handoff.
- Do not jump back to the first pending workflow item when the conversation clearly moved to another workflow stage.
- Follow the provided target mode exactly: collect the selected slot, confirm a low-confidence slot, or collect a prerequisite for a blocked item.

Match the item type:
   - **action**: Suggest what the agent should say while performing the action
   - **question**: Generate a clear question to ask the customer
   - **topic**: Suggest how to introduce or discuss this topic
   - **slot**: Generate a polite question to collect the specific information

Context:
- Agent: ${agentIdentity}
- Brand: ${brand}
- Item type: ${itemType || "workflow item"}
- Target mode: ${targetMode || "continue_workflow"}
- AI-assisted call: ${isAiAssisted ? "yes" : "no"}`;
}

export function buildSuggestionUserPrompt({
  itemType,
  itemLabel,
  itemDescription,
  slotOptions,
  previousConversation,
  prefilledSlots,
  targetMode,
  conversationContext,
  blockedItem,
  itemStatus,
}) {
  let prompt = `Generate only the exact sentence(s) the agent should say next.

Workflow item:
- Type: ${itemType || "unknown"}
- Label: ${itemLabel}`;

  if (targetMode) {
    prompt += `\nTarget mode: ${targetMode}`;
  }

  if (conversationContext?.activeStageName) {
    prompt += `\nDetected conversation stage: ${conversationContext.activeStageName}`;
  }

  if (conversationContext?.reason) {
    prompt += `\nTarget selection reason: ${conversationContext.reason}`;
  }

  if (targetMode === "confirm_slot") {
    const value = capturedSlotValue({ itemStatus, prefilledSlots, conversationContext });
    prompt += `\nInstruction: Ask the agent to confirm the captured slot value with the customer before treating it as completed.`;
    if (value) prompt += ` Captured value: ${value}.`;
  }

  if (targetMode === "collect_prerequisite" && blockedItem?.label) {
    prompt += `\nBlocked later item: ${blockedItem.label}`;
    prompt += `\nInstruction: Do not suggest the blocked item yet. Ask only for the missing prerequisite represented by the selected workflow item.`;
  }

  if (itemDescription) {
    prompt += `\n**Context**: ${itemDescription}`;
  }

  if (slotOptions && slotOptions.length > 0) {
    prompt += `\nOptions the customer can choose from: ${slotOptions.join(", ")}`;
  }

  const filledSlots = Object.entries(prefilledSlots || {}).filter(
    ([, value]) => value !== null && value !== undefined && value !== ""
  );
  if (filledSlots.length > 0) {
    prompt += `\nAlready collected customer data: ${filledSlots
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ")}`;
  }

  if (previousConversation && previousConversation.length > 0) {
    const recentMessages = previousConversation.slice(-5);
    prompt += `\n\nRecent conversation context:\n`;
    prompt += recentMessages
      .map((msg) => `${msg.speaker}: "${msg.text}"`)
      .join("\n");
  }

  prompt += `\n\nReturn the spoken response only.`;
  return prompt;
}

export function capturedSlotValue({ itemStatus, prefilledSlots, conversationContext }) {
  // A correction candidate's newly-suggested value must win over the OLD
  // confirmed value still sitting in slots_filled — a "suggested" item is
  // deliberately NOT written to slots_filled until confirmed (so read-back
  // stays on the old value until then), so the general fallback below would
  // otherwise surface the stale value being corrected, not the new one
  // pending confirmation. Gated on is_correction (set only on the correction
  // path in analyze/route.js) so this does not affect the general case below,
  // where slots_filled can hold a MORE RECENT agent-corrected value than a
  // stale itemStatus.extracted_value — see "confirm slot suggestions prefer
  // corrected filled slot values over stale suggested captures".
  if (itemStatus?.is_correction) {
    const correctionValue = itemStatus?.extracted_value ?? itemStatus?.value;
    if (hasMeaningfulValue(correctionValue)) return correctionValue;
  }

  const slotName = conversationContext?.targetSlotName;
  const prefilledValue = slotName ? prefilledSlots?.[slotName] : null;
  if (hasMeaningfulValue(prefilledValue)) return prefilledValue;

  const statusValue = itemStatus?.extracted_value ?? itemStatus?.value;
  return hasMeaningfulValue(statusValue) ? statusValue : null;
}

export function hasMeaningfulValue(value) {
  return value !== null && value !== undefined && value !== "";
}
