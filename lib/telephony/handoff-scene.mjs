import { sourceText } from '../i18n/source-text.mjs';

/**
 * How the "Move call" journey looks and what it says for a phase: the two
 * devices, where the caller is on the path between them, and the words under
 * it. A pure mapping, the same as the iOS app's HandoffScene, so each state is
 * testable without drawing it. Here is this browser: "This computer".
 *
 * The words are catalogue messages: the dialog passes its translator as `tUi`
 * and the device names are filled in; without one they read in English.
 */

/** This browser, as "Calls on" names every browser: one Computer. */
export const THIS_DEVICE = Object.freeze({ label: 'This computer', kind: 'web', isThisDevice: true });
/** A device the move does not know yet. */
export const UNKNOWN_DEVICE = Object.freeze({ label: 'Another device', kind: null, isThisDevice: false });

/** A device's name as the dialog shows it: the fixed names translated, a phone by the name it was given. */
export function deviceName(device, tUi = sourceText) {
  if (device.isThisDevice) return tUi('This computer');
  if (device.kind === null) return tUi('Another device');
  return device.kind === 'web' && device.label === 'Computer' ? tUi('Computer') : device.label;
}

/** A device by its endpoint id, as "Calls on" names it: every browser is the Computer. */
export function resolveHandoffDevice({ id = null, label = null, endpoints = [], thisEndpointId = null }) {
  if (id && id === thisEndpointId) return THIS_DEVICE;
  const device = endpoints.find(endpoint => endpoint.id === id);
  const kind = device?.kind || (label === 'Computer' ? 'web' : null);
  const name = kind === 'web' ? 'Computer' : device?.label || label;
  if (!name) return UNKNOWN_DEVICE;
  return { label: name, kind: kind || 'ios', isThisDevice: false };
}

/** A move target from voiceEndpointOptions, as a device on the journey. */
export const optionDevice = option => ({ label: option.label, kind: option.kind, isThisDevice: false });

/** The move's two devices: this browser on its side, the other by its id, else by the label the Contact Center gave. */
export function progressDevices(progress, lookup) {
  if (progress.isTarget) return { source: lookup(progress.sourceId, null), target: THIS_DEVICE };
  return { source: THIS_DEVICE, target: lookup(progress.targetId, progress.targetLabel) };
}

const scene = (source, target, fields) => ({ source, target, position: 0, tone: 'idle', flowing: false, reversed: false,
  ringing: false, targetReady: true, detail: '', ...fields });

/**
 * The scene for `phase`.
 *
 * - selected: the target chosen among several.
 * - owner: the device holding the call when it is not this one.
 * - previous: { source, target } of the move just watched, kept for its outcome.
 * - lookup(id, label): a device by endpoint id and fallback label.
 * - tUi(source, values): the translator; English without one.
 */
export function makeHandoffScene({ phase, selected = null, owner = null, previous = null, lookup = () => UNKNOWN_DEVICE, tUi = sourceText }) {
  const named = device => deviceName(device, tUi);
  // Where the call stayed: a whole sentence for this computer, whose name cannot be declined inside one.
  const stayed = device => (device.isThisDevice ? tUi('The call stayed on this computer.') : tUi('The call stayed on {value0}.', { value0: named(device) }));
  switch (phase.kind) {
  case 'loading':
    return scene(owner || THIS_DEVICE, UNKNOWN_DEVICE, { headline: tUi('Finding your devices…') });
  case 'chooseTarget': {
    const option = selected || phase.options.find(o => o.target?.reachable) || phase.options[0];
    return scene(THIS_DEVICE, optionDevice(option), { targetReady: Boolean(option.target?.reachable),
      headline: tUi('Where should the call go?'),
      detail: tUi('Choose a device, then answer there. The call stays connected here until you do.') });
  }
  case 'ready': {
    const { option } = phase, reachable = Boolean(option.target?.reachable);
    return scene(THIS_DEVICE, optionDevice(option), { targetReady: reachable,
      headline: tUi('Move this call to {value0}', { value0: option.label }),
      detail: reachable ? tUi('Answer it on {value0}. The call stays connected here until you do.', { value0: option.label })
        : tUi('Open the NovumCX app on {value0} to move the call there.', { value0: option.label }) });
  }
  case 'takeOver': {
    const source = owner || lookup(null, phase.ownerLabel);
    return scene(source, THIS_DEVICE, { headline: tUi('Take this call over here'),
      detail: tUi('The call is on {value0}. It stays connected there until you answer on this computer.', { value0: named(source) }) });
  }
  case 'moving':
    return moving(phase.progress, lookup, tUi);
  case 'incoming': {
    const { source, target } = progressDevices(phase.progress, lookup);
    return scene(source, target, { position: 0.5, tone: 'moving', flowing: true, ringing: true,
      headline: tUi('Call moving to this computer'),
      detail: tUi('Answer to take it over from {value0}. It stays connected there until you do.', { value0: named(source) }) });
  }
  case 'succeeded': {
    const { source, target } = progressDevices(phase.progress, lookup);
    return scene(source, target, { position: 1, tone: 'success',
      headline: phase.progress.isTarget ? tUi("You're on the call here") : tUi('Call moved to {value0}', { value0: named(target) }),
      detail: phase.progress.isTarget ? tUi('It moved from {value0} to this computer.', { value0: named(source) })
        : tUi('Carry on talking on {value0}.', { value0: named(target) }) });
  }
  case 'failed': {
    const { source, target } = previous || { source: THIS_DEVICE, target: UNKNOWN_DEVICE };
    return scene(source, target, { tone: 'failure', headline: tUi("The call didn't move"),
      detail: [phase.reason, stayed(source)].join(' ') });
  }
  case 'timedOut': {
    const { source, target } = previous || { source: THIS_DEVICE, target: lookup(null, phase.targetLabel) };
    return scene(source, target, { tone: 'warning', headline: tUi("{value0} didn't answer", { value0: named(target) }),
      detail: [stayed(source), tUi('Try again when {value0} is ready, or check that the NovumCX app is open there.', { value0: named(target) })].join(' ') });
  }
  case 'cancelled': {
    const { source, target } = previous || { source: THIS_DEVICE, target: UNKNOWN_DEVICE };
    return scene(source, target, { tone: 'warning', headline: tUi('Move cancelled'), detail: stayed(source) });
  }
  default:
    return scene(owner || THIS_DEVICE, UNKNOWN_DEVICE, { headline: tUi("This call can't move right now"), detail: phase.reason || '' });
  }
}

function moving(progress, lookup, tUi) {
  const { source, target } = progressDevices(progress, lookup);
  // A phone's name reads the same anywhere in a sentence; this computer gets whole sentences of its own.
  const there = deviceName(target, tUi), from = deviceName(source, tUi);
  switch (progress.step) {
  case 'dialing':
    return scene(source, target, { position: 0.22, tone: 'moving', flowing: true,
      headline: progress.isTarget ? tUi('Calling this computer…') : tUi('Calling {value0}…', { value0: there }),
      detail: progress.isTarget ? tUi('The call stays on {value0} until you answer here.', { value0: from })
        : tUi('The call stays connected here until you answer on {value0}.', { value0: there }) });
  case 'ringing':
    return scene(source, target, { position: 0.5, tone: 'moving', flowing: true, ringing: true,
      headline: progress.isTarget ? tUi('This computer is about to ring') : tUi('Answer on {value0}', { value0: there }),
      detail: progress.isTarget ? tUi('Answer the call here to take it over. It stays on {value0} until you do.', { value0: from })
        : tUi('{value0} is ringing. The call stays connected here until you answer there.', { value0: there }) });
  case 'switching':
    return scene(source, target, { position: 0.82, tone: 'moving', flowing: true,
      headline: progress.isTarget ? tUi('Switching audio to this computer…') : tUi('Switching audio to {value0}…', { value0: there }),
      detail: progress.isTarget ? tUi('Keep talking. The caller hears you on this computer in a moment.')
        : tUi('Keep talking. The caller hears you on {value0} in a moment.', { value0: there }) });
  default:
    return scene(source, target, { position: 0.3, tone: 'warning', flowing: true, reversed: true,
      headline: progress.isTarget ? tUi('Keeping the call on {value0}…', { value0: from }) : tUi('Keeping the call on this computer…'),
      detail: tUi('The move stopped. The call stays where it was.') });
  }
}

/**
 * How each tile stands in the move, and the word under it: the source holds
 * the call until it leaves; the target is ready, connecting, ringing, has the
 * call, or did not take it.
 */
export function handoffTiles(scene, tUi = sourceText) {
  const sourceState = scene.tone === 'success' ? 'left'
    : scene.tone === 'moving' && scene.position >= 0.8 ? 'left' : 'holding';
  let targetState;
  switch (scene.tone) {
  case 'success': targetState = 'arrived'; break;
  case 'failure': targetState = 'failed'; break;
  case 'warning': targetState = 'idle'; break;
  case 'moving': targetState = scene.ringing ? 'ringing' : 'waiting'; break;
  default: targetState = scene.target.kind === null ? 'unknown' : scene.targetReady ? 'idle' : 'unavailable';
  }
  const roles = { arrived: tUi('Has the call'), ringing: tUi('Ringing'), waiting: tUi('Connecting'), failed: tUi('Not moved'),
    unavailable: tUi('Not open'), unknown: '' };
  const targetRole = roles[targetState] ?? (scene.target.isThisDevice ? tUi('Here') : tUi('Ready'));
  return {
    source: { state: sourceState, role: scene.tone === 'success' ? tUi('Free') : tUi('Has the call') },
    target: { state: targetState, role: targetRole },
  };
}

/** The stepper's three steps for a move to `target`. */
export function handoffStepTitles(target, tUi = sourceText) {
  if (target.isThisDevice) return [['dialing', tUi('Calling this computer')], ['ringing', tUi('Ringing here')], ['switching', tUi('Audio switches')]];
  const name = deviceName(target, tUi);
  return [['dialing', tUi('Calling {value0}', { value0: name })], ['ringing', tUi('{value0} rings', { value0: name })], ['switching', tUi('Audio switches')]];
}

/** The point `progress` (0…1) along the quadratic arc from `start` through `control` to `end`. */
export function arcPoint({ start, control, end }, progress) {
  const along = Math.min(Math.max(progress, 0), 1), left = 1 - along;
  const a = left * left, b = 2 * left * along, c = along * along;
  return { x: a * start.x + b * control.x + c * end.x, y: a * start.y + b * control.y + c * end.y };
}

/**
 * The journey's geometry in a box `width` × `height`: the two tiles at the
 * bottom, and a curve from just above one to just above the other where the
 * caller rests while the call is on that device, peaking high enough for the
 * caller to clear the top.
 */
export function journeyLayout(width, height, tile, bubble) {
  const tileY = height - 44 - tile / 2;
  const inset = tile / 2 + 18;
  const sourceTile = { x: inset, y: tileY };
  const targetTile = { x: Math.max(width - inset, inset + 1), y: tileY };
  const anchorY = tileY - tile / 2 - bubble * 0.2;
  const rise = Math.max(anchorY - bubble / 2 - 6, 0);
  return { sourceTile, targetTile, start: { x: sourceTile.x, y: anchorY }, end: { x: targetTile.x, y: anchorY },
    control: { x: width / 2, y: anchorY - 2 * rise } };
}
