import test from 'node:test';
import assert from 'node:assert/strict';
import { submitCoreHoldIntent } from '../lib/acd/client-hold-intent.js';
import { ensureVoiceEndpoint, refreshVoiceEndpoints, resetVoiceEndpoint } from '../lib/telephony/endpoint-client.js';

test('hold and unhold send the registered device token and current generation', async () => {
  const originalFetch=globalThis.fetch;
  const storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=> 'test-browser',setItem:()=>{}}});
  let generation='7', rejected=false;
  const calls=[];
  globalThis.fetch=async (url, options={})=>{
    if(url.endsWith('/voice-endpoints'))return Response.json({endpointId:'web',generation,endpoints:[],registration:{id:'web',token:'test-token'}});
    calls.push({url,options});
    assert.equal(options.headers.get('X-CC-Endpoint-Token'),'test-token');
    assert.equal(options.headers.get('X-CC-Voice-Generation'),generation);
    return rejected ? Response.json({error:'Device selection changed'},{status:409}) : Response.json({ok:true,intent:{action:JSON.parse(options.body).action}});
  };
  try {
    await ensureVoiceEndpoint();
    assert.deepEqual(await submitCoreHoldIntent('work/id','hold','request-1'),{action:'hold'});
    generation='8'; await refreshVoiceEndpoints();
    assert.deepEqual(await submitCoreHoldIntent('work/id','unhold','request-2'),{action:'unhold'});
    assert.equal(calls[0].url,'/api/contact-center/interactions/work%2Fid/intents');
    assert.equal(calls[0].options.keepalive,true);
    assert.deepEqual(JSON.parse(calls[1].options.body),{action:'unhold',requestId:'request-2'});
    assert.equal(await submitCoreHoldIntent(null,'hold'),null);
    assert.equal(await submitCoreHoldIntent('work','invalid'),null);
    assert.equal(calls.length,2);
    rejected=true;
    await assert.rejects(submitCoreHoldIntent('work','hold'),/Device selection changed/);
  } finally {
    resetVoiceEndpoint(); globalThis.fetch=originalFetch;
    if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else delete globalThis.sessionStorage;
  }
});
