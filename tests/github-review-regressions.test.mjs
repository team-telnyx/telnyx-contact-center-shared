import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const root=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(new URL('../package.json',import.meta.url));
// Routes import the permission guard; keep its database, event-bus and logger
// dependencies out of the bundle so nothing opens connections or timers here.
const guardMocks={
  '@/lib/pgdb': 'export const PgDb={findUserById:async()=>{throw new Error("Unexpected stream database lookup");}};',
  '@/lib/authz/effective.mjs': 'import { SYSTEM_ROLES, PRESET_ROLES, expandGrants, matches, normalizeKey } from "@/lib/authz/permissions.mjs"; const defs=new Map([...SYSTEM_ROLES,...PRESET_ROLES].map(r=>[r.key,r])); export async function effectiveAccess(user){const roles=(Array.isArray(user?.roles)&&user.roles.length?user.roles:["agent"]).map(r=>String(r).toLowerCase());const found=roles.map(k=>defs.get(k)).filter(Boolean);const keys=found.flatMap(d=>d.permissions);const e=expandGrants(keys);return {roles,unknownRoles:[],keys,screens:e.screens,operations:e.operations,wildcard:e.wildcard,scopes:{},definitions:found};} export function can(access,required){if(!access)return false;if(access.wildcard)return true;const key=normalizeKey(required);if(!key)return false;if(key.startsWith("screen:")){const t=key.slice(7);return [...access.screens].some(s=>s===t||s.startsWith(t+"."));}if(access.operations.has(key))return true;return access.keys.some(g=>matches(g,key));} export function canAny(access,keys=[]){return keys.some(k=>can(access,k));} export function onAuthzChanged(){return ()=>{};}',
  '@/lib/security-logging.mjs':'export const authLogger={warn(){},info(){},error(){}};',
  '@/lib/authz/scope.mjs':'export const UNRESTRICTED={restricted:false,queueIds:null,teamAgentIds:null,agentIds:null,campaignIds:null,channels:null,selfId:null}; export async function resolveScopeForKeys(){return UNRESTRICTED;} export const queueInScope=()=>true; export const agentInScope=()=>true; export const campaignInScope=()=>true; export const channelInScope=()=>true; export const interactionInScope=()=>true; export async function workItemInScope(){return true;} export async function recordingInScope(){return true;} export const interactionScopeSql=()=>[]; export const queueScopeSql=()=>[]; export const agentScopeSql=()=>[]; export const campaignScopeSql=()=>[]; export const channelScopeSql=()=>[]; export const scopedChannels=(s,c,r)=>c?[c]:r; export async function agentUsernamesInScope(){return null;} export const restrictMonitorSnapshot=(s)=>s; export const describeScope=()=>({restricted:false});',
};
async function load(entry,userMocks={},globals={}) {
  const mocks={...guardMocks,...userMocks};
  const result=await build({entryPoints:[root+entry],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',alias:{'@':root},jsx:'automatic',plugins:[{name:'test-boundaries',setup(builder){
    builder.onResolve({filter:/.*/},args=>Object.hasOwn(mocks,args.path)?{path:args.path,namespace:'mock'}:undefined);
    builder.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path]}));
  }}]});
  const module={exports:{}};
  // `process` is needed since routes import the permission guard, whose loggers read process.env.
  vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require,console,URL,URLSearchParams,process,global:globalThis,Buffer,AbortController,Headers,setTimeout,clearTimeout,setInterval,clearInterval,TextEncoder,TextDecoder,...globals});
  return module.exports;
}

test('actual timeline renders transfer wrap-up cards even without whole-second sequential phases',async()=>{
  const {default:Timeline}=await load('components/contact-center/InteractionTimeline.jsx');
  const start={type:'wrapup_start',segmentId:'s1',outcome:'transferred',agentName:'Alice',timestamp:'2026-09-14T12:00:00Z'};
  const wrapups=[start,{...start,type:'wrapup_end',timestamp:'2026-09-14T12:00:30Z'}];
  const render=events=>renderToStaticMarkup(React.createElement(Timeline,{events,channel:'email'}));
  for(const events of [wrapups,[...wrapups,{type:'connected',timestamp:start.timestamp},{type:'disconnected',timestamp:'2026-09-14T12:00:00.500Z'}]]) {
    const html=render(events);assert.match(html,/data-testid="transfer-wrapup-segment"/);assert.match(html,/Alice/);assert.match(html,/30s/);
  }
  const normal=render([...wrapups,{type:'connected',timestamp:start.timestamp},{type:'disconnected',timestamp:'2026-09-14T12:01:00Z'}]);
  assert.match(normal,/data-testid="transfer-wrapup-segment"/);assert.match(normal,/Total/);
  assert.match(render([]),/No timeline events recorded/);
});

test('agent calls endpoint reports missing joined state Offline and never writes state',async()=>{
  const fixture={agent:{id:'new-agent',username:'new@example.com',first_name:'New',last_name:'Agent',state_agent_id:null,presence:null,workflow_state:null,manual_status:null},queries:[]};
  const {GET}=await load('app/api/contact-center/agents/[userId]/calls/route.js',{
    'next/server':'export const NextResponse={json:(body,options)=>({body,status:options?.status||200})};',
    '@/lib/auth-server':'export async function getAuthenticatedUser(){return {roles:["supervisor"]};}',
    '@/lib/postgres.mjs':'export function getPostgresPool(){return {query:async(sql)=>{fixture.queries.push(sql);return {rows:[fixture.agent]};}};}',
    '@/lib/acd/reporting-scope.mjs':'export async function resolveReportingScope(){return {};}',
    '@/lib/acd/workforce-reports.mjs':'export async function agentAdherenceReport(){return {agents:[]};}',
    '@/lib/acd/realtime-queue-calls.mjs':'export async function getAcdRealtimeAgentCalls(){return [];} export async function enrichAcdRealtimeCalls(pool,calls){return calls;}',
    '@/lib/runtime-logging.mjs':'export const contactCenterRuntimeLogger={error:()=>{}}; export const runtimePayload=x=>x;',
  },{fixture});
  const request={url:'http://localhost/api/contact-center/agents/new-agent/calls'};
  assert.equal((await GET(request,{params:Promise.resolve({userId:'new-agent'})})).body.agent.status,'Offline');
  assert.match(fixture.queries[0],/ast.agent_id AS state_agent_id/);
  for(const [state,expected] of [
    [{presence:'online',manual_status:'Available',workflow_state:'idle'},'Available'],
    [{presence:'online',manual_status:'Available',workflow_state:'handling'},'Busy'],
    [{presence:'online',manual_status:'Available',workflow_state:'wrapup'},'Wrapup'],
    [{presence:'offline',manual_status:'Available',workflow_state:'idle'},'Offline'],
  ]) {
    fixture.agent={...fixture.agent,...state,state_agent_id:'new-agent'};
    const response=await GET(request,{params:{userId:'new-agent'}});
    assert.equal(response.status,200);assert.equal(response.body.agent.status,expected);
  }
  assert(fixture.queries.every(sql=>sql.trim().startsWith('SELECT')));
});

test('analytics queue inventory includes queues without history and enforces supervisor access',async()=>{
  const {prepareAcdTestPool,seedQueue}=await import('./helpers/acd-test-db.mjs');
  const pool=await prepareAcdTestPool('acd_core_test_review_queue_inventory');
  try {
    for(const id of ['skills-only','active-handoff','historical-disabled']) await seedQueue(pool,id,[],{name:id});
    await pool.query("UPDATE cc_queues SET enabled=false WHERE id='historical-disabled'");
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM acd_work_items')).rows[0].count,0);
    const fixture={pool,user:{roles:['supervisor']},reads:0};
    const {GET}=await load('app/api/contact-center/analytics/queues/route.js',{
      'next/server':'export const NextResponse={json:(body,options)=>({body,status:options?.status||200,headers:new Headers(options?.headers)})};',
      '@/lib/auth-server':'export async function getAuthenticatedUser(){return fixture.user;}',
      '@/lib/postgres.mjs':'export function getPostgresPool(){return {query:async(sql)=>{fixture.reads++;return fixture.pool.query(sql);}};}',
    },{fixture});
    const response=await GET();assert.equal(response.status,200);
    assert.deepEqual([...response.body.queues],['active-handoff','historical-disabled','skills-only']);
    assert.equal(response.headers.get('Cache-Control'),'private, no-store');
    fixture.user=null;assert.equal((await GET()).status,401);
    fixture.user={roles:['agent']};assert.equal((await GET()).status,403);
    assert.equal(fixture.reads,1,'unauthorized users cannot query inventory');
  } finally {await pool.end();}
});
