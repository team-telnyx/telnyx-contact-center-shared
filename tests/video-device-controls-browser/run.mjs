import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import {createServer} from 'node:http';
import {build} from 'esbuild';
import puppeteer from 'puppeteer';
const root=process.cwd();
const bundle=await build({entryPoints:['tests/video-device-controls-browser/entry.jsx'],bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{'@':root},
 plugins:[{name:'network-boundaries',setup(b){
  b.onResolve({filter:/endpoint-client|ToastNotify|MessagingTransferModal|CobrowseAgentModal/},a=>({path:a.path,namespace:'stub'}));
  b.onResolve({filter:/^[^./]/},a=>{if(a.path.startsWith('@/'))return;try{return {path:require.resolve(a.path)};}catch{return;}});
  b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:a.path.includes('endpoint-client')?'export const voiceFetch=(...a)=>fetch(...a);':a.path.includes('ToastNotify')?'export const notify=()=>{};':'export default function Modal(){return null;}',loader:'js'}));
 }}]});
let owner=false,commands=0;
const server=createServer((req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);}
 else if(req.url.startsWith('/api/')){if(req.method==='POST')commands++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({deviceControl:{canControl:owner,label:owner?'Computer':'iPhone'}}));}
 else res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
// Hosted Linux CI runners do not expose Chrome's unprivileged user namespace sandbox.
const browser=await puppeteer.launch({
  headless:true,
  args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
});
try{
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>document.body.textContent.includes('Video is handled on iPhone'));
 assert(await page.$eval('button[aria-label="Accept video call"]',b=>b.disabled));
 await page.focus('span[tabindex="0"]');
 await page.waitForFunction(()=>document.querySelector('[role="tooltip"]')?.textContent.includes('Video is handled on iPhone'));
 await page.evaluate(()=>window.renderInteraction('active'));
 await page.waitForSelector('button[aria-label="Co-browse"]');
 assert(await page.$$eval('button',bs=>bs.every(b=>b.disabled)));
 assert.equal(commands,0);
 owner=true;await page.evaluate(()=>window.dispatchEvent(new Event('contact-center:acd-state')));
 await page.waitForFunction(()=>!document.querySelector('button[aria-label="Co-browse"]').disabled);
 owner=false;await page.evaluate(()=>window.dispatchEvent(new Event('contact-center:acd-state')));
 await page.waitForFunction(()=>document.querySelector('button[aria-label="Co-browse"]').disabled);
 assert.equal(commands,0);
 console.log('PASS: offered and active video controls follow the interaction owner, including co-browse.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
