/**
 * The API retains older login registrations, ordered oldest first. Present one
 * tile per device without mutating the authoritative routing selection: the
 * computer is one tile, this browser being its target when registered, and
 * every registered phone or tablet is its own tile whatever its platform, so
 * an iPad sits beside the iPhone and an Android beside both. Repeat logins of
 * one installation collapse into its tile. For another device, preserve a
 * reachable selected session or offer its latest reachable registration.
 */
export const defaultEndpointLabel = (kind, formFactor) =>
  kind === 'android' ? (formFactor === 'tablet' ? 'Android tablet' : 'Android')
  : kind === 'ios' ? (formFactor === 'tablet' ? 'iPad' : 'iPhone') : 'Computer';

export const endpointLabel = device => device?.label || defaultEndpointLabel(device?.kind, device?.formFactor);

export function voiceEndpointOptions(state, currentEndpointId) {
  const groups = new Map();
  for (const kind of ['web', 'ios', 'android']) for (const device of state?.endpoints || []) {
    if (device.kind !== kind) continue;
    const key = kind === 'web' ? 'web' : `${kind}:${device.deviceId || device.id}`;
    groups.set(key, [...(groups.get(key) || []), device]);
  }
  return [...groups].map(([key, sessions]) => {
    const kind = sessions[0].kind;
    const selected = sessions.find(device => device.id === state.endpointId);
    const own = sessions.find(device => device.id === currentEndpointId) || null;
    const selectedReady = selected?.reachable ? selected : null;
    const target = own || selectedReady || sessions.findLast(device => device.reachable) || selected || sessions.at(-1);
    const active = Boolean(selected);
    const currentTarget = selected?.id === target.id;
    const needsReconnect = selected?.reachable === false;
    let detail = target.reachable ? 'Click to switch' : 'Unavailable';
    if (currentTarget) detail = target.reachable ? target.availability === 'standby' ? 'Active · standby via push' : 'Active device' : 'Active · unavailable';
    else if (active && target.reachable) detail = needsReconnect
      ? 'Reconnect · old session offline'
      : kind === 'web' ? 'Switch to this browser' : 'Switch session';
    return {key, kind, formFactor: target.formFactor || null, label: kind === 'web' ? 'Computer' : endpointLabel(target), target, active,
      canChoose: target.reachable && !currentTarget, needsReconnect, detail};
  });
}
