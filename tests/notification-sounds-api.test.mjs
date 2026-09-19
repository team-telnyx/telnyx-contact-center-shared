import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { prepareAcdTestPool } from './helpers/acd-test-db.mjs';
import { DEFAULT_NOTIFICATION_SOUNDS } from '../lib/contact-center/notification-sounds.mjs';

const pool = await prepareAcdTestPool('acd_core_test_notification_sounds');
await pool.query(`DROP TABLE IF EXISTS app_settings;
  CREATE TABLE app_settings(id text PRIMARY KEY,cc_settings jsonb,updated_by text,updated_at timestamptz);
  INSERT INTO app_settings VALUES('default','{"email_preview":{"format":"html"},"unrelated":"keep"}',NULL,now());`);
globalThis.__soundApiTest = { pool, user: { id: 'admin', username: 'admin@example.test', roles: ['admin'] } };
after(async () => { delete globalThis.__soundApiTest; await pool.end(); });

async function route(file) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const stubs = {
    'next/server': 'export const NextResponse={json:(value,options)=>Response.json(value,options)};',
    'next-auth': 'export async function getServerSession(){return globalThis.__soundApiTest.user?{user:globalThis.__soundApiTest.user}:null;}',
    '@/app/api/auth/[...nextauth]/route': 'export const authOptions={};',
    '@/lib/pgdb': 'export const PgDb={findUserById:async()=>globalThis.__soundApiTest.user,findUserByUsername:async()=>globalThis.__soundApiTest.user};',
    '@/lib/auth-server': 'export async function getAuthenticatedUser(){return globalThis.__soundApiTest.user;}',
    // The permission guard decides from the code-defined roles; keep pg, pino and the event bus out of the bundle.
    '@/lib/authz/effective.mjs': 'import { SYSTEM_ROLES, PRESET_ROLES, expandGrants, matches, normalizeKey } from "@/lib/authz/permissions.mjs"; const defs=new Map([...SYSTEM_ROLES,...PRESET_ROLES].map(r=>[r.key,r])); export async function effectiveAccess(user){const roles=(Array.isArray(user?.roles)&&user.roles.length?user.roles:["agent"]).map(r=>String(r).toLowerCase());const found=roles.map(k=>defs.get(k)).filter(Boolean);const keys=found.flatMap(d=>d.permissions);const e=expandGrants(keys);return {roles,unknownRoles:[],keys,screens:e.screens,operations:e.operations,wildcard:e.wildcard,scopes:{},definitions:found};} export function can(access,required){if(!access)return false;if(access.wildcard)return true;const key=normalizeKey(required);if(!key)return false;if(key.startsWith("screen:")){const t=key.slice(7);return [...access.screens].some(s=>s===t||s.startsWith(t+"."));}if(access.operations.has(key))return true;return access.keys.some(g=>matches(g,key));} export function canAny(access,keys=[]){return keys.some(k=>can(access,k));} export function onAuthzChanged(){return ()=>{};}',
    '@/lib/security-logging.mjs': 'export const authLogger={warn(){},info(){},error(){}};',
    '@/lib/authz/scope.mjs':'export const UNRESTRICTED={restricted:false,queueIds:null,teamAgentIds:null,agentIds:null,campaignIds:null,channels:null,selfId:null}; export async function resolveScopeForKeys(){return UNRESTRICTED;} export const queueInScope=()=>true; export const agentInScope=()=>true; export const campaignInScope=()=>true; export const channelInScope=()=>true; export const interactionInScope=()=>true; export async function workItemInScope(){return true;} export async function recordingInScope(){return true;} export const interactionScopeSql=()=>[]; export const queueScopeSql=()=>[]; export const agentScopeSql=()=>[]; export const campaignScopeSql=()=>[]; export const channelScopeSql=()=>[]; export const scopedChannels=(s,c,r)=>c?[c]:r; export async function agentUsernamesInScope(){return null;} export const restrictMonitorSnapshot=(s)=>s; export const describeScope=()=>({restricted:false});',
    '@/lib/postgres.mjs': 'export function getPostgresPool(){return globalThis.__soundApiTest.pool;}',
    '@/lib/contact-center/chat-copilot': 'export async function chatCopilotCatalog(){return {models:[],buckets:[]};}',
    '@/lib/acd/text-desktop.mjs': 'export async function readTextInteractions(){return {interactions:[],utilization:{}};}',
  };
  const result = await build({ entryPoints: [root + file], bundle: true, platform: 'node', format: 'esm', write: false,
    alias: { '@': root, zod: createRequire(import.meta.url).resolve('zod') }, plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'stub' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const admin = await route('app/api/admin/system-settings/route.js');
const agent = await route('app/api/contact-center/chat/route.js');
const request = body => new Request('http://localhost/api/admin/system-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('admin save persists all channels and agent reads the same global settings without receiving other system configuration', async () => {
  const settings = await (await admin.GET()).json();
  settings.notificationSounds = structuredClone(DEFAULT_NOTIFICATION_SOUNDS);
  settings.notificationSounds.volume = 55;
  settings.notificationSounds.channels.email = { enabled: true, sound: 'digital', loop: false };
  settings.notificationSounds.channels.whatsapp = { enabled: true, sound: 'bloom', loop: true };
  const response = await admin.PUT(request(settings)); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).notificationSounds, settings.notificationSounds);
  const stored = (await pool.query("SELECT cc_settings,updated_by FROM app_settings WHERE id='default'")).rows[0];
  assert.equal(stored.updated_by, 'admin@example.test'); assert.equal(stored.cc_settings.unrelated, 'keep');
  assert.deepEqual(stored.cc_settings.email_preview, { format: 'html' });
  globalThis.__soundApiTest.user = { id: 'agent', roles: ['agent'] };
  const projection = await (await agent.GET()).json();
  assert.deepEqual(projection.notificationSounds, settings.notificationSounds);
  assert.equal(Object.hasOwn(projection, 'cc_settings'), false); assert.equal(Object.hasOwn(projection, 'copilot'), false);
});

test('agents and anonymous callers cannot change system sounds; anonymous callers cannot read agent settings', async () => {
  assert.equal((await admin.GET()).status, 403); assert.equal((await admin.PUT(request({}))).status, 403);
  globalThis.__soundApiTest.user = null;
  // Anonymous callers are refused with 401 by the permission guard (403 is reserved for signed-in users without access).
  assert.equal((await admin.GET()).status, 401); assert.equal((await agent.GET()).status, 401);
});

test('invalid writes are atomic, and older clients omitting sounds preserve existing channel settings', async () => {
  globalThis.__soundApiTest.user = { id: 'admin', username: 'admin@example.test', roles: ['admin'] };
  const before = (await pool.query("SELECT cc_settings FROM app_settings WHERE id='default'")).rows[0].cc_settings;
  const draft = await (await admin.GET()).json();
  draft.notificationSounds.channels.chat.sound = '/arbitrary/audio';
  assert.equal((await admin.PUT(request(draft))).status, 400);
  assert.deepEqual((await pool.query("SELECT cc_settings FROM app_settings WHERE id='default'")).rows[0].cc_settings, before);
  delete draft.notificationSounds;
  assert.equal((await admin.PUT(request(draft))).status, 200);
  assert.deepEqual((await pool.query("SELECT cc_settings FROM app_settings WHERE id='default'")).rows[0].cc_settings.notification_sounds, before.notification_sounds);
});
