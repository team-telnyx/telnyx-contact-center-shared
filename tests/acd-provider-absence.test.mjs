import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyConsultCompletion,
  verifyProviderCallEnded,
  verifyProviderAbsence,
} from '../lib/acd/provider-absence.mjs';
const request={customerCallId:'v3:customer',sourceConnectionId:'123',credentialId:'credential'};
function fixture(override=()=>undefined){const calls=[];return {calls,get:async path=>{
  calls.push(path);const value=override(path,calls);if(value!==undefined)return value;
  if(path.includes('/calls/'))return {data:{is_alive:false}};
  if(path.includes('/telephony_credentials/'))return {data:{resource_id:'connection:456'}};
  return {data:[],meta:{total_items:0,next:null,cursors:{after:null}}};
}};}
test('absence requires inactive parent before/after complete empty source and target inventories',async()=>{
  const f=fixture(),r=await verifyProviderAbsence(request,f.get);
  assert.equal(r.ended,true);assert.equal(r.connections.length,2);assert.equal(f.calls.length,5);
  assert.equal(f.calls[0],f.calls[4]);
});
test('active, partial, malformed or unavailable provider evidence never frees capacity',async()=>{
  for(const response of [{data:[{call_control_id:'active'}],meta:{total_items:1}},{data:[],meta:{total_items:0,next:'/more'}},{data:[]},{data:[],meta:{total_items:2}}]){
    const f=fixture(p=>p.includes('/active_calls')?response:undefined);
    assert.equal((await verifyProviderAbsence(request,f.get)).ended,false);
  }
  const alive=fixture(p=>p.includes('/calls/')?{data:{is_alive:true}}:undefined);
  assert.equal((await verifyProviderAbsence(request,alive.get)).ended,false);
  await assert.rejects(verifyProviderAbsence(request,async()=>{throw Error('network failure');}),/network failure/);
  const missing=fixture(p=>p.includes('/telephony_credentials/')?{data:{}}:undefined);
  await assert.rejects(verifyProviderAbsence(request,missing.get),/connection is unknown/);
});

// The direct-call probe is the only thing standing between a frozen browser
// and a released reservation, so its parsing is asserted against the real
// Telnyx response shapes rather than a normalised stub.
test("verifyAgentConnectionIdle confirms absence only for a complete empty inventory", async () => {
  const { verifyAgentConnectionIdle } = await import("../lib/acd/provider-absence.mjs");
  const credential = { data: { resource_id: "connection:123" } };
  const probe = (inventory, cred = credential) => async (path) =>
    (/telephony_credentials/.test(path) ? cred : inventory);

  const idle = await verifyAgentConnectionIdle({ credentialId: "cred-1" },
    probe({ data: [], meta: { total_items: 0 } }));
  assert.equal(idle.ended, true);
  assert.equal(idle.connectionId, "123");
  assert.equal(idle.activeCalls, 0);

  for (const [label, inventory] of [
    ["an active call", { data: [{ call_control_id: "v3:live" }], meta: { total_items: 1 } }],
    ["a missing total", { data: [], meta: {} }],
    ["a non-zero total", { data: [], meta: { total_items: 2 } }],
    ["a next page", { data: [], meta: { total_items: 0, next: "https://api.telnyx.com/next" } }],
    ["an after cursor", { data: [], meta: { total_items: 0, cursors: { after: "abc" } } }],
    ["a non-array body", { data: { call_control_id: "v3:live" }, meta: { total_items: 0 } }],
    ["no meta at all", { data: [] }],
  ]) {
    const result = await verifyAgentConnectionIdle({ credentialId: "cred-1" }, probe(inventory));
    assert.equal(result.ended, false, `${label} must withhold the confirmation`);
  }

  await assert.rejects(
    verifyAgentConnectionIdle({ credentialId: "cred-1" },
      probe({ data: [], meta: { total_items: 0 } }, { data: { resource_id: "application:9" } })),
    /Credential connection is unknown/,
  );
  await assert.rejects(verifyAgentConnectionIdle({}, probe({ data: [] })), /Missing agent credential identity/);
});

test("verifyProviderCallEnded requires an explicit false is_alive for the exact call", async () => {
  const ended = await verifyProviderCallEnded(
    { callControlId: "v3:ended" },
    async (path) => {
      assert.equal(path, "/calls/v3%3Aended");
      return { data: { is_alive: false } };
    },
  );
  assert.equal(ended.ended, true);
  assert.equal(ended.conclusive, true);
  assert.equal(ended.callControlId, "v3:ended");

  for (const response of [
    { data: { is_alive: true } },
    { data: {} },
    {},
  ]) {
    const result = await verifyProviderCallEnded(
      { callControlId: "v3:uncertain" },
      async () => response,
    );
    assert.equal(result.ended, false);
  }
  await assert.rejects(
    verifyProviderCallEnded({}, async () => ({ data: { is_alive: false } })),
    /Missing provider call identity/,
  );
});

test("verifyConsultCompletion recognizes an accepted handoff whose bridge webhook is missing", async () => {
  const states = new Map([
    ["customer", true],
    ["target", true],
    ["agent", false],
  ]);
  const result = await verifyConsultCompletion(
    {
      customerCallId: "customer",
      targetCallId: "target",
      agentCallId: "agent",
    },
    async (path) => ({ data: { is_alive: states.get(path.split("/").at(-1)) } }),
  );
  assert.equal(result.conclusive, true);
  assert.equal(result.transferred, true);
  assert.equal(result.allEnded, false);

  const partial = await verifyConsultCompletion(
    {
      customerCallId: "customer",
      targetCallId: "target",
      agentCallId: "agent",
    },
    async (path) => path.endsWith("/target")
      ? { data: {} }
      : { data: { is_alive: false } },
  );
  assert.equal(partial.conclusive, false);
  assert.equal(partial.transferred, false);
  assert.equal(partial.allEnded, false);
});
