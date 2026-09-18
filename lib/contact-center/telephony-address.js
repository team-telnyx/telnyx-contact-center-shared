export function isE164Address(value) {
  return /^\+[1-9]\d{1,14}$/.test(String(value || "").trim());
}

export function isWebRtcAddress(value) {
  const address = String(value || "").trim();
  if (!address || isE164Address(address)) return false;

  return (
    /^(?:sips?|call):/i.test(address) ||
    address.includes("@") ||
    /(?:^|[.:_-])gencred/i.test(address)
  );
}

export function callHistoryAddressDisplayName(interaction, side) {
  if (!interaction || !["from", "to"].includes(side)) return null;

  const address = interaction[`${side}_number`];
  const storedName = interaction[`${side}_name`] || null;
  if (!isWebRtcAddress(address)) return storedName;

  const direction = String(interaction.direction || "").toLowerCase();
  const isAgentSide =
    (direction === "outbound" && side === "from") ||
    (direction === "inbound" && side === "to");
  const agentName = interaction.agent_name || interaction.agent_username;

  return isAgentSide && agentName ? agentName : storedName;
}
