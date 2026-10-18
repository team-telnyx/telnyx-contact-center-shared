import { compatibleVoiceAudio } from "./assistant-audio-ui.mjs";

export function normalizeAssistantPayload(payloadInput) {
  const payload = payloadInput ? JSON.parse(JSON.stringify(payloadInput)) : {};
  if (payload.greetings && !payload.greeting) { payload.greeting = payload.greetings; delete payload.greetings; }
  if (payload.transcription && (payload.transcription.region === "" || payload.transcription.region === null)) {
    if (String(payload.transcription.model || "").startsWith("azure/")) payload.transcription.region = "latency";
    else delete payload.transcription.region;
  }
  if (payload.voice_settings && typeof payload.voice_settings === "object") {
    payload.voice_settings = compatibleVoiceAudio(payload.voice_settings);
    const elevenlabs = payload.voice_settings.elevenlabs_settings;
    if (elevenlabs && typeof elevenlabs === "object") {
      for (const field of ["temperature", "similarity_boost", "style", "use_speaker_boost", "speed"]) if (elevenlabs[field] !== undefined) payload.voice_settings[field] = elevenlabs[field];
      delete payload.voice_settings.elevenlabs_settings;
    }
    if (payload.voice_settings.language_boost === "") delete payload.voice_settings.language_boost;
    else if (String(payload.voice_settings.language_boost).toLowerCase() === "auto") payload.voice_settings.language_boost = "auto";
  }
  const voicemail = payload.telephony_settings?.voicemail_detection;
  if (voicemail && typeof voicemail === "object" && typeof voicemail.on_voicemail_detected === "string") {
    const action = { stop: "stop_assistant", leave_message: "leave_message_and_stop_assistant", continue: "continue_assistant" }[voicemail.on_voicemail_detected] || "stop_assistant";
    const next = { on_voicemail_detected: { action } };
    if (action === "leave_message_and_stop_assistant" && voicemail.voicemail_message?.trim()) next.on_voicemail_detected.voicemail_message = { type: "message", message: voicemail.voicemail_message.trim() };
    payload.telephony_settings.voicemail_detection = next;
  }
  if (["normal", "aggressive", "ultra_aggressive", "near_field", "far_field"].includes(payload.telephony_settings?.noise_suppression_config?.mode)) payload.telephony_settings.noise_suppression_config.mode = "advanced";
  if (Array.isArray(payload.tools)) payload.tools = payload.tools.map(normalizeAssistantTool);
  if (Array.isArray(payload.conversation_flow?.nodes)) for (const node of payload.conversation_flow.nodes) {
    if (node.voice_settings) node.voice_settings = compatibleVoiceAudio(node.voice_settings);
    delete node.tools_override;
    delete node._modelUi;
    delete node._llmOverride;
    if (Array.isArray(node.tools)) node.tools = node.tools.map(normalizeAssistantTool);
  }
  return payload;
}

export function normalizeAssistantTool(tool) {
  if (!tool || typeof tool !== "object") return tool;
  const next = JSON.parse(JSON.stringify(tool));
  if (next.type === "webhook") {
    next.webhook = {...next.webhook};
    const hook = next.webhook;
    // Migrate old editor fields once. Canonical callers never write these aliases.
    if (typeof next.async === "boolean") hook.async = next.async;
    delete next.async;
    if (next.timeout_ms === undefined) {
      if (typeof hook.timeout_secs === "number") next.timeout_ms = Math.round(hook.timeout_secs * 1000);
      else if (hook.timeout_ms !== undefined) next.timeout_ms = hook.timeout_ms;
    }
    delete hook.timeout_secs;
    delete hook.timeout_ms;
    if (hook.filler_messages && !hook.messages) hook.messages = hook.filler_messages.map(message => ({
      type: message.type === "on_start" ? "request_start" : "request_response_delayed",
      content: message.message,
      ...(message.type === "on_delay" ? {timing_ms: message.delay_ms} : {}),
    }));
    delete hook.filler_messages;
  }
  if (next.type === "transfer") {
    next.transfer = {...next.transfer};
    if (next.warm_transfer_instructions !== undefined) next.transfer.warm_transfer_instructions = next.warm_transfer_instructions;
    delete next.warm_transfer_instructions;
    if (next.transfer.sip_headers && !next.transfer.custom_headers) next.transfer.custom_headers = next.transfer.sip_headers;
    delete next.transfer.sip_headers;
  }
  return next;
}

export function assistantCreateWirePayload(input) {
  const payload = JSON.parse(JSON.stringify(input));
  removeWorkflowDraftState(payload);
  // There is no previous configuration to clear on creation. The create
  // contract accepts objects, so omit the editor's canonical removal values.
  for (const key of ["external_llm", "fallback_config", "avatar_settings", "conversation_flow"])
    if (payload[key] === null) delete payload[key];
  for (const config of [payload.fallback_config, payload.delegation_settings, ...(payload.conversation_flow?.nodes || [])])
    if (config?.external_llm === null) delete config.external_llm;
  return payload;
}

// Verified on controlled Contact Center assistants: null is ignored by update,
// whereas explicit empty required strings remove the external configuration.
// Keep this wire encoding separate from the canonical draft and read-back check.
export function assistantUpdateWirePayload(input) {
  const payload=JSON.parse(JSON.stringify(input));
  removeWorkflowDraftState(payload);
  if(payload.external_llm===null)payload.external_llm={model:'',base_url:''};
  if(payload.fallback_config===null)payload.fallback_config={model:'',llm_api_key_ref:'',external_llm:{model:'',base_url:''}};
  else if(payload.fallback_config?.external_llm===null)payload.fallback_config.external_llm={model:'',base_url:''};
  return payload;
}

function removeWorkflowDraftState(payload) {
  if (!payload.conversation_flow) return;
  if (payload.conversation_flow._assistantDrafts?.length) {
    throw new Error("Connect every assistant step to the workflow or remove it before saving.");
  }
  delete payload.conversation_flow._assistantDrafts;
}
