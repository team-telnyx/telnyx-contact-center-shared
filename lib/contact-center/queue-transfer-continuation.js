export function isOwnedQueueTransferContinuation(interaction, username, marker, now=Date.now()) {
  if(!username || !marker || marker.expiresAt<=now)return false;
  const owner=interaction.agent_username || interaction.agentUsername;
  if(!owner || owner!==username)return false;
  const state=String(interaction.state || interaction.status || "").toLowerCase();
  if(!["offered","ringing","active","connected"].includes(state))return false;
  return ["offered","ringing"].includes(state) || Boolean(
    interaction.assigned_at && marker.assignedAt && interaction.assigned_at!==marker.assignedAt
  );
}
