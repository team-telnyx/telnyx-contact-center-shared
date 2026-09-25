import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import puppeteer from 'puppeteer';
const require=createRequire(import.meta.url);
const bundle=await build({entryPoints:['tests/device-handoff-browser/entry.jsx'],bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{'@':process.cwd()},
 plugins:[{name:'network',setup(b){
  b.onResolve({filter:/endpoint-client/},a=>({path:a.path,namespace:'stub'}));
  b.onResolve({filter:/^[^./]/},a=>{if(a.path.startsWith('@/'))return;try{return {path:require.resolve(a.path)};}catch{return;}});
  b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export const voiceFetch=(...a)=>fetch(...a); export const refreshVoiceEndpoints=async()=>{};',loader:'js'}));
 }}]});
let state={canTakeOver:true,ownerId:'phone',ownerVersion:'7',ownerLabel:'iPhone'},commands=[];
const server=createServer(async(req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');return res.end(bundle.outputFiles[0].contents);}
 if(req.url.startsWith('/api/')){
  res.setHeader('Content-Type','application/json');
  if(req.method==='POST'){
   let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);commands.push(body);
   if(body.action==='join')return res.end(JSON.stringify({id:'move',join:{token:'test'}}));
   state={...state,canTakeOver:false,handoff:{id:'move',channel:'voice',state:'running',step:'await_answer',isTarget:true,targetLabel:'Computer',canCancel:true}};
  }
  return res.end(JSON.stringify(state));
 }
 res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
// Hosted Linux CI runners do not expose Chrome's unprivileged user namespace sandbox.
const browser=await puppeteer.launch({
  headless:true,
  args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
});
try{
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const button=async label=>{await page.waitForFunction(label=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===label),{},label);for(const b of await page.$$('button'))if(await b.evaluate((el,label)=>el.textContent.trim()===label,label)){await b.click();break;}};
 await button('Take over here');
 await page.waitForFunction(()=>document.body.textContent.includes('Answer the incoming call on this device.'));
 assert.equal(commands.length,1);assert.equal(commands[0].action,'take_over');assert.equal(commands[0].expectedOwnerId,'phone');assert.equal(commands[0].expectedVersion,'7');assert.equal(commands[0].targetId,undefined);
 state={...state,canTakeOver:true,handoff:{state:'cancelled',error:'The new call was rejected by the provider (HTTP 422).'}};
 await page.evaluate(()=>window.dispatchEvent(new Event('contact-center:acd-state')));
 await page.waitForFunction(()=>document.querySelector('[role="alert"]')?.textContent.includes('HTTP 422'));
 state={...state,canTakeOver:false,handoff:{id:'move',channel:'video',state:'running',step:'await_video',isTarget:true,canJoin:true,canCancel:true}};
 await page.evaluate(()=>window.dispatchEvent(new Event('contact-center:acd-state')));
 await button('Connect video here');await page.waitForFunction(()=>window.joined===true);
 assert.equal(commands[1].action,'join');
 state={canStart:true,ownerLabel:'Computer'};
 await page.evaluate(()=>window.dispatchEvent(new Event('contact-center:acd-state')));
 await page.waitForFunction(()=>document.body.textContent.includes('To move it, open this interaction on the other device'));
 assert.equal(await page.$$eval('button',bs=>bs.filter(b=>b.textContent.includes('Take over here')).length),0);
 // The same mounted interaction must offer takeover again after every round trip.
 for (let version=8;version<=11;version++) {
  state={canTakeOver:true,active:true,currentEndpointId:'web',ownerId:'phone',ownerVersion:String(version),ownerLabel:'iPhone',handoff:{id:`old-${version}`,state:'succeeded',completed:true}};
  await page.evaluate(()=>window.dispatchEvent(new Event('contact-center:acd-state')));
  await button('Take over here');
  await page.waitForFunction(()=>document.body.textContent.includes('Answer the incoming call on this device.'));
  const command=commands.at(-1);
  assert.equal(command.expectedVersion,String(version));
  assert.equal(command.expectedOwnerId,'phone');
  assert.equal(command.action,'take_over');
  state={canTakeOver:false,active:true,currentEndpointId:'web',ownerId:'web',ownerVersion:String(version+1),ownerLabel:'Computer',handoff:{state:'succeeded',completed:true}};
  await page.evaluate(()=>window.dispatchEvent(new Event('contact-center:acd-state')));
  await page.waitForFunction(()=>document.body.textContent.includes('To move it, open this interaction on the other device'));
 }
 assert.equal(new Set(commands.filter(c=>c.action==='take_over').map(c=>c.commandId)).size,5);
 console.log('PASS: target initiates takeover with an owner fence, sees ringing/provider errors, joins video; source cannot accidentally push.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
