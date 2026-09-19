/**
 * Resolve the agent device identity for device-only trigger fallback.
 * This is not the STT media-fork target: transferred calls use the transport
 * with its negotiated codec (PR #1424, accepted production STT verification).
 */
export function resolveAcdAgentDeviceCallControlId(interaction) {
  const metadata = interaction?.metadata || {};
  return (
    interaction?.agent_call_control_id || metadata.agent_call_control_id || null
  );
}

/**
 * The transport answer is the synchronization point: by then Core has bound
 * both halves of the Telnyx transfer. Direct/device-only topologies fall back
 * to the device answer itself.
 */
export function resolveAcdAgentMediaTriggerCallControlId(interaction) {
  const metadata = interaction?.metadata || {};
  return (
    metadata.agent_transport_call_control_id ||
    resolveAcdAgentDeviceCallControlId(interaction)
  );
}

export function isAcdAgentMediaEvent(interaction, payload) {
  const mediaCallControlId =
    resolveAcdAgentMediaTriggerCallControlId(interaction);
  return Boolean(
    mediaCallControlId &&
      payload?.call_control_id &&
      String(payload.call_control_id) === String(mediaCallControlId),
  );
}
