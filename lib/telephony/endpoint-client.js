"use client";

let registration = null;
let current = null;
let pending = null;
let epoch = 0;
const listeners = new Set();
const path = "/api/contact-center/agent/voice-endpoints";
const publish = () => { for (const listener of listeners) listener(current); };
export function subscribeVoiceEndpoints(listener) { listeners.add(listener); listener(current); return () => listeners.delete(listener); }
export function voiceEndpointSnapshot() { return current; }
export function voiceEndpointRegistration() { return registration; }
export function resetVoiceEndpoint() { epoch++; registration=null; current=null; pending=null; publish(); }

async function decode(response) {
  const body=await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || 'Voice device request failed'),{status:response.status});
  return body;
}
export async function ensureVoiceEndpoint() {
  if (registration) return registration;
  if (pending) return pending;
  const version=epoch;
  pending=(async () => {
    let deviceId=sessionStorage.getItem('cc.voice.device');
    if (!deviceId) { deviceId=crypto.randomUUID(); sessionStorage.setItem('cc.voice.device',deviceId); }
    const value=await decode(await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({deviceId,kind:'web',label:'Computer'})}));
    if (version!==epoch) throw new Error('Voice session changed');
    registration=value.registration; current=value; publish();
    return registration;
  })();
  try { return await pending; } finally { if(version===epoch) pending=null; }
}
export async function refreshVoiceEndpoints() {
  const version=epoch;
  const value=await decode(await fetch(path,{cache:'no-store'}));
  if (version===epoch && (!current || BigInt(value.generation)>=BigInt(current.generation))) { current=value; publish(); }
  return value;
}
export async function selectVoiceEndpoint(endpointId) {
  const value=await decode(await fetch(path,{method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({endpointId,expectedGeneration:current?.generation})}));
  current=value; publish(); return value;
}
export function voiceFetch(url, options={}) {
  const headers=new Headers(options.headers);
  if (registration) headers.set('X-CC-Endpoint-Token',registration.token);
  if (current) headers.set('X-CC-Voice-Generation',current.generation);
  return fetch(url,{...options,headers});
}
export async function withdrawVoiceEndpoint() {
  if (!registration) return;
  await decode(await voiceFetch(path,{method:'DELETE'}));
  resetVoiceEndpoint();
}
