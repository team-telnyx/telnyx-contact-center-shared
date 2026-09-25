import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceEndpointOptions} from '../lib/telephony/endpoint-options.mjs';

const endpoints = [
  {id:'old-web', kind:'web', label:'Computer', reachable:false},
  {id:'old-ios', kind:'ios', label:'iPhone', reachable:false},
  {id:'web', kind:'web', label:'Computer', reachable:true},
  {id:'ios', kind:'ios', label:'iPhone', reachable:true},
];
test('old sessions produce only two tiles without changing the selected endpoint', () => {
  const state = {endpointId:'old-ios', endpoints};
  const options = voiceEndpointOptions(state, 'web');
  assert.deepEqual(options.map(option => option.kind), ['web','ios']);
  assert.equal(options[1].target.id, 'ios');
  assert.equal(options[1].active, true);
  assert.equal(options[1].canChoose, true);
  assert.equal(options[1].needsReconnect, true);
  assert.match(options[1].detail, /Reconnect/);
  assert.equal(state.endpointId, 'old-ios');
});
test('computer reconnect targets this browser instead of an expired selected session', () => {
  const [computer] = voiceEndpointOptions({endpointId:'old-web', endpoints}, 'web');
  assert.equal(computer.target.id, 'web');
  assert.equal(computer.canChoose, true);
  assert.equal(computer.needsReconnect, true);
});
test('a disconnected local browser never silently targets another ready computer', () => {
  const [computer] = voiceEndpointOptions({endpointId:'web', endpoints}, 'old-web');
  assert.equal(computer.target.id, 'old-web');
  assert.equal(computer.canChoose, false);
  assert.equal(computer.active, true);
});
test('a reachable selected iPhone wins over a newer registration', () => {
  const list = [...endpoints, {id:'other-ios', kind:'ios', reachable:true}];
  const phone = voiceEndpointOptions({endpointId:'ios', endpoints:list}, 'web')[1];
  assert.equal(phone.target.id, 'ios');
  assert.equal(phone.canChoose, false);
  assert.equal(phone.detail, 'Active device');
});
test('another active browser requires explicit switch to this browser', () => {
  const list = endpoints.map(device => ({...device, reachable:true}));
  const [computer] = voiceEndpointOptions({endpointId:'old-web', endpoints:list}, 'web');
  assert.equal(computer.canChoose, true);
  assert.equal(computer.detail, 'Switch to this browser');
});
test('offline and empty states do not fabricate switchable devices', () => {
  const list = endpoints.map(device => ({...device, reachable:false}));
  const options = voiceEndpointOptions({endpointId:'old-ios', endpoints:list}, 'web');
  assert.ok(options.every(option => !option.canChoose));
  assert.equal(options[1].target.id, 'old-ios');
  assert.equal(options[1].detail, 'Active · unavailable');
  assert.deepEqual(voiceEndpointOptions(null), []);
  assert.deepEqual(voiceEndpointOptions({endpoints:[]}), []);
});
