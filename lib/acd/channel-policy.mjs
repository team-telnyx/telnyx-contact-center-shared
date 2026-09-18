import { CHANNEL_PROFILES } from "./channels.mjs";

import { CONFIGURABLE_CHANNELS, RELEASED_CHANNELS } from "./channel-registry.mjs";
export { CONFIGURABLE_CHANNELS, RELEASED_CHANNELS };

export function defaultChannelPolicy(channel) {
  const profile = CHANNEL_PROFILES[channel];
  if (!profile || !CONFIGURABLE_CHANNELS.includes(channel)) throw new Error("Unknown channel");
  return { channel, enabled: channel === "voice", maxConcurrent: profile.maxParallel || 1, weight: profile.weight };
}

export function parseChannelPolicies(value) {
  if (!Array.isArray(value) || value.length !== CONFIGURABLE_CHANNELS.length) {
    throw Object.assign(new Error("Provide one policy for each channel"), { status: 400 });
  }
  const seen = new Set();
  return value.map((policy) => {
    const { channel, enabled, maxConcurrent, weight } = policy;
    if (!CONFIGURABLE_CHANNELS.includes(channel) || seen.has(channel)
      || typeof enabled !== "boolean" || !Number.isInteger(maxConcurrent)
      || maxConcurrent < 1 || maxConcurrent > 100
      || typeof weight !== "number" || !Number.isFinite(weight) || weight < 0.01 || weight > 1
      || Math.abs(weight * 100 - Math.round(weight * 100)) > 0.000001
      // Exclusive channels (voice, video) occupy the whole agent: one at a time, full weight.
      || (CHANNEL_PROFILES[channel]?.exclusive && (maxConcurrent !== 1 || weight !== 1))) {
      throw Object.assign(new Error("Invalid channel policy"), { status: 400 });
    }
    if (enabled && !RELEASED_CHANNELS.includes(channel)) {
      throw Object.assign(new Error(`${channel} is not available yet`), { status: 400 });
    }
    seen.add(channel);
    return { channel, enabled, maxConcurrent, weight };
  });
}

export function effectiveChannelPolicy(agent, queue) {
  return {
    enabled: agent.enabled && queue.enabled,
    maxConcurrent: Math.min(agent.maxConcurrent, queue.maxConcurrent),
    weight: Math.max(agent.weight, queue.weight),
  };
}
