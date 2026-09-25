"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {voiceFetch,refreshVoiceEndpoints} from '@/lib/telephony/endpoint-client';

export function useDeviceHandoff(interactionId,onJoinVideo) {
  const [state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const pending=useRef(null),reading=useRef(false),inFlight=useRef(false);
  const path=`/api/contact-center/interactions/${interactionId}/device-handoff`;
  const refresh=useCallback(async()=>{
    if(!interactionId||reading.current)return;reading.current=true;
    try{const r=await voiceFetch(path,{cache:'no-store'}),b=await r.json();if(!r.ok)throw Error(b.error||'Unable to read handoff status');setState(b);setError('');}
    catch(e){setError(e.message);}finally{reading.current=false;}
  },[path,interactionId]);
  useEffect(()=>{void refresh();const timer=setInterval(refresh,2000);window.addEventListener('contact-center:acd-state',refresh);
    return()=>{clearInterval(timer);window.removeEventListener('contact-center:acd-state',refresh);};},[refresh]);
  async function command(body) {
    if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');
    const input=pending.current||body;pending.current=input;
    try {
      const r=await voiceFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),b=await r.json();
      if(!r.ok){if(r.status<500)pending.current=null;throw Error(b.error||'Unable to take over the call');}
      pending.current=null;
      if(b.join)await onJoinVideo?.(b.join,b.id);else setState(b);
      window.dispatchEvent(new Event("contact-center:acd-state"));
      window.dispatchEvent(new Event("contact-center:refresh-interactions"));
      await refreshVoiceEndpoints();
    }catch(e){setError(e.message);}finally{inFlight.current=false;setBusy(false);}
  }
  return {state,error,busy,pending:pending.current,command};
}
