export function handoffTimelinePhases(handoff) {
  const status = String(handoff?.status || "").trim().toLowerCase();
  const ended = ["disconnected", "completed"].includes(status);
  const agentAssigned = handoff?.agentAssigned === true || ["assigned", "connected"].includes(status);
  const agentConnected = handoff?.agentConnected === true || status === "connected";
  return {
    ended,
    assigned: agentAssigned,
    connected: agentConnected,
    // A customer can end a call while it is still waiting in the queue. In
    // that case Contact Center emits a terminal customer event without any agent ever
    // accepting the interaction, so no agent-disconnected event is shown.
    disconnected: ended && agentConnected,
    failed: status === "failed",
  };
}
