// Channel capacity profiles (the internal documentation §6).
// Sample weights are starting hypotheses; per-agent/queue overrides come with
// Phase E. Exclusive channels occupy the whole agent and block fractional work.

import { CHANNEL_REGISTRY } from "./channel-registry.mjs";
export const CHANNEL_PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(CHANNEL_REGISTRY).map(([id, definition]) => [id, definition.capacity]),
));

export function channelProfile(channel) {
  const profile = CHANNEL_PROFILES[channel];
  if (!profile) throw new Error(`Unknown ACD channel: ${channel}`);
  return profile;
}
