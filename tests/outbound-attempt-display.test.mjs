import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attemptDisplay } from '../lib/outbound-dialer/attempt-display.mjs';

test('claimed contact remains identifiable before provider numbers are assigned', () => {
  const d = attemptDisplay({ status: 'claimed', auto_dial_at: '2026-09-06T19:00:00Z', contact_methods: { number: { 1: '+48600000001' } } });
  assert.equal(d.to, '+48600000001');
  assert.equal(d.toIsCandidate, true);
  assert.equal(d.from, 'Selected when dialing starts');
  assert.equal(d.label, 'Assigned — automatic dialing pending');
});
test('actual selected number wins over first contact candidate and connected wins over ledger answered', () => {
  const d = attemptDisplay({ status: 'answered', dial_state: 'connected', to_number: '+48600000002', contact_methods: { number: { 1: '+48600000001' } } });
  assert.equal(d.to, '+48600000002');
  assert.equal(d.toIsCandidate, false);
  assert.equal(d.label, 'Connected to agent');
});
test('terminal outcomes remain explicit and reason codes are readable', () => {
  assert.equal(attemptDisplay({ status: 'completed', dial_state: 'disposed' }).label, 'Completed — disposition saved');
  assert.equal(attemptDisplay({ status: 'completed', dial_state: 'wrapup' }).label, 'Call ended — awaiting disposition');
  const d = attemptDisplay({ status: 'failed', dial_state: 'connected', failure_reason: 'agent_unavailable' });
  assert.equal(d.label, 'Failed');
  assert.equal(d.reason, 'Agent unavailable');
});
