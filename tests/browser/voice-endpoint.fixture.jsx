import './process-shim.js';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ContactCenterStreamProvider} from '../../components/contact-center/ContactCenterStreamProvider';
import {TelephonyProvider} from '../../components/telephony-provider';
import {VoiceRecoveryBadge} from '../../components/voice-recovery-badge';
import {refreshVoiceEndpoints} from '../../lib/telephony/endpoint-client';

const mode = Number(new URLSearchParams(location.search).get('status') || 409);
const fixture = window.fixture = { status: mode, registrations: 0, heartbeats: [], selectionStatus: 200, selections: [], endpointReads: 0, streams: [] };
window.EventSource = class extends EventTarget {
  constructor(url) { super(); this.url = url; fixture.streams.push(this); }
  close() {}
};
const snapshot = { endpointId: null, generation: '0', endpoints: [
  {id:'old-web',label:'Computer',kind:'web',reachable:false},
  {id:'old-phone',label:'iPhone',kind:'ios',reachable:false},
  {id:'web',label:'Computer',kind:'web',reachable:true},
  {id:'phone',label:'Phone',kind:'ios',reachable:false},
] };
fixture.enablePhone = async () => { snapshot.endpoints.find(device => device.id === 'phone').reachable = true; await refreshVoiceEndpoints(); };
fixture.remoteSelection = (id) => {
  snapshot.endpointId = id;
  snapshot.generation = String(BigInt(snapshot.generation) + 1n);
  fixture.emitSnapshot({agent: null, interactions: []});
};
fixture.emitSnapshot = (state) => {
  const stream = fixture.streams.find(s => s.url.startsWith('/api/contact-center/agent/stream'));
  stream.dispatchEvent(new MessageEvent('acd_sync', {data: JSON.stringify({cursor:'42', snapshot:state})}));
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json'}});
window.fetch = async (url, options = {}) => {
  if (url === '/api/user/profile') return json({data:{voice_enabled:true}});
  if (url === '/api/contact-center/agent/voice-endpoints') {
    if (options.method === 'POST') {
      fixture.registrations++;
      if (fixture.status !== 200) return json({error: fixture.status === 409
        ? 'Finish the current interaction before enabling device selection.' : 'Voice provisioning is temporarily unavailable.'}, fixture.status);
      return json({...snapshot, registration:{id:'web',token:'test-endpoint-secret'}});
    }
    if (options.method === 'PUT') {
      fixture.selections.push(JSON.parse(options.body).endpointId);
      await new Promise(resolve => setTimeout(resolve, 350));
      if (fixture.selectionStatus === 409) return json({error:'Finish the current interaction and wrap-up before switching devices.'},409);
      snapshot.endpointId = JSON.parse(options.body).endpointId; snapshot.generation = String(BigInt(snapshot.generation) + 1n);
    }
    if (!options.method) fixture.endpointReads++;
    return json(snapshot);
  }
  if (url === '/api/voice/token') return json({token:'test-voice-token'});
  if (url === '/api/contact-center/agent/session') { fixture.heartbeats.push(JSON.parse(options.body)); return json({ok:true}); }
  throw new Error(`Unexpected fixture request: ${url}`);
};
createRoot(document.getElementById('root')).render(<TelephonyProvider><ContactCenterStreamProvider>
  <div className="flex justify-end border-b bg-muted p-4" data-testid="mini-phone"><VoiceRecoveryBadge/></div>
  <div className="fixed bottom-5 right-5 z-[1000] flex w-80 items-center gap-3 rounded-xl border bg-muted p-4" data-testid="floating-phone">
    <VoiceRecoveryBadge/><span>Floating phone</span>
  </div>
</ContactCenterStreamProvider></TelephonyProvider>);
