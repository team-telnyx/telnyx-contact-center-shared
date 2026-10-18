import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneIndicator, hasLiveVoiceCall} from '../lib/telephony/phone-indicator.mjs';
const now=100000;
const indicator=(mos, extra={})=>phoneIndicator({status:'connected',quality:{active:true,samples:[{mos,timestamp:now}]},now,...extra});
test('phone indicator uses four MOS colors at SDK thresholds',()=>{
  for(const [mos,color] of [[1,'red'],[3.09,'red'],[3.1,'orange'],[3.69,'orange'],[3.7,'yellow'],[4.09,'yellow'],[4.1,'green'],[5,'green']]) assert.equal(indicator(mos).color,color);
});
test('failed signaling and recovery take precedence over fresh good MOS',()=>{
  assert.equal(indicator(4.3,{status:'disconnected'}).color,'red');
  assert.equal(indicator(4.3,{status:'connecting'}).color,'orange');
  for(const state of ['media','signaling']) assert.equal(indicator(4.3,{recovery:{state}}).color,'orange');
  assert.equal(indicator(4.3,{recovery:{state:'unavailable'}}).color,'red');
});
test('missing, stale and retired measurements cannot claim live good quality',()=>{
  for(const mos of [null,undefined,NaN,Infinity,0,5.1]) assert.equal(indicator(mos).color,'yellow');
  for(const timestamp of [now-12000,now+2000]) assert.equal(indicator(4.3,{quality:{active:true,samples:[{mos:4.3,timestamp}]}}).color,'yellow');
  assert.equal(indicator(4.3,{quality:{active:true,samples:[]}}).color,'yellow');
  const idle=indicator(1,{quality:{active:false,samples:[{mos:1,timestamp:now}]}});
  assert.equal(idle.color,'green');
  assert.match(idle.description,/not an audio quality measurement/);
});
test('region/reconnect guard covers setup, ringing, held, and SDK-only calls',()=>{
  for(const state of ['new','requesting','trying','ringing','early','answering','active','held','recovering']){
    assert.equal(hasLiveVoiceCall({status:state}),true,state);
    assert.equal(hasLiveVoiceCall({status:'idle'},{calls:{id:{state}}}),true,state);
  }
  assert.equal(hasLiveVoiceCall({status:'idle',call:{state:'ringing'}}),true);
  for(const state of ['idle','ended','hangup','destroy','purge','done','terminated','failed']) assert.equal(hasLiveVoiceCall({status:state},{calls:{id:{state}}}),false,state);
});

test('unassigned voice device cannot report ready despite connected signaling',()=>{
  const pending=indicator(4.5,{deviceSelectionRequired:true});
  assert.equal(pending.color,'orange');
  assert.equal(pending.label,'Choose a device');
  assert.match(pending.description,/before receiving voice calls/);
  assert.equal(indicator(4.5,{deviceSelectionRequired:true,status:'disconnected'}).color,'red');
  assert.equal(indicator(4.5,{deviceSelectionRequired:false}).color,'green');
});
