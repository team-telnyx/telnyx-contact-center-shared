// SDK 2.27.10 adapter: reportNoRtp delegates to its signaling-health monitor.
// It is deliberately bounded; never renegotiate a peer directly or redial.
export function createCallRecovery({client, getCall, isHeld = () => false, isMuted = () => false, onChange, onDiagnostic = () => {}, now = Date.now}) {
  let stopped=false, busy=false, call=null, peer=null, previous=null, lastGrowth=0;
  let state='idle', lastRequest=null, requests=0, growing=0, socketLost=false;
  const listeners=[];
  const emit=(event,code)=>onDiagnostic({at:now(),event,code,callId:call?.id||null,state});
  const change=next=>{if(state!==next){state=next;onChange({state:next,since:now(),callId:call?.id||null});emit('state');}};
  const terminal=c=>!c||['hangup','destroy','purge','done','ended','terminated','failed'].includes(String(c.state).toLowerCase());
  function reset(next){call=next;peer=null;previous=null;lastGrowth=now();lastRequest=null;requests=0;growing=0;change(socketLost?'signaling':'idle');}
  function listen(event,fn){client.on(event,fn);listeners.push([event,fn]);}
  listen('telnyx.socket.close',()=>{socketLost=true;change('signaling');emit('socket_closed');});
  listen('telnyx.ready',()=>{socketLost=false;if(!terminal(getCall()))change('media');else change('idle');emit('sdk_ready');});
  listen('telnyx.warning',event=>{
    const code=Number(event?.warning?.code);
    if(event?.callId&&event.callId!==getCall()?.id)return;
    if([36001,36002,36003].includes(code)){socketLost=true;change('signaling');}
    if([33001,33004,36004,32001].includes(code)){lastGrowth=now();growing=0;change('media');}
    emit('sdk_warning',code);
  });
  listen('telnyx.error',event=>{
    const code=Number((event?.error||event)?.code);
    if(event?.callId&&event.callId!==getCall()?.id)return;
    if([45003,48501].includes(code))change('unavailable');
    if(code===47001)change('media');
    emit('sdk_error',code);
  });
  async function tick(){
    if(stopped||busy)return;busy=true;
    try{
      const current=getCall();
      if(terminal(current)){if(call)reset(null);return;}
      if(current!==call){
        const recovering=call&&current.recoveredCallId===call.id;
        const budget={requests,lastRequest};
        reset(current);
        if(recovering){({requests,lastRequest}=budget);change('media');}
      }
      const c=call, p=c.peer?.instance;
      if(!p?.getStats)return;
      const held=String(c.state).toLowerCase()==='held'||isHeld();
      const active=['active','connected','answered'].includes(String(c.state).toLowerCase());
      if(held||!active){previous=null;lastGrowth=now();growing=0;return;}
      if(peer!==p){peer=p;previous=null;lastGrowth=now();growing=0;}
      const stats=await p.getStats();
      if(stopped||getCall()!==c||c.peer?.instance!==p||terminal(c))return;
      const received=new Map([...stats.values()].filter(r=>r.type==='inbound-rtp'&&(r.kind==='audio'||r.mediaType==='audio')).map(r=>[r.id,r.bytesReceived??0]));
      const growth=previous&&[...received].some(([id,bytes])=>previous.has(id)&&bytes>previous.get(id));
      previous=received;
      if(growth){lastGrowth=now();growing++;if(!socketLost&&growing>=2&&p.connectionState==='connected')change('idle');}
      else growing=0;
      if(socketLost||client.connected!==true)return;
      if(now()-lastGrowth<8000)return;
      change(now()-lastGrowth>=45000?'unavailable':'media');
      // Missing stats count as stalled only on an already established call.
      // Leave normal frozen-counter recovery to the SDK; supplement its missing-report gap.
      if(received.size||now()-lastGrowth<15000||requests>=2||
         (lastRequest!==null&&now()-lastRequest<30000)||c.peer?.isIceRestarting||
         typeof client.reportNoRtp!=='function')return;
      // No recovery side effects for held/muted calls or a retired client/call.
      const senders=p.getSenders?.()||[];
      if(isHeld()||String(c.state).toLowerCase()==='held'||isMuted()||senders.some(s=>s.track?.kind==='audio'&&(s.track.enabled===false||s.track.muted)))return;
      requests++;lastRequest=now();emit('missing_rtp_recovery_requested');
      client.reportNoRtp(c.id,'inbound');
    }catch{emit('stats_unavailable');}finally{busy=false;}
  }
  const timer=setInterval(()=>void tick(),2000);
  return {tick,stop(){stopped=true;clearInterval(timer);for(const [event,fn] of listeners)client.off(event,fn);},getState:()=>state};
}

export function recoveryBadge(recovery,status){
  if(recovery==='signaling')return {label:'Reconnecting',tone:'warning',description:'Restoring the voice connection. Keep this call open.'};
  if(recovery==='media')return {label:'Recovering audio',tone:'warning',description:'Restoring audio for the current call.'};
  if(recovery==='unavailable')return {label:'Recovery failed',tone:'error',description:'Audio recovery has not completed. The call has not been ended automatically.'};
  if(status==='connected')return {label:'Voice ready',tone:'ready',description:'Voice signaling is connected. This is not an audio quality measurement.'};
  if(status==='connecting')return {label:'Connecting',tone:'warning',description:'Connecting to voice service.'};
  return {label:'Voice offline',tone:'offline',description:'Voice service is disconnected.'};
}
