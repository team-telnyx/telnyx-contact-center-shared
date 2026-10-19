import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import puppeteer from 'puppeteer';
// The "Move call" dialog in a real browser: it closes only through its own buttons, a move cannot be dismissed
// while it runs, and the leg ringing here is answered or turned down with the softphone's round buttons.
const require=createRequire(import.meta.url);
const stubs={
 'navigation':`export const usePathname=()=>'/agent';`,
 'endpoint-client':`export const voiceFetch=(...a)=>fetch(...a); export const refreshVoiceEndpoints=async()=>{};
  export const voiceEndpointRegistration=()=>({id:'web-1'});
  export const subscribeVoiceEndpoints=(listener)=>{listener({endpointId:'ios-1',generation:'1',endpoints:[{id:'web-1',kind:'web',label:'Computer',reachable:true},{id:'ios-1',deviceId:'install-a',kind:'ios',label:'iPhone',reachable:true}]});return()=>{};};`,
 'agent-stream':`export const subscribeAgentStream=()=>()=>{};`,
};
const bundle=await build({entryPoints:['tests/device-handoff-dialog-browser/entry.jsx'],bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{'@':process.cwd()},
 define:{'process.env.NODE_ENV':'"test"'},
 plugins:[{name:'network',setup(b){
  b.onResolve({filter:/^next\/navigation$/},()=>({path:'navigation',namespace:'stub'}));
  b.onResolve({filter:/(endpoint-client|agent-stream)(\.m?js)?$/},a=>({path:a.path.match(/(endpoint-client|agent-stream)/)[1],namespace:'stub'}));
  b.onResolve({filter:/^[^./]/},a=>{if(a.path.startsWith('@/'))return;try{return {path:require.resolve(a.path)};}catch{return;}});
  b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:stubs[a.path],loader:'js'}));
 }}]});
const takeOver={active:true,canTakeOver:true,canStart:false,ownerId:'ios-1',ownerVersion:'3',ownerLabel:'iPhone',currentEndpointId:'web-1'};
const running=extra=>({...takeOver,canTakeOver:false,handoff:{id:'move',channel:'voice',state:'running',step:'dial_target',isTarget:true,
 sourceId:'ios-1',targetId:'web-1',targetLabel:'Computer',canCancel:true,...extra}});
let state=takeOver,commands=[];
const server=createServer(async(req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');return res.end(bundle.outputFiles[0].contents);}
 if(req.url.startsWith('/api/')){
  res.setHeader('Content-Type','application/json');
  if(req.method==='POST'){
   let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);commands.push(body);
   state=body.action==='cancel'?{...takeOver,handoff:{id:'move',state:'cancelled',error:'Handoff cancelled.',isTarget:true,sourceId:'ios-1',targetId:'web-1'}}:running();
  }
  return res.end(JSON.stringify(state));
 }
 res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await puppeteer.launch({headless:true,args:process.env.CI?['--no-sandbox','--disable-setuid-sandbox']:[]});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const page=await browser.newPage();await page.setViewport({width:1280,height:900});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const open=()=>page.evaluate(()=>!!document.querySelector('[data-testid="device-handoff-dialog"]'));
 const text=label=>page.waitForFunction(label=>Array.from(document.querySelectorAll('[data-testid="device-handoff-dialog"] button')).some(b=>b.textContent.trim()===label),{},label);
 const click=async label=>{await text(label);for(const b of await page.$$('[data-testid="device-handoff-dialog"] button'))if(await b.evaluate((el,label)=>el.textContent.trim()===label,label)){await b.click();return;}};
 const closeState=()=>page.$eval('[data-testid="handoff-close"]',el=>el.getAttribute('aria-disabled'));
 await page.evaluate(()=>window.handoffStore.getState().openHandoff('call'));
 await page.waitForSelector('[data-testid="handoff-close"]');
 // Relevant Tailwind positioning/stacking rules; the actual components supply
 // the classes, so the former z-[100] Help sheet fails the hit-target assertion.
 const layerStyles=await page.addStyleTag({content:`
   [class~="z-[1150]"]{position:fixed;inset:0;z-index:1150}
   [data-testid="device-handoff-dialog"]{position:fixed;left:100px;top:100px;width:400px;height:500px;z-index:1160}
   [data-context-help-sheet="true"]{position:fixed;right:0;top:0;width:420px;height:100vh;background:white;overflow:auto}
   [class~="z-[100]"]{z-index:100}
   [class~="z-[1300]"]{z-index:1300}
 `});
 await page.focus('[data-testid="handoff-close"]');
 await page.keyboard.press('F1');
 const help='[data-context-help-sheet="true"]';
 const helpLink=`${help} a[target="contact-center-help"]`;
 await page.waitForSelector(helpLink);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.$eval(helpLink,e=>e.scrollIntoView({block:"center"}));
 assert.equal(await page.$eval(helpLink,e=>e.getAttribute('href')),'/help/webrtc-phone/devices');
 assert.equal(await page.$eval(helpLink,e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'F1 Help must be above the real handoff overlay: '+JSON.stringify(await page.$eval(helpLink,e=>{const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {x:r.x,y:r.y,width:r.width,height:r.height,hit:hit?.outerHTML.slice(0,180),pointer:getComputedStyle(e).pointerEvents,z:getComputedStyle(e.closest('[data-context-help-sheet]')).zIndex};})));
 await page.focus(helpLink);
 assert.equal(await page.$eval(helpLink,e=>e===document.activeElement),true,'F1 Help is keyboard accessible during handoff');
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.keyboard.press('Escape');
 await page.waitForSelector(help,{hidden:true});
 assert.equal(await open(),true,'closing Help preserves the handoff dialog');
 await layerStyles.evaluate(e=>e.remove());

 await text('Take over here');
 // Close is the last control of the header, after the title: the top right corner (the bundle carries no CSS).
 const header=await page.$eval('[data-testid="handoff-close"]',el=>Array.from(el.parentElement.children).map(c=>c.getAttribute('data-testid')||c.tagName));
 assert.equal(header.at(-1),'handoff-close','X closes the header row');assert.ok(header.includes('H2'),'after the title');
 // A click beside the dialog and Escape leave it open.
 await page.mouse.click(10,10);await page.keyboard.press('Escape');await wait(300);
 assert.equal(await open(),true,'outside click and Escape do not close it');
 await click('Take over here');
 await page.waitForFunction(()=>document.querySelector('[data-testid="handoff-headline"]')?.textContent.length>0 && !document.body.textContent.includes('Take over here'));
 assert.equal(commands.at(-1).action,'take_over');
 // The move runs: nothing closes it, X included.
 assert.equal(await closeState(),'true');
 await page.click('[data-testid="handoff-close"]');await page.mouse.click(10,10);await wait(300);
 assert.equal(await open(),true,'a running move cannot be dismissed');
 assert.equal(await page.$('[data-testid="handoff-ring-controls"]'),null,'nothing rings here yet');
 // The target leg rings in this browser while the Contact Center still reports the dial: Answer and Reject at once.
 await page.evaluate(()=>window.callStore.setState({call:{id:'leg',options:{customHeaders:[{name:'X-CC-Saga-Id',value:'move'}]}},status:'ringing',direction:'inbound'}));
 await page.waitForSelector('[data-testid="handoff-ring-controls"]');
 const order=await page.$$eval('[data-testid="handoff-ring-controls"] button',bs=>bs.map(b=>b.textContent.trim()));
 assert.deepEqual(order,['Reject','Answer'],'the softphone order: Reject, then Answer');
 const looks=await page.$$eval('[data-testid="handoff-ring-controls"] button > span:first-child',spans=>spans.map(s=>[s.classList.contains('rounded-full'),s.className.match(/bg-(red|emerald)-600/)?.[1]]));
 assert.deepEqual(looks,[[true,'red'],[true,'emerald']],'round red Reject and round green Answer, as on the softphone');
 // Reject turns the move down on the Contact Center, which hangs up this leg.
 await page.click('[data-testid="handoff-reject"]');
 await page.waitForFunction(()=>document.body.textContent.includes('Try again'));
 assert.deepEqual({action:commands.at(-1).action,id:commands.at(-1).id},{action:'cancel',id:'move'});
 assert.equal(await closeState(),null,'once the move stopped, X closes again');
 await page.evaluate(()=>window.callStore.setState({call:null,status:'idle',direction:null}));
 await click('Close');
 await page.waitForFunction(()=>!document.querySelector('[data-testid="device-handoff-dialog"]'));
 // Answer asks the softphone (the audio owner) to answer; the move lands and stays on screen until the user closes it.
 state=running({step:'await_answer'});
 await page.evaluate(()=>window.handoffStore.getState().openHandoff('call'));
 await page.evaluate(()=>window.callStore.setState({call:{id:'leg-2',options:{customHeaders:[{name:'X-CC-Saga-Id',value:'move'}]}},status:'ringing',direction:'inbound'}));
 await page.waitForSelector('[data-testid="handoff-ring-controls"]');
 await page.click('[data-testid="answer-handoff-call"]');
 await page.waitForFunction(()=>window.handoffStore.getState().answerRequest===1);
 await page.evaluate(()=>window.callStore.setState({status:'active'}));
 state=running({step:'bridge_target'});
 await page.waitForFunction(()=>!document.querySelector('[data-testid="handoff-ring-controls"]'));
 assert.equal(await closeState(),'true','switching audio: still nothing to close');
 state={...takeOver,canTakeOver:false,ownerId:'web-1',ownerLabel:'Computer',handoff:{id:'move',state:'succeeded',completed:true,isTarget:true,sourceId:'ios-1',targetId:'web-1'}};
 await text('Done');await wait(2600);
 assert.equal(await open(),true,'no auto-close after success');
 assert.equal(await closeState(),null);
 await page.click('[data-testid="handoff-close"]');
 await page.waitForFunction(()=>!document.querySelector('[data-testid="device-handoff-dialog"]'));
 console.log('PASS: the Move call dialog closes only through its buttons, holds while the call moves, and answers or rejects the leg ringing here with round buttons.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
