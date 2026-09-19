export const DISCONNECTED_INTERACTION_SUPPRESSION_MS = 15_000;

function interactionIdentityKeys(interaction = {}) {
  const metadata = interaction?.metadata || {};
  return [
    interaction.id,
    interaction.interaction_id,
    interaction.interactionId,
    interaction.call_control_id,
    interaction.callControlId,
    interaction.call_session_id,
    interaction.callSessionId,
    interaction.original_call_control_id,
    interaction.originalCallControlId,
    metadata.original_call_control_id,
    metadata.agent_call_control_id,
  ]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(String);
}

function removeExpiredEntries(suppressed, now) {
  for (const [key, expiresAt] of suppressed) {
    if (expiresAt <= now) suppressed.delete(key);
  }
}

export function rememberDisconnectedInteraction(
  suppressed,
  interaction,
  now = Date.now(),
) {
  if (!(suppressed instanceof Map)) return;
  const expiresAt = now + DISCONNECTED_INTERACTION_SUPPRESSION_MS;
  for (const key of interactionIdentityKeys(interaction)) {
    suppressed.set(key, expiresAt);
  }
}

export function forgetDisconnectedInteraction(suppressed, interaction) {
  if (!(suppressed instanceof Map)) return;
  for (const key of interactionIdentityKeys(interaction)) {
    suppressed.delete(key);
  }
}

export function isRecentlyDisconnectedInteraction(
  suppressed,
  interaction,
  now = Date.now(),
) {
  if (!(suppressed instanceof Map)) return false;
  removeExpiredEntries(suppressed, now);
  return interactionIdentityKeys(interaction).some(
    (key) => (suppressed.get(key) || 0) > now,
  );
}
