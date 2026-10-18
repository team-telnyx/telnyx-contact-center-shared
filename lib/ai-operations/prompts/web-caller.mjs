import { personaInstruction, normalizePersona } from '../../call-generator/persona-expression.mjs';
export function buildResponsePrompt(params) {
  const {
    conversationHistory,
    lastAiMessage,
    workflow,
    pendingItems,
    workflowItems,
    customerData,
    persona,
    isFirstResponse,
    slotCount,
    expressiveKind,
  } = params;

  const personaText = personaInstruction(persona);
  const slots = Math.max(1, Number(slotCount) || 1);

  // Slot-count instruction — identical discipline to the call-flow tester. With
  // 1 the caller volunteers exactly one piece of information per turn; with >1
  // the caller may answer several requested fields in one natural sentence, but
  // never more than the resolved count and never invents fields the workflow
  // does not need.
  const slotInstruction = slots <= 1
    ? "Provide exactly ONE piece of requested information in this turn (single slot). Do not volunteer additional details the agent has not asked for yet."
    : `You may provide UP TO ${slots} distinct pieces of requested information in a single natural sentence this turn (e.g. customer name, facility name, and date of birth together) to test parallel slot filling. Never provide more than ${slots} distinct pieces of information in this turn, and never invent details the workflow does not need.`;

  const slotContext = pendingItems.length > 0
    ? `Information the agent still needs to collect: ${pendingItems.map((i) => `${i.label}${i.slot_name ? ` (${i.slot_name})` : ""}`).join(", ")}`
    : "All required information has been provided.";

  const dataRef = Object.entries(customerData || {})
    .map(([key, value]) => `- ${key.replace(/_/g, " ")}: ${value}`)
    .join("\n");

  const systemParts = [
    "You are simulating a realistic caller for automated contact-center workflow testing. Reply as the caller only. Be natural and provide information that helps the agent complete the configured workflow. Do not mention that you are an AI, a test harness, a workflow, or a simulation.",
  ];
  if (personaText) systemParts.push(`Caller persona: ${personaText}`);
  systemParts.push(slotInstruction);
  systemParts.push(`Use these EXACT character data values when the agent asks for the matching detail (do not change them between turns):\n${dataRef}`);

  // Expressive Mode: invite the model to add the voice family's expression tags
  // sparingly for more realistic delivery. Only added when Expressive Mode is on
  // AND the voice family supports it (Ultra SSML emotion tags, or xAI speech
  // tags). Other voices / Mode off → no tag instruction, so TTS never speaks
  // tags literally.
  if (expressiveKind === "ultra") {
    systemParts.push('Expressive Mode is on (Telnyx Ultra voice). You may add SSML emotion tags such as <emotion value="angry" />, <emotion value="excited" />, <emotion value="happy" />, <emotion value="frustrated" /> or <emotion value="hesitant" /> before a sentence, and the nonverbal cue [laughter], to match the persona. Use them sparingly and only when they fit. Output them inline as part of the utterance text.');
  } else if (expressiveKind === "xai") {
    systemParts.push('Expressive Mode is on (xAI Grok voice). You may add xAI speech tags inline to make delivery realistic: [pause], [long-pause], [laugh], [chuckle], [giggle], [sigh], [breath], [inhale], [exhale] placed where the sound happens, and wrapping tags like <soft>...</soft>, <whisper>...</whisper>, <emphasis>...</emphasis>, <slow>...</slow>, <fast>...</fast> to set delivery style. Use them sparingly and only when they fit the persona. Output them inline as part of the utterance text.');
  }

  const task = isFirstResponse
    ? "The AI assistant just greeted you. Generate the caller's opening utterance: greet back and/or briefly state why you are calling. Do not dump personal details yet — wait for the agent to ask."
    : "Generate the next caller utterance in response to the agent's latest message.";

  return [
    { role: "system", content: systemParts.join(" ") },
    {
      role: "user",
      content: JSON.stringify({
        task,
        workflow: {
          name: workflow?.name || "Workflow",
          description: workflow?.description || "",
          items: workflowItems,
        },
        slot_context: slotContext,
        recent_conversation: Array.isArray(conversationHistory)
          ? conversationHistory.slice(-8).map((m) => ({
              role: m.role === "assistant" ? "agent" : "caller",
              text: m.content,
            }))
          : [],
        latest_agent_message: String(lastAiMessage || "").slice(0, 2000),
        persona: normalizePersona(persona),
        max_information_pieces_this_turn: slots,
        style: slots <= 1
          ? "One short spoken sentence. Include a single concrete detail from your character data when the agent asks for it. Example for healthcare intake: patient name John Wick."
          : "One or two short spoken sentences. Include concrete details from your character data when the agent asks for them. Example for healthcare intake: patient name John Wick, date of birth July 4 1978.",
        output: "Return only the caller utterance text, no JSON, no labels, no quotes.",
      }),
    },
  ];
}
