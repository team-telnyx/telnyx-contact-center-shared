// Logical speakers are independent of the physical direction of a media fork.
export function transcriptSpeaker(track) {
  const value = String(track || "").toLowerCase();
  if (["assistant", "ai", "ai_assistant"].includes(value)) return "assistant";
  return ["inbound", "customer", "caller", "user"].includes(value) ? "customer" : "agent";
}

export function transcriptSpeakerLabel(track) {
  return { customer: "Customer", agent: "Agent", assistant: "AI Assistant" }[transcriptSpeaker(track)];
}

export function participantTranscriptTrack(mapping, { callControlId, track, source }) {
  if (mapping?.ignoredCallIds?.includes(callControlId)) return null;
  const participant = callControlId === mapping?.customerCallId ? "inbound"
    : callControlId === mapping?.agentCallId ? "outbound" : null;
  // Native call.transcription tracks are physical. An endpoint's outbound
  // audio is the other participants' mix, not that endpoint's microphone.
  // Standalone STT has already mapped its isolated inbound fork to a role.
  if (participant && source !== "telnyx_standalone_stt_websocket" && track !== "inbound") return null;
  return participant || track || "unknown";
}
