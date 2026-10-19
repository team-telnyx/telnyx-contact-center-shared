import { ASSISTANT_EVENT_DESTINATION_CONFLICT } from "./assistant-event-conflicts.mjs";

// Confirmation is a request-only field, never trusted from an imported file.
export async function saveFlowWithAssistantConfirmation(url, payload, { method = "PUT", confirm, request = fetch } = {}) {
  const snapshot = JSON.parse(JSON.stringify(payload));
  delete snapshot.assistantEventDestinationConfirmations;
  const approvals = new Map();
  for (;;) {
    const response = await request(url, {
      method, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...snapshot, ...(approvals.size ? { assistantEventDestinationConfirmations: [...approvals.values()] } : {}) }),
    });
    const result = await response.json().catch(() => null);
    if (response.ok && result?.ok) return result;
    const message = result?.error || `Failed to save flow (HTTP ${response.status}).`;
    if (response.status !== 409 || result?.code !== ASSISTANT_EVENT_DESTINATION_CONFLICT || !Array.isArray(result.conflicts) || !result.conflicts.length || !confirm) {
      throw new Error(message);
    }
    if (!await confirm({ message, conflicts: result.conflicts })) return null;
    for (const { assistantId, confirmationToken } of result.conflicts) approvals.set(assistantId, { assistantId, confirmationToken });
  }
}
