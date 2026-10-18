import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHandoffPhase, sagaStep, runningHandoffId, isHandoffOutcome, browserHandoffCall, browserCallIsOver, callSagaId,
  CANCELLED_ERROR, NO_ANSWER_ERROR } from '../lib/telephony/handoff-phase.mjs';
import { makeHandoffScene, handoffTiles, handoffStepTitles, resolveHandoffDevice, journeyLayout, arcPoint,
  THIS_DEVICE, UNKNOWN_DEVICE } from '../lib/telephony/handoff-scene.mjs';
import { interactionCaller, handoffEntry } from '../lib/telephony/handoff-caller.mjs';

const iphone = { id: 'ios-1', deviceId: 'install-a', kind: 'ios', label: 'iPhone', reachable: true };
const pixel = { id: 'android-1', deviceId: 'install-b', kind: 'android', label: 'Pixel', reachable: true };
const idleAnswer = extra => ({ active: true, ownerId: 'web-1', ownerLabel: 'Computer', canTakeOver: false, canStart: true,
  targets: [iphone], handoff: null, ...extra });
const saga = extra => ({ id: 'saga-1', state: 'running', step: 'dial_target', sourceId: 'web-1', targetId: 'ios-1',
  targetLabel: 'iPhone', isTarget: false, canCancel: true, error: null, ...extra });
const lookup = (id, label) => resolveHandoffDevice({ id, label, endpoints: [iphone, pixel, { id: 'web-1', kind: 'web', label: 'Computer' }],
  thisEndpointId: 'web-1' });

test('no answer yet is loading, then the read problem', () => {
  assert.deepEqual(resolveHandoffPhase({ value: null, loading: true }), { kind: 'loading' });
  assert.deepEqual(resolveHandoffPhase({ value: null, readError: 'Offline' }), { kind: 'unavailable', reason: 'Offline' });
});

test('one target is ready, several are a choice', () => {
  const ready = resolveHandoffPhase({ value: idleAnswer() });
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.option.label, 'iPhone');
  const choice = resolveHandoffPhase({ value: idleAnswer({ targets: [iphone, pixel] }) });
  assert.equal(choice.kind, 'chooseTarget');
  assert.deepEqual(choice.options.map(o => o.label), ['iPhone', 'Pixel']);
});

test('a call on another device can be taken over, named by its owner', () => {
  const phase = resolveHandoffPhase({ value: idleAnswer({ canTakeOver: true, canStart: false, ownerLabel: 'iPhone' }) });
  assert.deepEqual(phase, { kind: 'takeOver', ownerLabel: 'iPhone' });
  const scene = makeHandoffScene({ phase, lookup });
  assert.equal(scene.source.label, 'iPhone');
  assert.equal(scene.target, THIS_DEVICE);
  assert.equal(scene.headline, 'Take this call over here');
});

test('nothing to do shows the Contact Center’s reason', () => {
  const phase = resolveHandoffPhase({ value: idleAnswer({ canStart: false, unavailableReason: 'Only an active call can move.' }) });
  assert.deepEqual(phase, { kind: 'unavailable', reason: 'Only an active call can move.' });
});

test('saga steps map onto the three steps and back', () => {
  assert.equal(sagaStep('dial_target'), 'dialing');
  assert.equal(sagaStep('await_answer'), 'ringing');
  for (const step of ['bridge_target', 'verify_bridge', 'hangup_source', 'done']) assert.equal(sagaStep(step), 'switching');
  for (const step of ['restore_source', 'verify_restore', 'cleanup_target']) assert.equal(sagaStep(step), 'returning');
  const back = resolveHandoffPhase({ value: idleAnswer({ handoff: saga({ state: 'compensating', step: 'bridge_target' }) }) });
  assert.equal(back.progress.step, 'returning');
  assert.equal(back.progress.canCancel, false);
});

test('a move away travels the arc: calling, ringing, switching', () => {
  const positions = ['dial_target', 'await_answer', 'bridge_target'].map(step => {
    const phase = resolveHandoffPhase({ value: idleAnswer({ handoff: saga({ step }) }) });
    assert.equal(phase.kind, 'moving');
    return makeHandoffScene({ phase, lookup });
  });
  assert.deepEqual(positions.map(s => s.position), [0.22, 0.5, 0.82]);
  assert.deepEqual(positions.map(s => s.headline), ['Calling iPhone…', 'Answer on iPhone', 'Switching audio to iPhone…']);
  assert.equal(handoffTiles(positions[1]).target.state, 'ringing');
  assert.equal(handoffTiles(positions[2]).source.state, 'left');
});

test('the target leg ringing in this browser is an incoming handoff', () => {
  const value = idleAnswer({ canStart: false, handoff: saga({ step: 'await_answer', isTarget: true, sourceId: 'ios-1', targetId: 'web-1' }) });
  const phase = resolveHandoffPhase({ value, localCall: 'ringing' });
  assert.equal(phase.kind, 'incoming');
  const scene = makeHandoffScene({ phase, lookup });
  assert.equal(scene.source.label, 'iPhone');
  assert.equal(scene.headline, 'Call moving to this computer');
  // Answered here: the audio is switching even before the Contact Center says so.
  assert.equal(resolveHandoffPhase({ value, localCall: 'active' }).progress.step, 'switching');
});

test('the leg ringing here can be answered while the Contact Center still reports the dial', () => {
  const value = idleAnswer({ canStart: false, handoff: saga({ step: 'dial_target', isTarget: true, sourceId: 'ios-1', targetId: 'web-1', canCancel: true }) });
  const phase = resolveHandoffPhase({ value, localCall: 'ringing' });
  assert.equal(phase.kind, 'incoming');
  assert.equal(phase.progress.step, 'ringing');
  assert.equal(phase.progress.canCancel, true, 'Reject can turn the move down');
  // Nothing rings here yet: still calling.
  assert.equal(resolveHandoffPhase({ value, localCall: 'none' }).kind, 'moving');
  // A move back home is never offered as an incoming call.
  assert.equal(resolveHandoffPhase({ value: idleAnswer({ canStart: false, handoff: saga({ state: 'compensating', step: 'restore_source', isTarget: true }) }), localCall: 'ringing' }).kind, 'moving');
});

test('the source call ending after the commit is success', () => {
  const value = idleAnswer({ handoff: saga({ step: 'hangup_source', ownershipCommitted: true }) });
  const phase = resolveHandoffPhase({ value, localCall: 'ended' });
  assert.equal(phase.kind, 'succeeded');
  const scene = makeHandoffScene({ phase, lookup });
  assert.equal(scene.headline, 'Call moved to iPhone');
  assert.deepEqual(handoffTiles(scene), { source: { state: 'left', role: 'Free' }, target: { state: 'arrived', role: 'Has the call' } });
});

test('outcomes show only for a watched move', () => {
  const ended = error => idleAnswer({ handoff: saga({ state: 'cancelled', step: 'cleanup_target', error }) });
  assert.equal(resolveHandoffPhase({ value: ended(CANCELLED_ERROR) }).kind, 'ready');
  assert.deepEqual(resolveHandoffPhase({ value: ended(CANCELLED_ERROR), watchedHandoffId: 'SAGA-1' }), { kind: 'cancelled' });
  assert.deepEqual(resolveHandoffPhase({ value: ended(NO_ANSWER_ERROR), watchedHandoffId: 'saga-1' }), { kind: 'timedOut', targetLabel: 'iPhone' });
  assert.deepEqual(resolveHandoffPhase({ value: ended('Bridge failed.'), watchedHandoffId: 'saga-1' }), { kind: 'failed', reason: 'Bridge failed.' });
  const done = resolveHandoffPhase({ value: idleAnswer({ handoff: saga({ state: 'succeeded', completed: true }) }), watchedHandoffId: 'saga-1' });
  assert.equal(done.kind, 'succeeded');
  assert.ok(isHandoffOutcome(done));
});

test('a running move is remembered by its id; a retried command warning rides along', () => {
  const phase = resolveHandoffPhase({ value: idleAnswer({ handoff: saga({ error: 'Telnyx command rejected (HTTP 503).' }) }) });
  assert.equal(runningHandoffId(phase), 'saga-1');
  assert.equal(phase.progress.warning, 'Telnyx command rejected (HTTP 503).');
  assert.equal(runningHandoffId({ kind: 'ready' }), null);
});

test('outcome scenes keep the devices of the move they end', () => {
  const previous = { source: THIS_DEVICE, target: lookup('ios-1', 'iPhone') };
  const timedOut = makeHandoffScene({ phase: { kind: 'timedOut', targetLabel: 'iPhone' }, previous, lookup });
  assert.equal(timedOut.headline, "iPhone didn't answer");
  assert.match(timedOut.detail, /^The call stayed on this computer\./);
  assert.equal(handoffTiles(makeHandoffScene({ phase: { kind: 'failed', reason: 'Bridge failed.' }, previous, lookup })).target.state, 'failed');
});

test('a device that is not open cannot take the call', () => {
  const option = { label: 'iPhone', kind: 'ios', target: { ...iphone, reachable: false } };
  const scene = makeHandoffScene({ phase: { kind: 'ready', option }, lookup });
  assert.equal(scene.targetReady, false);
  assert.match(scene.detail, /Open the NovumCX app on iPhone/);
  assert.deepEqual(handoffTiles(scene).target, { state: 'unavailable', role: 'Not open' });
});

test('devices are named as Calls on names them', () => {
  assert.equal(lookup('web-1', null), THIS_DEVICE);
  assert.deepEqual(resolveHandoffDevice({ id: 'web-2', endpoints: [{ id: 'web-2', kind: 'web', label: 'Chrome' }] }),
    { label: 'Computer', kind: 'web', isThisDevice: false });
  assert.equal(lookup('pixel-gone', 'Pixel').label, 'Pixel');
  assert.equal(resolveHandoffDevice({}), UNKNOWN_DEVICE);
  assert.deepEqual(handoffStepTitles(THIS_DEVICE).map(([, title]) => title), ['Calling this computer', 'Ringing here', 'Audio switches']);
});

test('this browser’s call: the ringing target leg by its saga id, else the call the dialog opened for', () => {
  const leg = { id: 'rtc-2', status: 'ringing', direction: 'inbound', sagaId: 'SAGA-1' };
  assert.equal(browserHandoffCall({ call: leg, handoffId: 'saga-1' }), 'ringing');
  assert.equal(browserHandoffCall({ call: { ...leg, status: 'active' }, handoffId: 'saga-1' }), 'active');
  const source = { id: 'rtc-1', status: 'active', direction: 'inbound', sagaId: null };
  assert.equal(browserHandoffCall({ call: source, handoffId: 'saga-1', sourceCallId: 'rtc-1' }), 'active');
  assert.equal(browserHandoffCall({ call: null, handoffId: 'saga-1', sourceCallId: 'rtc-1' }), 'ended');
  assert.equal(browserHandoffCall({ call: { ...source, status: 'ended' }, sourceCallId: 'rtc-1' }), 'ended');
  assert.equal(browserHandoffCall({ call: source }), 'none');
  assert.equal(callSagaId({ options: { customHeaders: [{ name: 'X-CC-Saga-Id', value: 'saga-1' }] } }), 'saga-1');
  assert.equal(callSagaId({ options: {} }), null);
  // An ended call the SDK left behind (no id) still leaves this browser free to take over.
  assert.equal(browserCallIsOver({ status: 'ended' }), true);
  assert.equal(browserCallIsOver(null), true);
  assert.equal(browserCallIsOver({ id: 'rtc-1', status: 'held' }), false);
});

test('the arc starts and ends just above the tiles and peaks below the top edge', () => {
  const layout = journeyLayout(360, 230, 72, 46);
  assert.deepEqual(arcPoint(layout, 0), layout.start);
  assert.deepEqual(arcPoint(layout, 1), layout.end);
  const peak = arcPoint(layout, 0.5);
  assert.equal(peak.x, 180);
  assert.equal(Math.round(peak.y - 46 / 2), 6);
});

test('the caller is the other party, without repeating the number or a SIP URI', () => {
  assert.deepEqual(interactionCaller({ direction: 'incoming', from_name: 'Alex Morgan', from_number: '+12025550102', answered_at: '2026-10-16T10:00:00Z' }),
    { name: 'Alex Morgan', number: '+12025550102', startedAt: '2026-10-16T10:00:00Z' });
  assert.deepEqual(interactionCaller({ direction: 'outgoing', to_number: '+48221234567' }), { name: '+48221234567', number: null, startedAt: null });
  assert.equal(interactionCaller({ direction: 'outbound', to_name: 'Desk', to_number: 'sip:desk@sip.telnyx.com' }).number, null);
  assert.deepEqual(interactionCaller(null, 1700000000000), { name: 'Call', number: null, startedAt: 1700000000000 });
});

test('the softphone offers Move for the call here and Take over for a call elsewhere', () => {
  const calls = [{ id: 'i-1', interaction_type: 'voice', direction: 'incoming', from_name: 'Alex Morgan' }];
  assert.deepEqual(handoffEntry({ interactions: calls, callStatus: 'active' }), { kind: 'move', interactionId: 'i-1' });
  assert.deepEqual(handoffEntry({ interactions: [], callStatus: 'active', callInteractionId: 'i-9' }), { kind: 'move', interactionId: 'i-9' });
  assert.equal(handoffEntry({ interactions: [...calls, { ...calls[0], id: 'i-2' }], callStatus: 'active' }), null);
  assert.equal(handoffEntry({ interactions: calls, callStatus: 'ringing' }), null);
  // A call the Contact Center does not offer to this browser (one that just ended here) is not a banner.
  assert.equal(handoffEntry({ interactions: calls, callStatus: 'idle' }), null);
  const elsewhere = handoffEntry({ interactions: calls, takeOvers: { 'i-1': { canTakeOver: true, ownerLabel: 'iPhone' } }, callStatus: 'idle' });
  assert.equal(elsewhere.kind, 'elsewhere');
  assert.equal(elsewhere.caller.name, 'Alex Morgan');
  assert.equal(elsewhere.ownerLabel, 'iPhone');
  assert.equal(handoffEntry({ interactions: [{ id: 'chat', interaction_type: 'chat' }], callStatus: null }), null);
});

test('the Contact Center names a target that never answered in its own words; the saga id is read from every SDK header location', () => {
  const ended = resolveHandoffPhase({ value: idleAnswer({ handoff: saga({ state: 'cancelled', error: NO_ANSWER_ERROR }) }), watchedHandoffId: 'saga-1' });
  assert.equal(ended.kind, 'timedOut');
  const portalWording = resolveHandoffPhase({ value: idleAnswer({ handoff: saga({ state: 'cancelled', error: 'The target did not connect or the call ended.' }) }), watchedHandoffId: 'saga-1' });
  assert.equal(portalWording.kind, 'timedOut');
  const header = [{ name: 'X-CC-Saga-Id', value: 'saga-9' }];
  assert.equal(callSagaId({ inviteCustomHeaders: header }), 'saga-9');
  assert.equal(callSagaId({ invite: { customHeaders: header } }), 'saga-9');
  assert.equal(callSagaId({}, header), 'saga-9');
  assert.equal(callSagaId({ options: { customHeaders: [] } }), null);
});
