import test from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute} from './helpers/route-harness.mjs';
import {VERIFIED_INBOX_REPLAY} from '../lib/acd/replay-effects.mjs';

async function fixture({mediaError=false,completionError=false}={}){
  const calls=[],completions=[];
  const route=await loadRoute('app/api/voice/webhook/incoming/[flowId]/route.js',{
    '@/lib/acd/replay-effects.mjs':{VERIFIED_INBOX_REPLAY},
    '@/lib/acd/media-events.mjs':{handleAcdMediaEvent:async(...args)=>{calls.push(args);if(mediaError)throw Error('media cleanup unavailable');}},
    '@/lib/telnyx-webhooks.js':{verifyTelnyxSignature:async()=>false},
    '@/lib/call-logger.js':{logCallEvent:async()=>{}},
    '@/lib/call-monitor-store.js':{addWebhookEvent:()=>{}},
    '@/lib/voice/logging.mjs':{voiceRuntimePayload:v=>v,voiceWebhookLogger:{error:()=>{},warn:()=>{}}},
    '@/lib/postgres.mjs':{getPostgresPool:()=>{throw Error('Legacy database path must not execute');}},
    '@/lib/pgdb-voice-flows.js':{VoiceFlowDb:{completeFlowExecution:async(...args)=>{completions.push(args);if(completionError)throw Error('flow completion unavailable');},getFlowById:()=>{throw Error('Legacy flow must not execute');}}},
  });
  return {route,calls,completions};
}
const request=cause=>new Request('https://cc.example.test/webhook',{method:'POST',body:JSON.stringify({data:{id:'event',event_type:'call.hangup',payload:{call_control_id:'agent-transport',call_session_id:'shared-session',hangup_cause:cause}}})});
test('Core hangup replay retains adapter-only media cleanup',async()=>{
  for(const cause of ['user_busy','timeout','normal_clearing']){
    const {route,calls,completions}=await fixture();
    const result=await route.POST(request(cause),{params:{flowId:'flow'},[VERIFIED_INBOX_REPLAY]:{handled:true,outcome:'applied'}});
    assert.equal(result.status,200);assert.deepEqual(result.body,{ok:true,durable:true,replayed:true});
    assert.deepEqual(completions,[['flow','agent-transport',undefined]]);
    assert.equal(calls.length,1);assert.equal(calls[0][0],'call.hangup');assert.equal(calls[0][1].hangup_cause,cause);
  }
});
test('shared media failures remain retryable and public requests cannot claim replay authority',async()=>{
  const {route,calls}=await fixture({mediaError:true});
  assert.equal((await route.POST(request('user_busy'),{params:{flowId:'flow'},[VERIFIED_INBOX_REPLAY]:{handled:true}})).status,500);
  assert.equal(calls.length,1);
  const clean=await fixture();
  assert.equal((await clean.route.POST(request('user_busy'),{params:{flowId:'flow'}})).status,401);
  assert.equal(clean.calls.length,0);assert.equal(clean.completions.length,0);
});

test('Flow persistence failure keeps verified hangup replay retryable',async()=>{
  const {route,completions}=await fixture({completionError:true});
  const result=await route.POST(request('normal_clearing'),{params:{flowId:'flow'},[VERIFIED_INBOX_REPLAY]:{handled:true,outboundCore:true}});
  assert.equal(result.status,500);assert.equal(completions.length,1);
});
