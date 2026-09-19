// Shared, browser-safe channel catalogue. Release state is independent of capacity
// configuration and presentation. Adding a channel does not enable its routing.
const entries = {
  voice: {
    label: "Voice",
    icon: "phone",
    tone: "sky",
    released: true,
    configurable: true,
    family: "voice",
    lifecycle: "telephony",
    viewer: "voice",
    serviceEvent: "human_answer",
    slaScope: "queue_visit",
    capabilities: {
      supervision: true,
      recordings: true,
      holds: true,
      conversation: false,
    },
    capacity: { weight: 1, exclusive: true },
  },
  chat: {
    label: "Chat",
    icon: "messages",
    tone: "emerald",
    released: true,
    configurable: true,
    family: "messaging",
    lifecycle: "native",
    viewer: "messages",
    serviceEvent: "human_message_persisted",
    slaScope: "interaction",
    capabilities: { conversation: true },
    capacity: { weight: 0.33, exclusive: false, maxParallel: 3 },
  },
  email: {
    label: "Email",
    icon: "mail",
    tone: "violet",
    released: true,
    configurable: true,
    family: "messaging",
    lifecycle: "native",
    viewer: "email",
    serviceEvent: "human_send_accepted",
    slaScope: "interaction",
    capabilities: { conversation: true, deliveryEvidence: true },
    capacity: { weight: 0.2, exclusive: false, maxParallel: 5 },
  },
  whatsapp: {
    label: "WhatsApp",
    icon: "whatsapp",
    tone: "green",
    released: true,
    configurable: true,
    family: "messaging",
    lifecycle: "native",
    viewer: "messages",
    serviceEvent: "human_send_accepted",
    slaScope: "interaction",
    capabilities: { conversation: true, deliveryEvidence: true },
    capacity: { weight: 0.25, exclusive: false, maxParallel: 4 },
  },
  sms: {
    label: "SMS",
    icon: "message",
    tone: "amber",
    released: true,
    configurable: true,
    family: "messaging",
    lifecycle: "native",
    viewer: "messages",
    serviceEvent: "human_send_accepted",
    slaScope: "interaction",
    capabilities: { conversation: true, deliveryEvidence: true },
    capacity: { weight: 0.25, exclusive: false, maxParallel: 4 },
  },
  video: {
    label: "Video",
    icon: "video",
    tone: "rose",
    released: true,
    configurable: true,
    family: "video",
    // Telnyx Video Rooms session started from the web widget. Offers, wrap-up
    // and transfers reuse the native text lifecycle; media never touches
    // Call Control (the internal documentation).
    lifecycle: "native",
    viewer: "video",
    serviceEvent: "human_answer",
    slaScope: "queue_visit",
    capabilities: {
      // Monitor / whisper / barge as a room participant with per-receiver
      // subscriptions (the internal documentation §2).
      supervision: true,
      recordings: true,
      holds: false,
      conversation: false,
    },
    capacity: { weight: 1, exclusive: true, maxParallel: 1 },
  },
  rcs: {
    label: "RCS",
    icon: "message",
    tone: "slate",
    released: false,
    configurable: false,
    family: "messaging",
    lifecycle: "native",
    viewer: "messages",
    serviceEvent: "human_send_accepted",
    slaScope: "interaction",
    capabilities: { conversation: true, deliveryEvidence: true },
    capacity: { weight: 0.25, exclusive: false, maxParallel: 4 },
  },
};
export const CHANNEL_REGISTRY = Object.freeze(
  Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [
      id,
      Object.freeze({
        id,
        ...entry,
        capabilities: Object.freeze(entry.capabilities),
        capacity: Object.freeze(entry.capacity),
      }),
    ]),
  ),
);
export const RELEASED_CHANNELS = Object.freeze(
  Object.keys(entries).filter((id) => entries[id].released),
);
export const CONFIGURABLE_CHANNELS = Object.freeze(
  Object.keys(entries).filter((id) => entries[id].configurable),
);
// Released text channels that share the native text lifecycle (offers,
// assignments, drafts, wrap-up). SQL callers bind it as a text[] parameter so
// no query enumerates channel identifiers by hand.
export const MESSAGING_CHANNELS = Object.freeze(
  Object.keys(entries).filter(
    (id) => entries[id].released && entries[id].family === "messaging",
  ),
);
export function isMessagingChannel(id) {
  return channelDefinition(id).family === "messaging";
}
// Released channels handled by the native (non-telephony) lifecycle: offers,
// text assignments, wrap-up, transfers and sweeps. Messaging channels and the
// video channel share it; voice runs through Call Control sagas instead.
export const NATIVE_LIFECYCLE_CHANNELS = Object.freeze(
  Object.keys(entries).filter(
    (id) => entries[id].released && entries[id].lifecycle === "native",
  ),
);
export function usesNativeLifecycle(id) {
  return channelDefinition(id).lifecycle === "native";
}
export function channelDefinition(id) {
  return (
    CHANNEL_REGISTRY[id] || {
      id: id || "unknown",
      label: id || "Unknown channel",
      icon: "layers",
      tone: "slate",
      released: false,
      configurable: false,
      family: "unknown",
      lifecycle: "unknown",
      viewer: "metadata",
      capabilities: {},
    }
  );
}
