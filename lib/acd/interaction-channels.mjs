import {
  CHANNEL_REGISTRY,
  RELEASED_CHANNELS,
  channelDefinition,
} from "./channel-registry.mjs";
export const INTERACTION_CHANNELS = RELEASED_CHANNELS;
export const CHANNEL_LABELS = Object.freeze(
  Object.fromEntries(
    Object.entries(CHANNEL_REGISTRY).map(([id, channel]) => [
      id,
      channel.label,
    ]),
  ),
);
export function interactionChannel(row) {
  return row?.channel || row?.interaction_type || "unknown";
}
export function interactionCapabilities(row) {
  const definition = channelDefinition(interactionChannel(row));
  return {
    ...definition.capabilities,
    conversation: Boolean(
      definition.capabilities.conversation &&
      row.conversationId !== null &&
      row.conversation_id !== null,
    ),
    // Voice needs a leg to attach to; a video call is supervised through its
    // room, so an active work item is enough.
    supervision: Boolean(
      definition.capabilities.supervision &&
      ["active", "connected"].includes(row.coreState || row.state) &&
      (definition.family === "video" || row.supervisionCallControlId || row.agentCallControlId),
    ),
  };
}
export function parseChannel(value) {
  if (!value || value === "all") return null;
  if (!INTERACTION_CHANNELS.includes(value))
    throw Object.assign(new Error("Invalid channel"), { status: 400 });
  return value;
}
