import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRoute } from './helpers/route-harness.mjs';
import { emptyScopes, expandGrants, isSubsetOf } from '../lib/authz/permissions.mjs';
import { effectiveAccess, can, scopeFor, loadRoleDefinitions, invalidateRoleDefinitions } from '../lib/authz/effective.mjs';
import { resolveScope, interactionInScope, interactionScopeSql, workItemInScope } from '../lib/authz/scope.mjs';
import { guardEventStream } from '../lib/authz/stream.mjs';
import * as formSchema from '../lib/forms/form-schema.js';
// This file uses mock pools. A CI PostgreSQL environment must not start a real
// LISTEN connection when the policy-cache test loads its synthetic definitions.
process.env.AUTHZ_BUS = 'off';
const quiet = { error() {}, warn() {}, info() {} };
const logging = { adminRuntimeLogger: quiet, contactCenterRuntimeLogger: quiet, runtimePayload: () => ({}) };
const user = { id: 'caller', username: 'caller@test', roles: ['test-role'], active: true };
const role = (permissions, scopes = emptyScopes(), key = 'test-role') => ({ key, permissions, scopes });
const req = (method, body) => new Request('http://test.local/api/test', { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
function deps(pool, roles, extra = {}) { return {
  authzRoles: roles,
  '@/lib/auth-server': { getAuthenticatedUser: async () => ({ ...user, roles: roles.map(r => r.key) }) },
  '@/lib/postgres.mjs': { getPostgresPool: () => pool },
  '@/lib/runtime-logging.mjs': logging,
  ...extra,
}; }
const memberPool = { query: async (sql, args) => ({ rows: sql.includes('agent_groups &&') ? args[0].map(id => ({ id: `member-${id}` })) : [] }) };

test('user detail preserves invitation status and dates while excluding the invite token', async () => {
  const profile = { id: 'target', username: 'target@test', invite_status: 'accepted', invite_sent_at: '2026-09-01T12:00:00Z', invite_accepted_at: '2026-09-02T12:00:00Z', invite_token_expires: '2026-09-08T12:00:00Z' };
  const row = { ...profile, invite_token: 'secret-invite-token' };
  const route = await loadRoute('app/api/admin/users/[id]/route.js', deps({ query: async sql => ({ rows: sql.includes('FROM users') ? [row] : [] }) }, [role(['users:read'])]));
  const response = await route.GET(req('GET'), { params: { id: 'target' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ...profile, queue_assignments: [] });
});

test('F01: user detail returns an allowlisted DTO even when the database row contains credentials', async () => {
  const row = { id: 'target', username: 'target@test', active: true, roles: ['agent'], hash: 'secret', salt: 'secret', iterations: 25000, refresh_tokens: ['secret'], reset_password_token: 'secret', activation_token: 'secret', telephony_credentials_id: 'secret', future_secret: 'secret' };
  const route = await loadRoute('app/api/admin/users/[id]/route.js', deps({ query: async sql => ({ rows: sql.includes('FROM users') ? [row] : [] }) }, [role(['users:read'])]));
  const response = await route.GET(req('GET'), { params: { id: 'target' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { id: 'target', username: 'target@test', roles: ['agent'], active: true, queue_assignments: [] });
});

for (const [resource, assign, memberField, anchor] of [['teams', 'members.assign', 'memberIds', 'teams'], ['queues', 'agents.assign', 'userAssignments', 'queues']]) {
  test(`F02: ${resource} rejects cross-action scope lending before every write`, async () => {
    let writes = 0;
    const roles = [role([`${resource}:update`], { ...emptyScopes(), [anchor]: { mode: 'list', ids: ['a'] } }, 'update-a'), role([`${resource}:${assign}`], { ...emptyScopes(), [anchor]: { mode: 'list', ids: ['b'] } }, 'assign-b')];
    const pool = { query: async (sql, args) => { if (/^(UPDATE|INSERT|DELETE)/.test(sql)) writes++; return memberPool.query(sql, args); } };
    const route = await loadRoute(`app/api/admin/${resource}/[id]/route.js`, deps(pool, roles, {
      '@/lib/teams/store.mjs': { updateTeam: async () => { writes++; return {}; }, TeamStoreError: class extends Error {} },
      '@/lib/acd/utilization.mjs': { saveAdminSettings: async () => { writes++; } },
    }));
    assert.equal((await route.PUT(req('PUT', { name: 'forbidden' }), { params: { id: 'b' } })).status, 403);
    assert.equal((await route.PUT(req('PUT', { [memberField]: [] }), { params: { id: 'a' } })).status, 403);
    assert.equal((await route.PUT(req('PUT', { name: 'mixed', [memberField]: [] }), { params: { id: 'b' } })).status, 403);
    assert.equal(writes, 0);
    assert.equal((await route.PUT(req('PUT', { name: 'allowed' }), { params: { id: 'a' } })).status, 200);
    assert.equal((await route.PUT(req('PUT', { [memberField]: [] }), { params: { id: 'b' } })).status, 200);
    assert.equal(writes, 2);
  });
}

for (const source of ['web-id', 'web-email', 'bearer', 'query']) {
  test(`F03: inactive users cannot authenticate via ${source}`, async () => {
    let active = false;
    const route = await loadRoute('lib/auth-server.js', {
      'next-auth': { getServerSession: async () => ({ user: source === 'web-email' ? { email: 'caller@test' } : { id: 'caller' } }) },
      'next/headers': { headers: async () => new Headers(source === 'bearer' ? { authorization: 'Bearer test' } : {}) },
      '@/lib/jwt': { verifyAccessToken: async () => ({ sub: 'caller' }) },
      '@/lib/pgdb': { PgDb: { findUserById: async () => ({ ...user, active }), findUserByUsername: async () => ({ ...user, active }) } },
      '@/lib/security-logging.mjs': { authLogger: quiet, securityErrorPayload: () => ({}) },
    });
    const url = source === 'query' ? 'http://test.local/audio?token=test' : null;
    assert.equal(await route.getAuthenticatedUser(url), null);
    active = true;
    assert.equal((await route.getAuthenticatedUser(url)).id, user.id);
  });
}

test('F03: stream revocation discards buffered data and aborts its producer', async () => {
  let permitted = true, aborts = 0, source;
  const response = new Response(new ReadableStream({ start(c) { source = c; } }), { headers: { 'content-type': 'text/event-stream' } });
  const guarded = guardEventStream(response, { authorize: async () => permitted, abort: () => aborts++, intervalMs: 10000 });
  const reader = guarded.body.getReader();
  source.enqueue(new TextEncoder().encode('allowed'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'allowed');
  permitted = false;
  source.enqueue(new TextEncoder().encode('forbidden'));
  assert.equal((await reader.read()).done, true);
  assert.equal(aborts, 1);
});

test('F04: correlated team/channel grants agree for predicates, segments, SQL and delegation', async () => {
  const definitions = [role(['interactions:read'], { ...emptyScopes(), teams: { mode: 'list', ids: ['a'] }, channels: { mode: 'list', ids: ['voice'] } }, 'a-voice'), role(['interactions:read'], { ...emptyScopes(), teams: { mode: 'list', ids: ['b'] }, channels: { mode: 'list', ids: ['sms'] } }, 'b-sms')];
  const actor = { ...user, roles: definitions.map(r => r.key) };
  const access = await effectiveAccess(actor, new Map(definitions.map(r => [r.key, r])));
  const scope = await resolveScope(memberPool, actor, access, 'interactions:read');
  for (const [agent, channel, allowed] of [['a','voice',true], ['b','sms',true], ['a','sms',false], ['b','voice',false]]) {
    assert.equal(interactionInScope(scope, { agentIds: [`member-${agent}`], channel }), allowed);
    assert.equal(await workItemInScope(memberPool, scope, null, { agentId: `member-${agent}`, channel }), allowed);
  }
  const params = [];
  const sql = interactionScopeSql(scope, { agent: 'i.agent_id', channel: 'i.channel' }, params).join(' AND ');
  assert.match(sql, /AND.*OR.*AND/);
  assert.deepEqual(params, [['voice'], ['member-a', 'caller'], ['sms'], ['member-b', 'caller']]);
  const candidate = { ...emptyScopes(), teams: { mode: 'list', ids: ['a'] }, channels: { mode: 'list', ids: ['sms'] } };
  assert.equal(isSubsetOf(['interactions:read'], candidate, expandGrants(access.keys), key => scopeFor(access, key)).ok, false);
  assert.equal(isSubsetOf(['interactions:read'], definitions[0].scopes, expandGrants(access.keys), key => scopeFor(access, key)).ok, true);
});

test('F05: policy read failure never restores preset/system defaults or stale grants', async () => {
  invalidateRoleDefinitions();
  const failed = { query: async () => { throw new Error('simulated policy outage'); } };
  for (const roles of [['owner'], ['campaign-manager']]) {
    const definitions = await loadRoleDefinitions(failed, { force: true });
    assert.equal(can(await effectiveAccess({ roles }, definitions), 'campaigns:delete'), false);
  }
  const persisted = { query: async () => ({ rows: [{ id: 'custom', permissions: ['users:delete'], scopes: emptyScopes() }] }) };
  await loadRoleDefinitions(persisted, { force: true });
  const definitions = await loadRoleDefinitions(failed, { force: true });
  assert.equal(can(await effectiveAccess({ roles: ['custom'] }, definitions), 'users:delete'), false);
  invalidateRoleDefinitions();
});

for (const method of ['POST', 'PUT']) {
  test(`F06: ${method} cannot publish through ordinary CRUD; authorized publication remains possible`, async () => {
    let writes = 0, currentStatus = 'draft';
    const pool = { query: async sql => { if (/^(INSERT|UPDATE)/.test(sql)) { writes++; return { rows: [{ id: 'form', status: 'published' }] }; } return { rows: [{ status: currentStatus }] }; } };
    const path = `app/api/admin/forms/${method === 'PUT' ? '[id]/' : ''}route.js`;
    const body = formSchema.createDefaultForm({ name: 'Security test', status: 'published' });
    const route = await loadRoute(path, deps(pool, [role([method === 'PUT' ? 'forms:update' : 'forms:create'])], { '@/lib/forms/form-schema': formSchema }));
    assert.equal((await route[method](req(method, body), { params: { id: 'form' } })).status, 403);
    assert.equal(writes, 0);
    if (method === 'PUT') {
      currentStatus = 'published';
      assert.equal((await route.PUT(req('PUT', { ...body, status: 'draft' }), { params: { id: 'form' } })).status, 403);
      assert.equal(writes, 0);
    }
    const publisher = await loadRoute(path, deps(pool, [role([method === 'PUT' ? 'forms:update' : 'forms:create', 'forms:publish'])], { '@/lib/forms/form-schema': formSchema }));
    assert.equal((await publisher[method](req(method, body), { params: { id: 'form' } })).status, 200);
    assert.equal(writes, 1);
  });
}

for (const permission of ['campaigns:read', 'contact_lists:read', 'dnc_lists:read', 'dialer_filters:read', 'dialer_time_sets:read', 'dialer_attempt_controls:read', 'dialer_settings:read', 'disposition_codes:read']) {
  test(`F07/F08: aggregate admits ${permission} alone and never queries unrelated resources`, async () => {
    const queries = [];
    const pool = { query: async sql => { queries.push(sql); return { rows: [] }; } };
    const identity = row => row;
    const api = { getOutboundPool: () => pool, loadOutboundContactLists: async () => { queries.push('outbound_contact_lists'); return { rows: [] }; }, outboundSchemaPayload: {}, ...Object.fromEntries(['mapCampaign','mapContactList','mapDncList','mapForm','mapHandlerReference','mapOutboundAttemptControl','mapOutboundFilter','mapOutboundSettings','mapOutboundTimeSet'].map(k => [k, identity])) };
    const route = await loadRoute('app/api/contact-center/outbound-dialer/route.js', deps(pool, [role([permission])], { '@/lib/outbound-dialer/api': api, '@/lib/outbound-dialer/logging.mjs': { campaignsLogger: quiet, outboundErrorPayload: () => ({}) } }));
    const response = await route.GET(req('GET'), {});
    assert.equal(response.status, 200);
    assert.equal(queries.length, permission === 'disposition_codes:read' ? 0 : 1);
    if (permission !== 'dialer_settings:read') assert.equal(response.body.settings, null);
    assert.deepEqual(response.body.inventoryNumbers, []);
    assert.deepEqual(response.body.handlerReferences, { queue: [], call_flow: [], workflow: [], ai_assistant: [] });
  });
}

test('campaign execution checks pause versus execute scope before runtime side effects', async () => {
  const roles = [role(['campaigns:execute'], { ...emptyScopes(), campaigns: { mode: 'list', ids: ['a'] } }, 'execute-a'), role(['campaigns:pause'], { ...emptyScopes(), campaigns: { mode: 'list', ids: ['b'] } }, 'pause-b')];
  let reads = 0;
  const pool = { query: async () => { reads++; return { rows: [] }; } };
  const route = await loadRoute('app/api/contact-center/outbound-dialer/campaigns/[campaignId]/execution/route.js', deps(pool, roles, { '@/lib/outbound-dialer/api': { getOutboundPool: () => pool, jsonError: (error,status) => ({status,body:{error}}) }, '@/lib/outbound-dialer/logging.mjs': { executionLogger: quiet, outboundErrorPayload: () => ({}) } }));
  for (const [id,action] of [['b','start'],['a','pause'],['a','resume'],['b','tick']]) assert.equal((await route.POST(req('POST',{action}),{params:{campaignId:id}})).status,403);
  assert.equal(reads,0);
  assert.equal((await route.POST(req('POST',{action:'pause'}),{params:{campaignId:'b'}})).status,404, 'right action reaches the target lookup');
  assert.equal(reads,1);
});

test('delegation accepts a union when all candidate combinations are actually covered', async () => {
  const scopes = channel => ({ ...emptyScopes(), teams: { mode: 'list', ids: ['a'] }, channels: { mode: 'list', ids: [channel] } });
  const defs = [role(['interactions:read'], scopes('voice'), 'voice'), role(['interactions:read'], scopes('sms'), 'sms')];
  const access = await effectiveAccess({ roles: ['voice','sms'] }, new Map(defs.map(d => [d.key,d])));
  const candidate = { ...scopes('voice'), channels: { mode: 'list', ids: ['voice','sms'] } };
  assert.equal(isSubsetOf(['interactions:read'], candidate, expandGrants(access.keys), key => scopeFor(access,key)).ok, true);
});
