#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import dotenv from 'dotenv';

const fileEnv={};
for(const file of ['.env','.env.local'])if(fs.existsSync(file))Object.assign(fileEnv,dotenv.parse(fs.readFileSync(file)));
for(const [key,value] of Object.entries(fileEnv))process.env[key]??=value;
const {getPostgresPool}=await import('../lib/postgres.mjs');
const {startGeneratorWorker}=await import('../lib/call-generator/runtime.mjs');
const {receiveGeneratorWebhook}=await import('../lib/call-generator/webhook.mjs');
const {MARKERS,markerSamples,encodeWav}=await import('../lib/call-generator/test-audio.mjs');
const pool=getPostgresPool();
if(!pool)throw new Error('Generator database is not configured');
await pool.query('SELECT event_id FROM cg_webhook_inbox LIMIT 0'); // Migrations belong to app setup.
const executorNode=`standalone-generator-${process.pid}`;
const worker=startGeneratorWorker(pool,{node:executorNode,onError:error=>console.error('Generator tick failed:',error.message)});
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/health') {
      const heartbeat=(await pool.query("SELECT heartbeat_at,node_id FROM cg_runtime_state WHERE id='executor'")).rows[0];
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,runtime:'standalone-generator',executorNode,
        webhookBaseUrl:String(process.env.CALL_GENERATOR_WEBHOOK_BASE_URL||'').replace(/\/$/,''),...heartbeat}));return;
    }
    const marker=url.pathname.match(/^\/api\/call-generator\/test-audio\/(A|B|C1|C2|C3)$/)?.[1];
    if(req.method==='GET'&&marker&&MARKERS[marker]&&process.env.CC_LIVE_VOICE_TESTS==='true') {
      res.writeHead(200,{'Content-Type':'audio/wav'});res.end(encodeWav(markerSamples(marker)));return;
    }
    if(req.method!=='POST'||url.pathname!=='/api/call-generator/webhook'){res.writeHead(404);res.end();return;}
    const chunks=[];let bytes=0;
    for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024){res.writeHead(413);res.end();return;}chunks.push(chunk);}
    const result=await receiveGeneratorWebhook(new Request('http://localhost'+url.pathname,{method:'POST',headers:req.headers,body:Buffer.concat(chunks)}),pool);
    res.writeHead(result.status,{'Content-Type':'application/json'});res.end(JSON.stringify(result.body));
  }catch{res.writeHead(503);res.end('{"error":"Generator unavailable"}');}
});
server.listen(Number(process.env.CALL_GENERATOR_PORT||3101),process.env.CALL_GENERATOR_BIND||'127.0.0.1',()=>console.log('Generator executor and signed webhook ingress ready'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{worker.stop();server.close(()=>pool.end().then(()=>process.exit(0)));});
