import test from 'node:test';
import assert from 'node:assert/strict';
import {createCallRecovery,recoveryBadge} from '../lib/telephony/call-recovery.mjs';
function fixture(t){
 let time=0,rows=[],held=false,muted=false,current;
 const handlers=new Map(),requests=[],states=[],events=[];
 const client={connected:true,on:(e,fn)=>handlers.set(e,fn),off:e=>handlers.delete(e),reportNoRtp:(...args)=>requests.push(args)};
 const peer={connectionState:'connected',getStats:async()=>new Map(rows.map(r=>[r.id,r])),getSenders:()=>[]};
 current={id:'call-1',state:'active',peer:{instance:peer}};
 const monitor=createCallRecovery({client,getCall:()=>current,isHeld:()=>held,isMuted:()=>muted,onChange:s=>states.push(s),onDiagnostic:e=>events.push(e),now:()=>time});
 t.after(()=>monitor.stop());
 return {monitor,client,peer,requests,states,events,handlers,emit:(e,p)=>handlers.get(e)?.(p),
  replace:c=>{current=c;},call:()=>current,setHeld:v=>held=v,setMuted:v=>muted=v,
  stats:bytes=>{rows=bytes===null?[]:[{id:'rtp',type:'inbound-rtp',kind:'audio',bytesReceived:bytes}];},
  tick:async ms=>{time+=ms;await monitor.tick();}};
}
test('missing inbound reports request bounded SDK recovery; RTP growth clears badge',async t=>{
 const f=fixture(t);await f.tick(0);await f.tick(16000);
 assert.deepEqual(f.requests,[['call-1','inbound']]);assert.equal(f.monitor.getState(),'media');
 await f.tick(2000);assert.equal(f.requests.length,1);
 await f.tick(30000);assert.equal(f.requests.length,2);
 await f.tick(60000);assert.equal(f.requests.length,2);assert.equal(f.monitor.getState(),'unavailable');
 f.stats(100);await f.tick(2000);f.stats(200);await f.tick(2000);f.stats(300);await f.tick(2000);
 assert.equal(f.monitor.getState(),'idle');
});
test('hold, mute, SDK ICE restart and signaling loss cannot trigger competing recovery',async t=>{
 const f=fixture(t);await f.tick(0);f.setHeld(true);await f.tick(30000);assert.equal(f.requests.length,0);
 f.setHeld(false);f.setMuted(true);await f.tick(16000);assert.equal(f.requests.length,0);
 f.setMuted(false);f.call().peer.isIceRestarting=true;await f.tick(16000);assert.equal(f.requests.length,0);
 f.call().peer.isIceRestarting=false;f.emit('telnyx.socket.close');await f.tick(30000);assert.equal(f.requests.length,0);
 f.emit('telnyx.ready');assert.equal(f.monitor.getState(),'media');await f.tick(2000);assert.equal(f.requests.length,1);
});
test('frozen byte counters remain the SDK detector responsibility; unrelated warnings ignored',async t=>{
 const f=fixture(t);f.stats(100);await f.tick(0);await f.tick(16000);assert.equal(f.requests.length,0);
 const before=f.states.length;f.emit('telnyx.warning',{warning:{code:36004},callId:'foreign'});assert.equal(f.states.length,before);
 f.emit('telnyx.ready');assert.equal(f.monitor.getState(),'media');await f.tick(2000);assert.notEqual(f.monitor.getState(),'idle');
});
test('late stats after call replacement or disposal cannot initiate recovery',async t=>{
 const f=fixture(t);await f.tick(0);let resolve;f.peer.getStats=()=>new Promise(r=>{resolve=r;});
 const pending=f.tick(16000);f.replace({id:'foreign',state:'active'});resolve(new Map());await pending;assert.equal(f.requests.length,0);
 const pending2=f.tick(16000);f.monitor.stop();await pending2;assert.equal(f.handlers.size,0);
});
test('reattached call retains recovery budget; terminal call clears recovery',async t=>{
 const f=fixture(t);await f.tick(0);await f.tick(16000);
 f.replace({id:'call-2',recoveredCallId:'call-1',state:'active',peer:{instance:f.peer}});await f.tick(0);await f.tick(16000);assert.equal(f.requests.length,1);
 await f.tick(16000);assert.equal(f.requests.length,2);f.call().state='hangup';await f.tick(2000);assert.equal(f.monitor.getState(),'idle');
});
test('badges distinguish signaling, media, failure and signaling-only readiness',()=>{
 assert.equal(recoveryBadge('signaling','connected').label,'Reconnecting');
 assert.equal(recoveryBadge('media','connected').label,'Recovering audio');
 assert.equal(recoveryBadge('unavailable','connected').tone,'error');
 assert.match(recoveryBadge('idle','connected').description,/not an audio quality/);
});
