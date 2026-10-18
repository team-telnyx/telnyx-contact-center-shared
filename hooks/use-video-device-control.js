"use client";
import {useEffect,useState} from 'react';
import {voiceFetch,subscribeVoiceEndpoints} from '@/lib/telephony/endpoint-client';

// Read the interaction owner, not just the preferred device for future calls.
export function useVideoDeviceControl(interaction) {
  const video = interaction.channel === 'video';
  const [state,setState] = useState(null);
  useEffect(() => {
    if (!video) return;
    let alive = true, request, timer;
    async function refresh() {
      request?.abort(); request = new AbortController();
      const current = request;
      try {
        const response = await voiceFetch(`/api/contact-center/video/${interaction.id}`, {cache:'no-store',signal:current.signal});
        const body = await response.json();
        if (alive && !current.signal.aborted) setState({id:interaction.id,control:response.ok?body.deviceControl:null});
      } catch { if(alive&&!current.signal.aborted)setState({id:interaction.id,control:null}); }
    }
    const unsubscribe = subscribeVoiceEndpoints(()=>void refresh()); timer=setInterval(refresh,2000);
    window.addEventListener('contact-center:acd-state',refresh);
    return () => {unsubscribe();alive=false;request?.abort();clearInterval(timer);window.removeEventListener('contact-center:acd-state',refresh);};
  },[video,interaction.id]);
  const control=state?.id===interaction.id?state.control:null;
  // Ownership remains enforced by the server; avoid a misleading banner while
  // endpoint registration or a device switch is still being reconciled.
  return {canControl:!video||control?.canControl===true, reason:undefined};
}
