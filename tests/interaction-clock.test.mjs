import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionClock } from '../lib/contact-center/interaction-clock.mjs';

test('1000 subscribers share one timer, update together, and release it on unmount', () => {
  let time=100, tick, timers=0, cancelled=0, updates=0;
  const clock=createInteractionClock({now:()=>time,schedule:fn=>{tick=fn;timers++;return 42;},cancel:id=>{assert.equal(id,42);cancelled++;}});
  assert.equal(clock.getSnapshot(),null);
  const cleanup=Array.from({length:1000},()=>clock.subscribe(()=>updates++));
  assert.equal(timers,1); assert.equal(clock.getSnapshot(),100);
  time=1100; tick(); assert.equal(updates,1000); assert.equal(clock.getSnapshot(),1100);
  cleanup.slice(0,-1).forEach(stop=>stop()); assert.equal(cancelled,0);
  cleanup.at(-1)(); assert.equal(cancelled,1); assert.equal(clock.getSnapshot(),null);
  time=3000; const stop=clock.subscribe(()=>{}); assert.equal(timers,2); assert.equal(clock.getSnapshot(),3000); stop();
});
