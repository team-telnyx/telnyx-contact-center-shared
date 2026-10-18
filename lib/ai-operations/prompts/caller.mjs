import { personaInstruction, normalizePersona, voiceExpressiveKind, personaEmotion } from '../../call-generator/persona-expression.mjs';
export function compactWorkflowItems(workflow) {
  const items = Array.isArray(workflow?.items) ? workflow.items : [];
  return items.slice(0, 30).map((item, index) => ({
    index: index + 1,
    id: item.id || item.item_id || item.key || null,
    title: item.title || item.name || item.label || "Workflow item",
    description: item.description || item.instructions || item.prompt || item.agent_prompt || "",
    type: item.type || null,
  }));
}

export function buildCustomerReplyPrompt({ workflow, transcript, history, persona, slotCount, expressiveKind }) {
  const personaText = personaInstruction(persona);
  const slots = Math.max(1, Number(slotCount) || 1);
  // Slot-count instruction. With 1 the caller volunteers exactly one piece of
  // information per turn (deterministic single-slot testing). With >1 the
  // caller may answer several of the agent's requested fields in one sentence,
  // which exercises parallel multi-slot filling. The model must never exceed
  // the resolved count for this turn.
  const slotInstruction = slots <= 1
    ? "Provide exactly ONE piece of requested information in this turn (single slot). Do not volunteer additional details the agent has not asked for yet."
    : `You may provide UP TO ${slots} distinct pieces of requested information in a single natural sentence this turn (e.g. customer name, facility name, and date of birth together) to test parallel slot filling. Never provide more than ${slots} distinct pieces of information in this turn, and never invent details the workflow does not need.`;

  const systemParts = [
    "You are simulating a realistic caller for automated contact-center workflow testing. Reply as the caller only. Be natural and provide information that helps the agent complete the configured workflow. Do not mention that you are an AI, a test harness, a workflow, or a simulation.",
  ];
  if (personaText) systemParts.push(`Caller persona: ${personaText}`);
  systemParts.push(slotInstruction);
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

  return [
    { role: "system", content: systemParts.join(" ") },
    { role: "user", content: JSON.stringify({
      task: "Generate the next caller utterance in response to the agent's finalized transcript.",
      workflow: {
        name: workflow?.name || "Workflow",
        description: workflow?.description || "",
        items: compactWorkflowItems(workflow),
      },
      recent_conversation: Array.isArray(history) ? history.slice(-8) : [],
      latest_agent_transcript: String(transcript || "").slice(0, 2000),
      persona: normalizePersona(persona),
      max_information_pieces_this_turn: slots,
      style: slots <= 1
        ? "One short spoken sentence. Include a single concrete fake but plausible detail when the agent asks for it. Example for healthcare intake: patient name John Wick."
        : "One or two short spoken sentences. Include concrete fake but plausible details when the agent asks for them. Example for healthcare intake: patient name John Wick, date of birth July 4 1978.",
      output: "Return only the caller utterance text, no JSON, no labels.",
    }) },
  ];
}

export function buildPreviewSamplePrompt({ persona, voice, expressive }) {
  const personaText = personaInstruction(persona);
  const personaId = normalizePersona(persona);
  const kind = expressive === true ? voiceExpressiveKind(voice) : null;

  const sys = [
    "You write a single short sample line for previewing a text-to-speech voice in a contact-center testing tool. Output ONE natural spoken sentence of at most 20 words. No quotes, no labels, no preamble — just the sentence.",
  ];
  if (personaText) sys.push(`Speak as this persona: ${personaText}`);
  if (kind === "ultra") {
    const emotion = personaEmotion(personaId) || "excited";
    sys.push(`Expressive Mode is on for a Telnyx Ultra voice. Begin the sentence with the SSML tag <emotion value="${emotion}" /> and you may add the nonverbal cue [laughter] if it fits. Keep the tags inline in the output.`);
  } else if (kind === "xai") {
    sys.push('Expressive Mode is on for an xAI Grok voice. Embed one or two xAI speech tags inline to demonstrate expression, e.g. [pause], [laugh], [sigh], or wrap part of the sentence with <whisper>...</whisper>, <emphasis>...</emphasis>, <soft>...</soft>, <slow>...</slow>. Keep the tags inline in the output.');
  }

  return [
    { role: "system", content: sys.join(" ") },
    { role: "user", content: JSON.stringify({
      task: "Write one preview sentence (max 20 words) demonstrating the persona and, if applicable, the expression tags.",
      persona: personaId,
      expressive: kind !== null,
      voice_family: kind || "standard",
    }) },
  ];
}
