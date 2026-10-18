import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createVoiceCodec } from './outbound-codec.mjs';

export async function telnyxVoiceRequest(path,body,apiKey=process.env.TELNYX_API_KEY) {
  const response=await fetch('https://api.telnyx.com/v2'+path,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12_000)});
  if(!response.ok) {
    // Already ended is a confirmed terminal outcome for hangup commands.
    if(path.endsWith('/hangup') && [404,422].includes(response.status)) {
      const error=await response.json().catch(()=>null);
      if(error?.errors?.some(e=>['90018','90015'].includes(String(e.code)))) return {};
    }
    throw Object.assign(new Error('Voice provider unavailable'), { definitive: response.status >= 400 && response.status < 500 && response.status !== 408 });
  }
  return response.json();
}

// Keep caller identity within the provider's SIP display-name contract.
export function watchCallerDisplayName(value) {
  const name = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 _~!.+\-]/g, ' ').replace(/ +/g, ' ').trim().slice(0, 128).trim();
  return name || 'Contact Center';
}

// Telnyx initiates its media connection; the one-time random path is independent
// from the Watch bearer. Only this call's stream can attach, once, to this worker.
export function createWatchOutbound({repository,apiKey,request=telnyxVoiceRequest,heartbeatMs=10_000,callLimitMs=1800000}) {
  const streams=new Map();
  const server=new WebSocketServer({noServer:true,maxPayload:128*1024});
  let recovering=false;
  async function hangup(row) {
    if(row.provider_call_id) {
      await request(`/calls/${encodeURIComponent(row.provider_call_id)}/actions/hangup`,{command_id:row.id+'-end'},apiKey());
      await repository().end(row.id,true);
    } else await repository().end(row.id);
  }
  const recovery=setInterval(async()=>{
    if(recovering)return;recovering=true;
    try { for(const row of await repository().stale())await hangup(row).catch(()=>{}); }
    catch {} finally {recovering=false;}
  },15000); recovery.unref();
  function bridge(client,ticket,onEnd) {
    let media, callID, finished=false, connected=false, mediaReady=false, alive=true, checking=false;
    const codec=createVoiceCodec(), key=randomBytes(32).toString('hex');
    const send=frame=> { if(client.readyState===1)client.send(JSON.stringify(frame)); };
    const finish=(reason='Call ended',failed=false)=>{
      if(finished)return;finished=true;
      clearInterval(poll);clearInterval(heartbeat);clearTimeout(deadline);clearTimeout(ringing);
      streams.delete(key);media?.close();
      send({type:'call.ended',reason,failed});
      // Persist cancellation before compensating Dial, including a late result.
      repository().end(ticket.id).then(()=>repository().status(ticket.id)).then(row=>row&&hangup(row)).catch(()=>{});
      const close=setTimeout(()=>{client.close(1000,reason);onEnd();},1200);close.unref();
    };
    const ready=()=>{
      if(finished || connected || !mediaReady || !callID)return;
      connected=true;clearTimeout(ringing);
      send({type:'session.created',session:{audio:{output:{format:{type:'audio/pcm',rate:24000}}}}});
    };
    const deadline=setTimeout(()=>finish('Call duration limit reached'),callLimitMs);deadline.unref();
    const ringing=setTimeout(()=>finish('No answer',true),75000);ringing.unref();
    let answered=false;
    const poll=setInterval(async()=>{
      if(finished || checking)return;checking=true;
      try {
        const row=await repository().status(ticket.id);
        if(!row || row.state==='ended')finish(row?.call_state==='ended'?'Call ended':'Call cancelled');
        else if(row.call_state==='answered'){answered=true;if(mediaReady)ready();}
      }catch{finish('Call service unavailable',true);}finally{checking=false;}
    },750);poll.unref();
    const heartbeat=setInterval(async()=>{
      if(finished)return;
      if(!alive)return finish('Watch disconnected',true);
      alive=false;client.ping();
      try{if(!await repository().heartbeat(ticket.id))finish('Session access ended',true);}catch{finish('Session service unavailable',true);}
    },heartbeatMs);heartbeat.unref();
    client.on('pong',()=>{alive=true;});
    client.on('close',()=>finish());client.on('error',()=>finish('Watch disconnected',true));
    client.on('message',data=>{
      if(finished)return;
      try{
        const frame=JSON.parse(data);
        if(frame.type==='input_audio_buffer.append' && typeof frame.audio==='string' && frame.audio.length<=90000 && /^[A-Za-z0-9+/]+={0,2}$/.test(frame.audio)) {
          const pcm=Buffer.from(frame.audio,'base64');if(!pcm.length || pcm.length%2)throw Error();
          if(!connected)return;
          if(media?.readyState!==1 || media.bufferedAmount>32000)return finish('Audio upload too slow',true);
          const bytes=codec.encode(pcm);
          if(bytes.length)media.send(JSON.stringify({event:'media',media:{payload:bytes.toString('base64')}}));
        } else if(frame.type==='call.dtmf' && /^[0-9*#]$/.test(frame.digit || '') && connected) {
          request(`/calls/${encodeURIComponent(callID)}/actions/send_dtmf`,{digits:frame.digit},apiKey()).catch(()=>send({type:'call.notice',message:'Keypad tone could not be sent.'}));
        }else throw Error();
      }catch{finish('Invalid audio message',true);}
    });
    streams.set(key,{attach(socket){
      if(finished || media){socket.close(1008);return;}media=socket;
      const startup=setTimeout(()=>{if(!mediaReady)finish('Media connection timed out',true);},10000);startup.unref();
      let pendingStart;
      function acceptStart(start){
        if(!callID){pendingStart=start;return;}
        if(start.call_control_id!==callID || start.media_format?.encoding!=='PCMU' || start.media_format?.sample_rate!==8000 || start.media_format?.channels!==1)
          return finish('Unsupported voice stream',true);
        clearTimeout(startup);mediaReady=true;if(answered)ready();
      }
      streams.get(key).dialed=()=>{if(pendingStart)acceptStart(pendingStart);};
      socket.on('message',data=>{
        try{
          const frame=JSON.parse(data);
          if(frame.event==='start')acceptStart(frame.start||{});
          else if(frame.event==='media' && mediaReady && frame.media?.track==='inbound') {
            const payload=frame.media.payload;
            if(typeof payload!=='string' || payload.length>64000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload))throw Error();
            if(client.bufferedAmount>192000)return finish('Audio playback too slow',true);
            send({type:'response.output_audio.delta',delta:codec.decode(Buffer.from(payload,'base64')).toString('base64')});
          }else if(frame.event==='stop')finish();
        }catch{finish('Invalid voice stream',true);}
      });
      socket.on('close',()=>{clearTimeout(startup);finish();});socket.on('error',()=>finish('Voice connection lost',true));
    }});
    void (async()=>{
      try {
        if(!await repository().beginDial(ticket.id))throw Error();
        if(finished){await repository().end(ticket.id,true);return;}
        const url=new URL(ticket.media_url);url.pathname+='/media/'+key;
        const target=ticket.target;
        send({type:'call.state',state:'ringing'});
        const body={connection_id:target.connectionId,from:target.from,to:target.to,from_display_name:watchCallerDisplayName(target.callerName),
          command_id:ticket.id,client_state:Buffer.from(JSON.stringify({kind:'watch_outbound',id:ticket.id})).toString('base64'),
          webhook_url:target.webhookURL,webhook_url_method:'POST',timeout_secs:60,time_limit_secs:Math.floor(callLimitMs/1000),
          stream_url:url.href,stream_track:'inbound_track',stream_codec:'PCMU',stream_bidirectional_mode:'rtp',stream_bidirectional_codec:'PCMU',
          stream_bidirectional_sampling_rate:8000,stream_bidirectional_target_legs:'self'};
        // Retry the identical provider command ID; never originate a fresh call on timeout.
        let result, uncertain=false;
        for(let i=0;i<2;i++){
          try{result=await request('/calls',body,apiKey());break;}
          catch(error){
            if(error.definitive && !uncertain){await repository().end(ticket.id,true);throw error;}
            uncertain=true;if(i===1)throw error;
          }
        }
        callID=result?.data?.call_control_id;if(!callID)throw Error();
        await repository().dialed(ticket.id,callID);
        if(finished){await hangup({...ticket,provider_call_id:callID});return;}
        streams.get(key)?.dialed?.();if(answered && mediaReady)ready();
      }catch{finish('Could not place the call. Please retry.',true);}
    })();
    return {close:()=>finish()};
  }
  return {
    bridge,
    upgrade(req,socket,head){
      const match=/^\/watch-ai\/media\/([a-f0-9]{64})$/.exec(new URL(req.url,'http://localhost').pathname), entry=match&&streams.get(match[1]);
      if(!entry || entry.used){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
      entry.used=true;
      server.handleUpgrade(req,socket,head,ws=>entry.attach(ws));
    },
    close(){clearInterval(recovery);server.close();}
  };
}
