"use client";
import {useEffect,useState} from 'react';
import {voiceFetch} from '@/lib/telephony/endpoint-client';

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
    void refresh(); timer=setInterval(refresh,2000);
    window.addEventListener('contact-center:acd-state',refresh);
    return () => {alive=false;request?.abort();clearInterval(timer);window.removeEventListener('contact-center:acd-state',refresh);};
  },[video,interaction.id]);
  const control=state?.id===interaction.id?state.control:null;
  return {canControl:!video||control?.canControl===true,
    reason:!video||control?.canControl===true?undefined:control
      ? `Video is handled on ${control.label || 'the other device'}. Use that device to control this interaction.`
      : 'Checking which device is handling this video call…'};
}
