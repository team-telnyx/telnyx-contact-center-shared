/**
 * The API retains older login registrations, ordered oldest first. Present one
 * tile per platform without mutating the authoritative routing selection.
 * This browser is always the web target when registered. For iPhone, preserve
 * a reachable selected session or offer the latest reachable registration.
 */
export function voiceEndpointOptions(state, currentEndpointId) {
  return ['web', 'ios'].flatMap(kind => {
    const sessions = (state?.endpoints || []).filter(device => device.kind === kind);
    if (!sessions.length) return [];
    const selected = sessions.find(device => device.id === state.endpointId);
    const own = kind === 'web' ? sessions.find(device => device.id === currentEndpointId) : null;
    const selectedReady = selected?.reachable ? selected : null;
    const target = own || selectedReady || sessions.findLast(device => device.reachable) || selected || sessions.at(-1);
    const active = Boolean(selected);
    const currentTarget = selected?.id === target.id;
    const needsReconnect = selected?.reachable === false;
    let detail = target.reachable ? 'Click to switch' : 'Unavailable';
    if (currentTarget) detail = target.reachable ? 'Active device' : 'Active · unavailable';
    else if (active && target.reachable) detail = needsReconnect
      ? 'Reconnect · old session offline'
      : kind === 'web' ? 'Switch to this browser' : 'Switch session';
    return [{kind, label: kind === 'ios' ? 'iPhone' : 'Computer', target, active,
      canChoose: target.reachable && !currentTarget, needsReconnect, detail}];
  });
}
