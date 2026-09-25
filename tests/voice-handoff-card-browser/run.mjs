import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import puppeteer from 'puppeteer';
const require=createRequire(import.meta.url);
const hidden=['AgentAssist','AgentAssistWorkflow','AgentFormsView','AgentWebPagesView','TransportMcpSubmitControl','ChatInteractionDetail','EmailInteractionDetail','VideoInteractionDetail','CampaignDispositionSheet','AgentDashboard','AgentDataSources','CobrowseInteractionWorkspace','AiConversationSheet','MessagingInteractionActions','CobrowseAgentModal'];
const bundle=await build({entryPoints:['tests/voice-handoff-card-browser/entry.jsx'],bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',banner:{js:'window.process={env:{NODE_ENV:"test"}};'},alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'fixtures',setup(b){
 b.onResolve({filter:/.*/},a=>{
  const name=a.path.split('/').at(-1).replace(/\.(jsx?|mjs)$/,'');
  if(hidden.includes(name)||['endpoint-client','status-stream-client','useChatInteractions','ToastNotify','auth-provider'].includes(name))return {path:name,namespace:'fixture'};
 });
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>{
  let contents='';
  if(hidden.includes(a.path))contents=`export default function Hidden(){return null} export const ${a.path}=Hidden;`;
  if(a.path==='endpoint-client')contents='export const voiceFetch=(...args)=>fetch(...args);export const refreshVoiceEndpoints=async()=>{};';
  if(a.path==='status-stream-client')contents='export const subscribeStatusStream=()=>()=>{};';
  if(a.path==='auth-provider')contents='export const useAuth=()=>({canScreen:()=>true});';
  if(a.path==='ToastNotify')contents='export const notify=()=>{};';
  if(a.path==='useChatInteractions')contents='const feed={interactions:[],refresh:()=>{},setDesktopVisible:()=>{},clearRequestedInteraction:()=>{},requestedInteractionId:null};export const useChatInteractions=()=>feed;';
  return {contents,loader:'js'};
 });
 b.onResolve({filter:/^[^./]/},a=>{if(a.path.startsWith('@/'))return;try{return {path:require.resolve(a.path)};}catch{return;}});
}}]});
const work={id:'work',work_item_id:'work',interaction_type:'voice',state:'connected',from_name:'Test Customer',from_number:'+123456',call_control_id:'customer-leg',queue_name:'Support',agent_username:'tester',assigned_at:new Date().toISOString()};
let interactions=[work],owner='web',version=1,progress=false;const commands=[];
const server=createServer(async(req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');return res.end(bundle.outputFiles[0].contents);}
 if(req.url.startsWith('/api/')){
  res.setHeader('Content-Type','application/json');
  if(req.url.includes('/device-handoff')){
   if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;commands.push(JSON.parse(raw));progress=true;}
   return res.end(JSON.stringify({active:true,ownerId:owner,currentEndpointId:'web',ownerVersion:String(version),ownerLabel:owner==='web'?'Computer':'iPhone',canTakeOver:owner!=='web'&&!progress,handoff:progress?{id:'move',state:'running',isTarget:true,channel:'voice',step:'await_answer'}:null}));
  }
  if(req.url.includes('/agent/interactions'))return res.end(JSON.stringify({ok:true,interactions}));
  if(req.url==='/api/auth/me')return res.end(JSON.stringify({user:{id:'agent',username:'tester'}}));
  return res.end(JSON.stringify({ok:true,user:{username:'tester',status:'Busy'}}));
 }
 res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
// Hosted Linux CI runners do not expose Chrome's unprivileged user namespace sandbox.
const browser=await puppeteer.launch({
  headless:true,
  args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
});
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
 page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const card='[data-work-item-id="work"]';
 await page.waitForSelector(card);
 await page.evaluate(()=>{
  window.cardGaps=0;
  new MutationObserver(()=>{if(!document.querySelector('[data-work-item-id="work"]'))window.cardGaps++;}).observe(document.getElementById('root'),{childList:true,subtree:true});
 });
 // A stale ownership response must not turn a local hangup into a work-item tombstone.
 await page.evaluate(()=>window.localLegEnded());
 await new Promise(r=>setTimeout(r,400));
 assert.equal(await page.$eval(card,e=>e.dataset.workItemId),'work');
 assert.equal(await page.evaluate(()=>window.cardGaps),0);
 for(let move=0;move<3;move++){
  owner='phone';version++;progress=false;
  await page.evaluate(()=>window.dispatchEvent(new Event('contact-center:acd-state')));
  await page.waitForFunction(()=>{const b=document.querySelector('[data-work-item-id="work"] button[aria-label="Take over call here"]');return b&&!b.disabled;});
  await page.click(`${card} button[aria-label="Take over call here"]`);
  await page.waitForFunction(()=>document.querySelector('[data-work-item-id="work"] button[aria-label="Take over call here"]')?.disabled);
  assert.equal(commands.at(-1).action,'take_over');assert.equal(commands.at(-1).expectedOwnerId,'phone');assert.equal(commands.at(-1).expectedVersion,String(version));
  owner='web';version++;progress=false;
  await page.evaluate(()=>window.dispatchEvent(new Event('contact-center:acd-state')));
  await page.waitForFunction(()=>!document.querySelector('[data-work-item-id="work"] button[aria-label="Take over call here"]'));
  await page.evaluate(()=>window.localLegEnded());
 }
 assert.equal(await page.evaluate(()=>window.cardGaps),0,'The actual desktop card must remain present during every local disconnect');
 assert.equal(new Set(commands.map(c=>c.commandId)).size,3);
 // A real server-side completion still removes the card immediately on refresh.
 interactions=[];
 await page.evaluate(()=>window.dispatchEvent(new Event('contact-center:refresh-interactions')));
 await page.waitForFunction(()=>!document.querySelector('[data-work-item-id="work"]'));
 assert.deepEqual(errors,[]);
 console.log('PASS: actual AgentDesktop preserves card during stale ownership/local disconnect; card takeover works three times; server completion removes card.');
} finally {await browser.close();await new Promise(r=>server.close(r));}
