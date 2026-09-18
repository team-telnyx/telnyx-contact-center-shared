import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingInteractionOffers,interactionChannelName} from '../lib/contact-center/interaction-alerts.mjs';
const now=Date.parse('2026-09-14T12:00:00Z');
const offer={id:'work1',offer_id:'offer1',channel:'email',state:'ringing',offer_deadline:new Date(now+30000).toISOString()};
test('header only advertises actionable text offers',()=>{
  for(const changed of [{channel:'voice'},{state:'active'},{state:'queued'},{state:'wrapup'},{offer_id:null},{terminal_at:'2026-09-14'}, {offer_deadline:'invalid'}, {offer_deadline:new Date(now).toISOString()}])assert.deepEqual(pendingInteractionOffers([{...offer,...changed}],now),[]);
  assert.deepEqual(pendingInteractionOffers([offer],now),[offer]);
});
test('multiple offers preserve queue order and deduplicate offers',()=>{
  const chat={...offer,id:'work2',offer_id:'offer2',channel:'chat',state:'offered'};
  assert.deepEqual(pendingInteractionOffers([offer,chat,offer],now),[offer,chat]);
  assert.deepEqual(pendingInteractionOffers([chat],now),[chat]);
  assert.deepEqual(pendingInteractionOffers([offer,chat],now+30000),[]);
});
test('future messaging channels and accessible names',()=>{
  for(const channel of ['whatsapp','sms','video'])assert.equal(pendingInteractionOffers([{...offer,channel}],now).length,1);
  assert.equal(interactionChannelName('whatsapp'),'WhatsApp');assert.equal(interactionChannelName('sms'),'SMS');assert.equal(interactionChannelName('video'),'video call');
});
