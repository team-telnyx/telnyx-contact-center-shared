import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import http from 'node:http';
import {WebSocket} from 'ws';
import {createWatchOutbound,watchCallerDisplayName} from '../lib/watch-audio/outbound.mjs';
import {createVoiceCodec,encodeMuLaw,decodeMuLaw} from '../lib/watch-audio/outbound-codec.mjs';
import {normalizeWatchDestination,resolveWatchTarget} from '../lib/watch-audio/outbound-targets.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const env={TELNYX_WATCH_VOICE_APP_ID:'app',TELNYX_MAIN_FROM_NUMBER:'+12025550123',APP_BASE_URL:'https://cc.example'};
test('PSTN and SIP validation rejects headers, credentials, short numbers and arbitrary destinations',async()=>{
 assert.equal(normalizeWatchDestination('+48 (22) 123-45-67'),'+48221234567');
 assert.equal(normalizeWatchDestination('sip:gencred-name@sip.telnyx.com'),'sip:gencred-name@sip.telnyx.com');
 for(const value of ['123','sip:x:secret@host','sip:x@host?header=value','sip:x@host\r\nHeader: x','https://example.com'])assert.throws(()=>normalizeWatchDestination(value));
 const pool={query:async()=>({rows:[{id:'c',phone:'+12025550124'}]})};
 assert.equal((await resolveWatchTarget(pool,{id:'u'},{kind:'contact',id:'c',destination:'+12025550124'},env)).to,'+12025550124');
 await assert.rejects(()=>resolveWatchTarget(pool,{id:'u'},{kind:'contact',id:'c',destination:'+12025550125'},env),{status:400});
});
test('colleague uses selected endpoint gencred rather than stale legacy identity or client-supplied SIP',async()=>{
 const pool={query:async()=>({rows:[{id:'c',telephony_user_name:'old',endpoint_id:'e',reachable:true,selected_sip:'gencred-current'}]})};
 const target=await resolveWatchTarget(pool,{id:'u'},{kind:'colleague',id:'c',destination:'sip:attacker@host'},env);
 assert.equal(target.to,'sip:gencred-current@sip.telnyx.com');
 await assert.rejects(()=>resolveWatchTarget(pool,{id:'c'},{kind:'colleague',id:'c'},env),{status:400});
});
test('mu-law known silence and sample conversion preserve packet boundaries and duration',()=>{
 assert.equal(encodeMuLaw(0),255);assert.equal(decodeMuLaw(255),0);
 for(const sample of [-30000,-10000,-100,100,10000,30000])assert.ok(Math.abs(decodeMuLaw(encodeMuLaw(sample))-sample)<1100);
 const codec=createVoiceCodec();const pcm=Buffer.alloc(1280);
 assert.equal(codec.encode(pcm.subarray(0,333)).length,83);
 assert.equal(codec.encode(pcm.subarray(333)).length,237);
 assert.equal(codec.decode(Buffer.alloc(160,255)).length,960);
});
async function fixture(t,{deferDial=false,failOnce=false,callerName}={}) {
 const frames=[],commands=[];
 const row={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',state:'active',target:{callerName,connectionId:'app',from:'+12025550123',to:'+12025550124',webhookURL:'https://cc.example/hook'}};
 const client=new EventEmitter();client.readyState=1;client.bufferedAmount=0;client.send=s=>frames.push(JSON.parse(s));client.ping=()=>client.emit('pong');client.close=()=>{client.readyState=3;client.emit('close');};
 const store={beginDial:async()=>{row.dial_started_at=new Date();return true;},dialed:async(_id,id)=>{row.provider_call_id=id;},status:async()=>row,heartbeat:async()=>true,stale:async()=>[],end:async(_id,confirmed)=>{row.state='ended';row.confirmed ||= confirmed;}};
 let resolveDial;
 const delayed=new Promise(r=>{resolveDial=r;});
 let attempt=0;
 const outbound=createWatchOutbound({repository:()=>store,apiKey:()=> 'secret',request:async(path,body)=>{
  commands.push({path,body});
  if(path==='/calls'){
   if(failOnce && attempt++===0)throw Error('uncertain result');
   if(deferDial)await delayed;
   return {data:{call_control_id:'call-1'}};
  }return {};
 }});
 const server=http.createServer();server.on('upgrade',(req,socket,head)=>outbound.upgrade(req,socket,head));server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`ws://127.0.0.1:${server.address().port}`;
 const bridge=outbound.bridge(client,{...row,media_url:base+'/watch-ai'},()=>{});
 t.after(()=>{bridge.close();outbound.close();server.close();});
 await wait(20);
 return {base,frames,commands,row,client,resolveDial,bridge,async stream(extra={}){
  const socket=new WebSocket(commands.find(x=>x.path==='/calls').body.stream_url);socket.on('error',()=>{});t.after(()=>socket.terminate());await once(socket,'open');
  socket.send(JSON.stringify({event:'start',start:{call_control_id:'call-1',media_format:{encoding:'PCMU',sample_rate:8000,channels:1},...extra}}));
  return socket;
 }};
}
test('outbound PSTN bridges both audio directions only after answer and supports DTMF + hangup',async t=>{
 const f=await fixture(t);const socket=await f.stream();await wait(20);
 assert.equal(f.frames.some(x=>x.type==='session.created'),false);
 f.row.call_state='answered';await wait(800);
 assert.equal(f.frames.filter(x=>x.type==='session.created').length,1);
 assert.equal(f.commands[0].body.stream_bidirectional_target_legs,'self');
 socket.send(JSON.stringify({event:'media',media:{track:'inbound',payload:Buffer.alloc(160,255).toString('base64')}}));await wait(20);
 assert.equal(Buffer.from(f.frames.find(x=>x.type==='response.output_audio.delta').delta,'base64').length,960);
 const received=once(socket,'message');f.client.emit('message',JSON.stringify({type:'input_audio_buffer.append',audio:Buffer.alloc(1280).toString('base64')}));
 assert.equal(Buffer.from(JSON.parse((await received)[0]).media.payload,'base64').length,320);
 f.client.emit('message',JSON.stringify({type:'call.dtmf',digit:'#'}));await wait(10);
 assert.ok(f.commands.some(x=>x.path.endsWith('/send_dtmf')&&x.body.digits==='#'));
 f.bridge.close();await wait(30);assert.ok(f.commands.some(x=>x.path.endsWith('/hangup')));assert.equal(f.row.confirmed,true);
});
test('cancel while Dial is pending compensates the late provider result; retry reuses command ID',async t=>{
 const f=await fixture(t,{deferDial:true,failOnce:true});f.bridge.close();await wait(10);f.resolveDial();await wait(30);
 const dials=f.commands.filter(x=>x.path==='/calls');assert.equal(dials.length,2);assert.equal(dials[0].body.command_id,dials[1].body.command_id);
 assert.ok(f.commands.some(x=>x.path.endsWith('/hangup')));assert.equal(f.row.confirmed,true);
});
test('media with wrong call identity fails closed and never forwards audio',async t=>{
 const f=await fixture(t);await f.stream({call_control_id:'another-call'});await wait(50);
 assert.equal(f.frames.some(x=>x.type==='session.created'),false);assert.ok(f.frames.some(x=>x.type==='call.ended'&&x.failed));
});
test('a media URL cannot be guessed or attached twice',async t=>{
 const f=await fixture(t);await f.stream();
 const socket=new WebSocket(f.commands[0].body.stream_url);socket.on('error',()=>{});t.after(()=>socket.terminate());
 const [,response]=await once(socket,'unexpected-response');assert.equal(response.statusCode,403);response.resume();
});

test('offline selected colleague endpoint does not dial stale gencred or another device',async()=>{
 const pool={query:async()=>({rows:[{endpoint_id:'e',selected_sip:'stale',telephony_user_name:'legacy',reachable:false}]})};
 await assert.rejects(()=>resolveWatchTarget(pool,{id:'u'},{kind:'colleague',id:'c'},env),error=>error.status===409 && error.message.includes('offline'));
});

 test('Watch caller display names satisfy the provider contract before Dial',async t=>{
 const f=await fixture(t,{callerName:"Léa O'Connor \r\n<script>"});
 assert.equal(f.commands[0].body.from_display_name,'Lea O Connor script');
 assert.equal(watchCallerDisplayName('a'.repeat(200)).length,128);
 for(const value of [null,'','🚀<>\r\n'])assert.equal(watchCallerDisplayName(value),'Contact Center');
 assert.equal(watchCallerDisplayName('Team-1_~!.+'),'Team-1_~!.+');
 });

 test('device contacts accept only normalized PSTN without uploading contact IDs or choosing caller ID',async()=>{
 const pool={query:async()=>{throw Error('Must not query the CC directory');}};
 const target=await resolveWatchTarget(pool,{id:'u'},{kind:'device_contact',id:'private-local-id',name:'Private name',destination:'+48 (22) 123-45-67',from:'+19999999999'},env);
 assert.equal(target.to,'+48221234567');assert.equal(target.id,null);assert.equal(target.name,target.to);
 assert.equal(target.from,env.TELNYX_MAIN_FROM_NUMBER);
 for(const destination of ['sip:gencred@sip.telnyx.com','123','+1234567\r\nInjected','https://example.com',{},null])
   await assert.rejects(()=>resolveWatchTarget(pool,{id:'u'},{kind:'device_contact',destination},env),{status:400});
 });
