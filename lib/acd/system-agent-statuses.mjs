export const SYSTEM_AGENT_STATUSES = Object.freeze({
  Available: "available",
  "Agent Not Answering": "agent-not-answering",
});

export function isProtectedSystemAgentStatus(status = {}) {
  const id = String(status.id || "").trim().toLowerCase();
  const name = String(status.name || "").trim().toLowerCase();
  return Object.entries(SYSTEM_AGENT_STATUSES).some(
    ([canonicalName, canonicalId]) =>
      id === canonicalId || name === canonicalName.toLowerCase(),
  );
}
