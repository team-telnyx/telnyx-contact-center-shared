import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceEndpointOptions} from '../lib/telephony/endpoint-options.mjs';

const endpoints = [
  {id:'old-web', deviceId:'desk', kind:'web', label:'Computer', reachable:false},
  {id:'old-ios', deviceId:'phone', kind:'ios', label:'iPhone', reachable:false},
  {id:'web', deviceId:'desk', kind:'web', label:'Computer', reachable:true},
  {id:'ios', deviceId:'phone', kind:'ios', label:'iPhone', reachable:true},
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
  const list = [...endpoints, {id:'other-ios', deviceId:'phone', kind:'ios', reachable:true}];
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


test('selected iPhone distinguishes push standby from an unavailable phone',()=>{
  const options=voiceEndpointOptions({endpointId:'phone',endpoints:[{id:'phone',kind:'ios',reachable:true,availability:'standby'}]},'web');
  assert.equal(options[0].detail,'Active · standby via push');
  assert.equal(options[0].canChoose,false);
});

test('Android has its own phone tile and preserves the selected reachable session',()=>{
  const phones = [
    ...endpoints,
    {id:'android',deviceId:'droid',kind:'android',reachable:true,availability:'standby'},
    {id:'new-android',deviceId:'droid',kind:'android',reachable:true},
  ];
  const options=voiceEndpointOptions({endpointId:'android',endpoints:phones},'web');
  assert.deepEqual(options.map(option => option.label), ['Computer','iPhone','Android']);
  assert.equal(options[2].target.id,'android');
  assert.equal(options[2].detail,'Active · standby via push');
  assert.equal(options[2].canChoose,false);
});

test('every registered phone or tablet is its own tile, whatever its platform, named by its registration',()=>{
  const devices=[
    {id:'web',deviceId:'desk',kind:'web',label:'Computer',reachable:true},
    {id:'iphone-old',deviceId:'phone-a',kind:'ios',label:'iPhone',reachable:false},
    {id:'iphone',deviceId:'phone-a',kind:'ios',label:'iPhone',reachable:true},
    {id:'ipad',deviceId:'pad-a',kind:'ios',formFactor:'tablet',label:'iPad',reachable:true,availability:'standby'},
    {id:'pixel',deviceId:'droid-a',kind:'android',label:'Pixel 9',reachable:true},
    {id:'galaxy',deviceId:'droid-b',kind:'android',label:'',reachable:false},
  ];
  const options=voiceEndpointOptions({endpointId:'ipad',endpoints:devices},'web');
  assert.deepEqual(options.map(o=>o.key),['web','ios:phone-a','ios:pad-a','android:droid-a','android:droid-b']);
  assert.deepEqual(options.map(o=>o.label),['Computer','iPhone','iPad','Pixel 9','Android']);
  assert.deepEqual(options.map(o=>o.formFactor),[null,null,'tablet',null,null]);
  assert.equal(options[1].target.id,'iphone','repeat logins of one installation collapse into its latest reachable session');
  assert.equal(options[2].active,true);assert.equal(options[2].detail,'Active · standby via push');assert.equal(options[2].canChoose,false);
  assert.equal(options[3].canChoose,true);assert.equal(options[4].canChoose,false);assert.equal(options[4].detail,'Unavailable');
});
test('a registration without a device id is still its own tile',()=>{
  const options=voiceEndpointOptions({endpoints:[{id:'a',kind:'ios',reachable:true},{id:'b',kind:'ios',reachable:true}]},'web');
  assert.deepEqual(options.map(o=>o.key),['ios:a','ios:b']);
});
