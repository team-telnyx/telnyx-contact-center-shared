import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { createWatchAudioRelay } from '../lib/watch-audio/relay.mjs';
import { watchAudioURL } from '../lib/watch-audio/sessions.mjs';

async function fixture(t, options={}) {
  const tickets = new Map(['a','b'].map(id=>[id,{id,user_id:id,assistant_id:'assistant-'+id,state:'issued',expires_at:new Date(Date.now()+60000)}]));
  let upstreamCount=0;
  const frames=[];
  const store={
    async authorize(req) { const row=tickets.get(req.headers.authorization?.replace('Bearer ','')); return row?.state==='ended'?null:row; },
    async claim(id) { const row=tickets.get(id); if(row.state!=='issued')return false;row.state='active';return true; },
    async heartbeat(id) { return tickets.get(id).state==='active'; },
    async end(id) { tickets.get(id).state='ended'; },
  };
  const relay=createWatchAudioRelay({store,apiKey:()=> 'server-only-secret',heartbeatMs:50,...options,
    openUpstream(url,opts) {
      upstreamCount++; assert.equal(new URL(url).hostname,'api.telnyx.com');assert.equal(opts.headers.Authorization,'Bearer server-only-secret');
      const socket=new EventEmitter();socket.readyState=0;socket.bufferedAmount=0;
      socket.send=text=>frames.push(JSON.parse(text));
      socket.close=socket.terminate=()=>{ if(socket.readyState===3)return;socket.readyState=3;socket.emit('close'); };
      setTimeout(()=>{ if(socket.readyState===3)return;socket.readyState=1;socket.emit('open');socket.emit('message',Buffer.from('{"type":"session.created"}')); },10);
      return socket;
    }});
  const server=http.createServer(async(req,res)=>{ if(!await relay.handle(req,res)){res.writeHead(404);res.end();} });
  server.on('upgrade',(req,socket,head)=>void relay.upgrade(req,socket,head));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>{relay.close();server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(path,token='a',method='GET',body) {
    return fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
  }
  return {request,base,tickets,frames,count:()=>upstreamCount};
}
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
test('public endpoints reject absent/invalid credentials without opening Telnyx',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/watch-ai/ready','wrong')).status,401);
 assert.equal((await f.request('/watch-ai/session/'+id,'wrong','PUT')).status,401);
 assert.equal(f.count(),0);
});
test('HTTPS sessions are idempotent and isolated per ticket, with ordered audio and cancellation',async t=>{
 const f=await fixture(t),path='/watch-ai/session/'+id;
 assert.equal((await f.request('/watch-ai/ready')).status,204);
 assert.equal((await f.request(path,'a','PUT')).status,201);
 assert.equal((await f.request(path,'a','PUT')).status,200);
 assert.equal((await f.request(path+'/events','b')).status,404);
 const events=await (await f.request(path+'/events')).json();assert.equal(events.events[0].frame.type,'session.created');
 const body={sequence:1,frame:{type:'input_audio_buffer.append',audio:'AAAAAA=='}};
 assert.equal((await f.request(path+'/input','a','POST',body)).status,204);
 assert.equal((await f.request(path+'/input','a','POST',body)).status,204);
 assert.equal(f.frames.filter(x=>x.type==='input_audio_buffer.append').length,1);
 assert.equal(f.count(),1);
 assert.equal((await f.request(path,'a','DELETE')).status,204);
 assert.equal((await f.request(path,'a','PUT')).status,401);
});
test('concurrent HTTP IDs for same ticket open at most one upstream',async t=>{
 const f=await fixture(t);
 const results=await Promise.all([id,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'].map(i=>f.request('/watch-ai/session/'+i,'a','PUT')));
 assert.deepEqual(results.map(x=>x.status).sort(),[201,409]);assert.equal(f.count(),1);
});
test('WebSocket uses the same ticket and blocks HTTPS duplicate calls',async t=>{
 const f=await fixture(t);
 const socket=new WebSocket(f.base.replace('http:','ws:')+'/watch-ai',{headers:{Authorization:'Bearer a'}});
 t.after(()=>socket.terminate());
 const [frame]=await once(socket,'message');assert.equal(JSON.parse(frame).type,'session.created');
 assert.equal((await f.request('/watch-ai/session/'+id,'a','PUT')).status,409);
 assert.equal(f.count(),1);
 const closed=once(socket,'close');socket.close();await closed;
});
test('revoking account session terminates existing audio',async t=>{
 const f=await fixture(t),path='/watch-ai/session/'+id;
 await f.request(path,'a','PUT'); f.tickets.get('a').state='ended';
 await new Promise(resolve=>setTimeout(resolve,90));
 assert.equal((await f.request(path+'/events')).status,401);
});
test('duration limit terminates active call',async t=>{
 const f=await fixture(t,{callLimitMs:25});await f.request('/watch-ai/session/'+id,'a','PUT');
 await new Promise(resolve=>setTimeout(resolve,60));assert.equal(f.tickets.get('a').state,'ended');
});
test('DEV and PROD URLs use WS_BASE_URL; credentials and insecure endpoints rejected',()=>{
 assert.equal(watchAudioURL({WS_BASE_URL:'wss://tunnel-ws.example.com'}),'wss://tunnel-ws.example.com/watch-ai');
 assert.equal(watchAudioURL({WS_BASE_URL:'wss://cc.example/ws'}),'wss://cc.example/ws/watch-ai');
 for(const url of ['ws://cc.example','wss://secret@cc.example','wss://cc.example?token=secret',''])assert.throws(()=>watchAudioURL({WS_BASE_URL:url}));
 assert.throws(()=>watchAudioURL({WS_BASE_URL:'wss://cc.example',WATCH_AUDIO_RELAY_REPLICAS:'2'}));
});
test('cancelling before CallKit audio releases the unused ticket without calling Telnyx',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/watch-ai/ready','a','DELETE')).status,204);
 assert.equal((await f.request('/watch-ai/session/'+id,'a','PUT')).status,401);
 assert.equal(f.count(),0);
});
