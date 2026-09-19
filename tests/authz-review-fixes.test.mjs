// Fixes from the Codex review of PR #1480 (the internal documentation).
// Users routes: the legacy upsert path follows the assignment rules, role and
// queue changes need their named grants, queue changes stay in scope, and the
// last-owner check is repeated under the transaction lock.
import test from "node:test";
import assert from "node:assert/strict";
import { loadRoute } from "./helpers/route-harness.mjs";
import { USERS } from "./helpers/authz-harness.mjs";
import { SYSTEM_ROLES, PRESET_ROLES, emptyScopes } from "../lib/authz/permissions.mjs";
import { effectiveAccess as realEffectiveAccess } from "../lib/authz/effective.mjs";
import * as rolesStore from "../lib/authz/roles-store.mjs";

const CUSTOM_ROLES = [
  { key: "user-creator", name: "User creator", permissions: ["users:read", "users:create", "users:update"], scopes: emptyScopes() },
  { key: "profile-editor", name: "Profile editor", permissions: ["users:read", "users:update"], scopes: emptyScopes() },
  { key: "scoped-user-admin", name: "Scoped user admin", permissions: ["users:*", "queues:agents.assign", "roles:read"], scopes: { ...emptyScopes(), queues: { mode: "list", ids: ["q-sales"] } } },
];
const catalogue = new Map([...SYSTEM_ROLES, ...PRESET_ROLES, ...CUSTOM_ROLES].map((r) => [r.key, r]));
const creator = { id: "creator-1", username: "creator@test.local", roles: ["user-creator"] };
const editor = { id: "editor-1", username: "editor@test.local", roles: ["profile-editor"] };
const scopedAdmin = { id: "scoped-1", username: "scoped@test.local", roles: ["scoped-user-admin"] };
const quiet = { error() {}, warn() {}, info() {}, debug() {} };

function makePool(state) {
  const calls = [];
  const pool = {
    calls,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      calls.push({ text, params });
      if (text.startsWith("SELECT id, roles FROM users WHERE LOWER(username)")) return { rows: state.byUsername?.[String(params[0]).toLowerCase()] ? [state.byUsername[String(params[0]).toLowerCase()]] : [] };
      if (text.startsWith("SELECT roles FROM users WHERE id=$1")) return { rows: state.byId?.[params[0]] ? [{ roles: state.byId[params[0]].roles }] : [] };
      if (text.startsWith("SELECT id, permissions, scopes, is_system FROM cc_roles WHERE id = ANY")) return { rows: CUSTOM_ROLES.filter((r) => params[0].includes(r.key)).map((r) => ({ id: r.key, permissions: r.permissions, scopes: r.scopes, is_system: false })) };
      if (text.startsWith("SELECT COUNT(*)::int AS c FROM users WHERE 'owner' = ANY(roles)")) { const answers = state.ownerCounts || [1]; return { rows: [{ c: answers.length > 1 ? answers.shift() : answers[0] }] }; }
      if (text.startsWith("SELECT queue_id FROM cc_queue_user_assignments")) return { rows: (state.assignments || []).map((queue_id) => ({ queue_id })) };
      if (text.startsWith("SELECT DISTINCT user_id FROM cc_queue_user_assignments")) return { rows: [{ user_id: "u1" }] }; // u1 works the in-scope queue
      return { rows: [] };
    },
    async connect() { return { query: pool.query, release() {} }; },
  };
  return pool;
}

function deps(user, pool, more = {}) {
  return {
    authzRoles: CUSTOM_ROLES,
    "@/lib/auth-server": { getAuthenticatedUser: async () => user },
    "@/lib/postgres.mjs": { getPostgresPool: () => pool },
    "@/lib/acd/utilization.mjs": { saveAdminSettings: async (p, o, fn) => fn(p, []) },
    "@/lib/acd/agent-state.mjs": { effectiveAgentStatusSql: () => "'Available'", ensureAgentState: async () => {}, setManualAgentStatus: async () => {} },
    "@/lib/runtime-logging.mjs": { adminRuntimeLogger: quiet, contactCenterRuntimeLogger: quiet, platformApiLogger: quiet, platformDbLogger: quiet, voiceRuntimeLogger: quiet, runtimePayload: (v) => v },
    "@/lib/authz/effective.mjs": { effectiveAccess: (u) => realEffectiveAccess(u, catalogue), publishAuthzChanged: async () => {} },
    "@/lib/authz/roles-store.mjs": rolesStore,
    "@/lib/email/invites.mjs": { sendInviteEmail: async () => {} },
    crypto: { randomUUID: () => "new-user", randomBytes: () => Buffer.alloc(16) },
    ...more,
  };
}

const json = (url, method, body) => new Request(`https://cc.test${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("the legacy upsert path of POST /api/admin/users follows the role assignment rules", async () => {
  const upserts = [];
  const pool = makePool({ byUsername: { "victim@test.local": { id: "victim-1", roles: ["agent"] } } });
  const pgdb = { PgDb: { upsertUserByUsername: async (username, fields) => { upserts.push({ username, fields }); return "victim-1"; }, findUserById: async () => null, updateUserById: async () => {} } };
  const asCreator = await loadRoute("app/api/admin/users/route.js", deps(creator, pool, { "@/lib/pgdb": pgdb }));
  const ownerGrab = await asCreator.POST(json("/api/admin/users", "POST", { username: "victim@test.local", roles: ["owner"] }));
  assert.equal(ownerGrab.status, 403);
  assert.match(ownerGrab.body.error, /Only an owner can grant or revoke the Owner role/);
  const escalate = await asCreator.POST(json("/api/admin/users", "POST", { username: "victim@test.local", roles: ["agent", "supervisor"] }));
  assert.equal(escalate.status, 403, "delegation applies: the creator does not hold supervisor");
  assert.match(escalate.body.error, /hold yourself/);
  assert.deepEqual(upserts, [], "nothing is written before the rules pass");
  const keep = await asCreator.POST(json("/api/admin/users", "POST", { username: "victim@test.local", nick: "V" }));
  assert.equal(keep.status, 200, JSON.stringify(keep.body));
  assert.deepEqual(upserts.at(-1).fields.roles, ["agent"], "an upsert without roles keeps the current roles instead of resetting them");

  const asOwner = await loadRoute("app/api/admin/users/route.js", deps(USERS.owner, pool, { "@/lib/pgdb": pgdb }));
  const promoted = await asOwner.POST(json("/api/admin/users", "POST", { username: "victim@test.local", roles: ["agent", "supervisor"] }));
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.deepEqual(upserts.at(-1).fields.roles, ["agent", "supervisor"]);
  assert.ok(pool.calls.some((c) => c.text.startsWith("INSERT INTO cc_authz_audit")), "the role change is audited");
  const creatorOnly = { ...creator, roles: ["user-creator"] };
  const asCreatorNew = await loadRoute("app/api/admin/users/route.js", deps(creatorOnly, makePool({ byUsername: {} }), { "@/lib/pgdb": pgdb }));
  const newAgent = await asCreatorNew.POST(json("/api/admin/users", "POST", { username: "fresh@test.local", roles: ["agent"] }));
  assert.equal(newAgent.status, 200, "a new agent needs no roles:assign grant (D-23)");
});

test("creating a user with more than the base role or with queues needs the named grants", async () => {
  const pgdb = { PgDb: { upsertUserByUsername: async () => "x", findUserById: async () => null, updateUserById: async () => {} } };
  const asCreator = await loadRoute("app/api/admin/users/route.js", deps(creator, makePool({}), { "@/lib/pgdb": pgdb }));
  const supervisor = await asCreator.POST(json("/api/admin/users", "POST", { username: "new@test.local", firstName: "N", lastName: "U", roles: ["agent", "supervisor"], sendInvite: false }));
  assert.equal(supervisor.status, 403);
  const queues = await asCreator.POST(json("/api/admin/users", "POST", { username: "new@test.local", firstName: "N", lastName: "U", roles: ["agent"], queueIds: ["q-sales"], sendInvite: false }));
  assert.equal(queues.status, 403);
  assert.equal(queues.body.permission, "queues:agents.assign");
  const asScoped = await loadRoute("app/api/admin/users/route.js", deps(scopedAdmin, makePool({}), { "@/lib/pgdb": pgdb }));
  const outside = await asScoped.POST(json("/api/admin/users", "POST", { username: "new@test.local", firstName: "N", lastName: "U", roles: ["agent"], queueIds: ["q-other"], sendInvite: false }));
  assert.equal(outside.status, 403);
  assert.match(outside.body.error, /outside your data scope/);
});

test("PUT /api/admin/users/[id] separates profile edits from role and queue changes and keeps queues in scope", async () => {
  const load = (user, state) => loadRoute("app/api/admin/users/[id]/route.js", deps(user, makePool(state), { "@/lib/pgdb": { PgDb: { findUserById: async () => ({ id: "u1" }), updateUserById: async () => {} } } }));
  const put = (route, body) => route.PUT(json("/api/admin/users/u1", "PUT", body), { params: Promise.resolve({ id: "u1" }) });
  const asEditor = await load(editor, { byId: { u1: { roles: ["agent", "supervisor"] } } });
  assert.equal((await put(asEditor, { firstName: "Renamed" })).status, 200, "profile edits stay with users:update");
  const strip = await put(asEditor, { roles: ["agent"] });
  assert.equal(strip.status, 403);
  assert.equal(strip.body.permission, "users:roles.assign");
  const queues = await put(asEditor, { queueIds: ["q-sales"] });
  assert.equal(queues.status, 403);
  assert.equal(queues.body.permission, "queues:agents.assign");

  const asScoped = await load(scopedAdmin, { byId: { u1: { roles: ["agent"] } }, assignments: [] });
  const outside = await put(asScoped, { queueIds: ["q-other"] });
  assert.equal(outside.status, 403);
  assert.match(outside.body.error, /outside your data scope/);
  assert.equal((await put(asScoped, { queueIds: ["q-sales"] })).status, 200);
  const asScopedRemoving = await load(scopedAdmin, { byId: { u1: { roles: ["agent"] } }, assignments: ["q-other"] });
  assert.equal((await put(asScopedRemoving, { queueIds: [] })).status, 403, "removing an assignment outside the scope is refused too");
});

test("demoting an owner re-checks the owner count inside the transaction", async () => {
  const route = await loadRoute("app/api/admin/users/[id]/route.js", deps(USERS.owner, makePool({ byId: { u1: { roles: ["owner"] } }, ownerCounts: [1, 0] }), { "@/lib/pgdb": { PgDb: { findUserById: async () => ({ id: "u1" }), updateUserById: async () => {} } } }));
  const response = await route.PUT(json("/api/admin/users/u1", "PUT", { roles: ["agent"] }), { params: Promise.resolve({ id: "u1" }) });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.match(response.body.error, /last owner/);
});

// ---------------------------------------------------------------- data scope in the routes the review listed

import { resolveHomeDestination } from "../lib/home-destination.mjs";
import { getResource, listScreenLeaves } from "../lib/authz/permissions.mjs";

const opsLead = {
  key: "ops-lead", name: "Ops lead",
  permissions: ["monitor:read", "interactions:read", "interactions_history:read", "interactions:transcribe", "reports:read", "agents:read", "agents:campaigns.assign", "campaigns:read", "utilization:update", "teams:read", "teams:update", "queues:read", "queues:update", "calls:supervise.listen", "agent:self"],
  scopes: { ...emptyScopes(), queues: { mode: "list", ids: ["q-sales"] }, teams: { mode: "list", ids: ["t-a"] }, campaigns: { mode: "list", ids: ["camp-1"] } },
};
const membersOnly = { key: "members-only", name: "Members only", permissions: ["teams:read", "teams:members.assign"], scopes: emptyScopes() };
const queueAssigner = { key: "queue-assigner", name: "Queue assigner", permissions: ["queues:read", "queues:agents.assign"], scopes: emptyScopes() };
const SCOPE_ROLES = [opsLead, membersOnly, queueAssigner];
const lead = { id: "lead-1", username: "lead@test.local", roles: ["ops-lead"] };
const memberEditor = { id: "me-1", username: "members@test.local", roles: ["members-only"] };
const assigner = { id: "qa-1", username: "assigner@test.local", roles: ["queue-assigner"] };

function scopePool(state = {}) {
  const calls = [];
  const pool = {
    calls,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      calls.push({ text, params });
      if (text.startsWith("SELECT DISTINCT user_id FROM cc_queue_user_assignments")) return { rows: [{ user_id: "agent-sales" }] };
      if (text.startsWith("SELECT id FROM users WHERE agent_groups &&")) return { rows: [{ id: "agent-team" }] };
      if (text.startsWith("SELECT queue_id, agent_id FROM acd_segments")) return { rows: state.segments?.[params[0]] || [] };
      if (text.startsWith("SELECT id, username, email FROM users WHERE id = $1")) return { rows: [{ id: params[0], username: `${params[0]}@test.local` }] };
      if (text.startsWith("SELECT w.id, owner.username AS agent_username")) return { rows: [{ id: params[0], agent_username: "someone@test.local" }] };
      const answer = state.extra?.(text, params);
      if (answer) return answer;
      return { rows: [] };
    },
    async connect() { return { query: pool.query, release() {} }; },
  };
  return pool;
}

function scopeDeps(user, pool, more = {}) {
  return {
    authzRoles: SCOPE_ROLES,
    "@/lib/auth-server": { getAuthenticatedUser: async () => user },
    "@/lib/postgres.mjs": { getPostgresPool: () => pool },
    "@/lib/runtime-logging.mjs": { adminRuntimeLogger: quiet, contactCenterRuntimeLogger: quiet, platformApiLogger: quiet, platformDbLogger: quiet, voiceRuntimeLogger: quiet, runtimePayload: (v) => v },
    "@/lib/contact-center/logging.mjs": { interactionsLogger: quiet, queuesLogger: quiet, statusLogger: quiet, supervisionLogger: quiet, callsLogger: quiet, contactCenterErrorPayload: (e) => ({ error: e?.message }), agentPayload: (v) => v },
    crypto: { randomUUID: () => "generated-id", randomBytes: () => Buffer.alloc(16) },
    ...more,
  };
}
const get = (url) => new Request(`https://cc.test${url}`);
const params = (id) => ({ params: Promise.resolve({ id }) });

test("teams: the list follows the teams scope, details outside it are hidden, and members and settings need their own grants", async () => {
  let listed = null;
  const store = { listTeams: async (p, opts) => { listed = opts; return { items: [], total: 0, page: 1, pageSize: 20 }; }, createTeam: async () => ({ id: "t-new" }), getTeam: async (p, id) => ({ id, name: "Team", members: [] }), updateTeam: async (p, id, body) => ({ id, ...body }), deleteTeam: async () => ({ ok: true }), TeamStoreError: class extends Error {} };
  const list = await loadRoute("app/api/admin/teams/route.js", scopeDeps(lead, scopePool(), { "@/lib/teams/store.mjs": store }));
  assert.equal((await list.GET(get("/api/admin/teams"))).status, 200);
  assert.deepEqual(listed.teamIds, ["t-a"]);
  const detail = await loadRoute("app/api/admin/teams/[id]/route.js", scopeDeps(lead, scopePool(), { "@/lib/teams/store.mjs": store }));
  assert.equal((await detail.GET(get("/api/admin/teams/t-b"), params("t-b"))).status, 404);
  assert.equal((await detail.GET(get("/api/admin/teams/t-a"), params("t-a"))).status, 200);
  const members = await detail.PUT(json("/api/admin/teams/t-a", "PUT", { memberIds: ["u1"] }), params("t-a"));
  assert.equal(members.status, 403, "teams:update alone does not change members");
  assert.equal(members.body.permission, "teams:members.assign");
  const membersRoute = await loadRoute("app/api/admin/teams/[id]/route.js", scopeDeps(memberEditor, scopePool(), { "@/lib/teams/store.mjs": store }));
  const rename = await membersRoute.PUT(json("/api/admin/teams/t-a", "PUT", { name: "Renamed" }), params("t-a"));
  assert.equal(rename.status, 403, "teams:members.assign alone does not rename");
  assert.equal(rename.body.permission, "teams:update");
  assert.equal((await membersRoute.PUT(json("/api/admin/teams/t-a", "PUT", { memberIds: ["u1"] }), params("t-a"))).status, 200);
  const createWithMembers = await list.POST(json("/api/admin/teams", "POST", { name: "New", memberIds: ["u1"] }));
  assert.equal(createWithMembers.status, 403, "creating a team with members needs teams:members.assign — ops-lead lacks teams:create anyway");
});

test("an elevated transcription write and the interaction lookups stay inside the data scope", async () => {
  const pool = scopePool({ segments: { "wi-out": [{ queue_id: "q-support", agent_id: "agent-other" }], "wi-in": [{ queue_id: "q-sales", agent_id: "agent-other" }] } });
  const transcription = await loadRoute("app/api/contact-center/interactions/[id]/transcription/route.js", scopeDeps(lead, pool, { "@/lib/agent-assist/transcription-persistence.mjs": { persistAgentAssistTranscriptionsInTransaction: async () => ({ persisted: 0 }) } }));
  const outside = await transcription.POST(json("/api/contact-center/interactions/wi-out/transcription", "POST", { entries: [] }), params("wi-out"));
  assert.equal(outside.status, 403);
  assert.match(outside.body.error, /outside your data scope/);
  assert.notEqual((await transcription.POST(json("/api/contact-center/interactions/wi-in/transcription", "POST", { entries: [] }), params("wi-in"))).status, 403);

  const view = (queue) => ({ id: "wi-x", work_item_id: "wi-x", queue_id: queue, agent_id: "agent-other", interaction_type: "voice" });
  const bySession = await loadRoute("app/api/contact-center/interactions/by-call-session-id/route.js", scopeDeps(lead, pool, { "@/lib/acd/work-item-repository.mjs": { findInteractionViewByCallSessionId: async (p, id) => view(id === "sess-out" ? "q-support" : "q-sales") } }));
  assert.equal((await bySession.GET(get("/api/contact-center/interactions/by-call-session-id?callSessionId=sess-out"))).status, 404);
  assert.equal((await bySession.GET(get("/api/contact-center/interactions/by-call-session-id?callSessionId=sess-in"))).status, 200);
  const byControl = await loadRoute("app/api/contact-center/interactions/by-call-control-id/route.js", scopeDeps(lead, pool, { "@/lib/acd/work-item-repository.mjs": { findInteractionViewByCallControlId: async (p, id) => view(id === "cc-out" ? "q-support" : "q-sales"), findInteractionViewByCallSessionId: async () => null } }));
  assert.equal((await byControl.GET(get("/api/contact-center/interactions/by-call-control-id?callControlId=cc-out"))).body.interaction, null);
  assert.equal((await byControl.GET(get("/api/contact-center/interactions/by-call-control-id?callControlId=cc-in"))).body.interaction.queue_id, "q-sales");
});

test("provider call events and call supervision are bound to an interaction inside the scope", async () => {
  const pool = scopePool();
  const view = (queue) => ({ id: "wi-x", work_item_id: "wi-x", queue_id: queue, agent_id: "agent-other", interaction_type: "voice" });
  const repository = { findInteractionViewByCallSessionId: async (p, id) => (id === "sess-out" ? view("q-support") : id === "sess-in" ? view("q-sales") : null), findInteractionViewByCallControlId: async (p, id) => (id === "cc-out" ? view("q-support") : id === "cc-in" ? view("q-sales") : null) };
  let fetched = 0;
  const events = await loadRoute("app/api/voice/call-history/events/route.js", scopeDeps(lead, pool, { env: { TELNYX_API_KEY: "test-key" }, fetch: async () => { fetched++; return { ok: true, json: async () => ({ data: [{ id: "e1" }], meta: {} }) }; }, "@/lib/acd/work-item-repository.mjs": repository }));
  assert.equal((await events.GET(get("/api/voice/call-history/events?page[size]=10"))).status, 403, "no session named");
  assert.equal((await events.GET(get("/api/voice/call-history/events?filter[application_session_id]=sess-out"))).status, 403);
  assert.equal(fetched, 0, "nothing reaches the provider before the scope check");
  const inScope = await events.GET(get("/api/voice/call-history/events?filter[application_session_id]=sess-in"));
  assert.equal(inScope.status, 200);
  assert.equal(fetched, 1);

  let reserved = 0;
  const supervise = await loadRoute("app/api/contact-center/calls/supervise/route.js", scopeDeps(lead, pool, { env: { TELNYX_API_KEY: "test-key", TELNYX_CALL_CONTROL_ID: "conn-1" }, fetch: async () => ({ ok: true, json: async () => ({ data: {} }) }), "@/lib/acd/work-item-repository.mjs": repository, "@/lib/acd/direct-capacity.mjs": { rejectDirectIntent: async () => {}, reserveSupervisionVoice: async () => { reserved++; return { intentId: "i-1" }; } }, "@/lib/telnyx": { buildTelnyxV2Url: (path) => `https://telnyx.test${path}` } }));
  const outside = await supervise.POST(json("/api/contact-center/calls/supervise", "POST", { supervise_call_control_id: "cc-out", supervisor_role: "monitor" }));
  assert.equal(outside.status, 403);
  assert.equal(reserved, 0);
});

test("agent queue and campaign lookups, utilization and the report queue options follow the scope", async () => {
  const pool = scopePool();
  const queues = await loadRoute("app/api/contact-center/agent/queues/list/route.js", scopeDeps(lead, pool));
  assert.equal((await queues.GET(get("/api/contact-center/agent/queues/list?userId=agent-other"))).status, 404);
  assert.equal((await queues.GET(get("/api/contact-center/agent/queues/list?userId=agent-sales"))).status, 200);

  const campaigns = await loadRoute("app/api/contact-center/agent/campaigns/route.js", scopeDeps(lead, pool, { "@/lib/outbound-dialer/agent-campaigns": { listAgentCampaigns: async () => [], setAgentCampaignActivation: async () => {}, broadcastCampaignActivationChanged: async () => {} } }));
  assert.equal((await campaigns.POST(json("/api/contact-center/agent/campaigns", "POST", { userId: "agent-other", campaignIds: ["camp-1"] }))).status, 404);
  const outsideCampaign = await campaigns.POST(json("/api/contact-center/agent/campaigns", "POST", { userId: "agent-sales", campaignIds: ["camp-2"] }));
  assert.equal(outsideCampaign.status, 403);
  assert.deepEqual(outsideCampaign.body.campaignIds, ["camp-2"]);
  assert.equal((await campaigns.POST(json("/api/contact-center/agent/campaigns", "POST", { userId: "agent-sales", campaignIds: ["camp-1"] }))).status, 200);

  const utilization = await loadRoute("app/api/admin/utilization/[scope]/[id]/route.js", scopeDeps(lead, pool, { "@/lib/acd/utilization.mjs": { readUtilization: async () => ({}), saveUtilization: async () => ({ ok: true }) } }));
  const put = (scope, id) => utilization.PUT(json(`/api/admin/utilization/${scope}/${id}`, "PUT", { channels: {} }), { params: Promise.resolve({ scope, id }) });
  assert.equal((await put("queue", "q-support")).status, 404);
  assert.equal((await put("queue", "q-sales")).status, 200);
  assert.equal((await put("agent", "agent-other")).status, 404);
  assert.equal((await put("global", "default")).status, 403);

  const options = await loadRoute("app/api/contact-center/analytics/queues/route.js", scopeDeps(lead, pool));
  assert.equal((await options.GET(get("/api/contact-center/analytics/queues"))).status, 200);
  const optionsQuery = pool.calls.find((c) => c.text.startsWith("SELECT DISTINCT name FROM cc_queues"));
  assert.match(optionsQuery.text, /WHERE id = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(optionsQuery.params, [["q-sales"]]);
});

test("dialer live calls, queue assignments and the conversation preview follow the grants and the scope", async () => {
  const pool = scopePool({ extra: (text) => (text === "SELECT live" ? { rows: [{ campaign_id: "camp-1" }, { campaign_id: "camp-2" }] } : null), segments: { "wi-in": [{ queue_id: "q-sales", agent_id: "agent-other" }], "wi-out": [{ queue_id: "q-support", agent_id: "agent-other" }] } });
  const live = await loadRoute("app/api/contact-center/outbound-dialer/live-calls/route.js", scopeDeps(lead, pool, { "@/lib/outbound-dialer/api": { getOutboundPool: () => pool }, "@/lib/outbound-dialer/live-calls": { OUTBOUND_LIVE_CALLS_SQL: "SELECT live", buildOutboundLiveCallsPayload: (rows) => ({ calls: rows }) }, "@/lib/outbound-dialer/logging.mjs": { liveCallsLogger: quiet, outboundErrorPayload: (e) => ({ error: e?.message }) } }));
  assert.deepEqual((await live.GET(get("/api/contact-center/outbound-dialer/live-calls"))).body.calls, [{ campaign_id: "camp-1" }]);

  const queueDeps = (user) => scopeDeps(user, pool, { "@/lib/acd/utilization.mjs": { saveAdminSettings: async (p, o, fn) => fn(p, []) }, "@/lib/authz/roles-store.mjs": { removeScopeIds: async () => [] } });
  const asAssigner = await loadRoute("app/api/admin/queues/[id]/route.js", queueDeps(assigner));
  const rename = await asAssigner.PUT(json("/api/admin/queues/q-sales", "PUT", { name: "Renamed" }), params("q-sales"));
  assert.equal(rename.status, 403);
  assert.equal(rename.body.permission, "queues:update");
  assert.notEqual((await asAssigner.PUT(json("/api/admin/queues/q-sales", "PUT", { userAssignments: [] }), params("q-sales"))).status, 403, "queues:agents.assign alone changes assignments");
  const asLead = await loadRoute("app/api/admin/queues/[id]/route.js", queueDeps(lead));
  const assignments = await asLead.PUT(json("/api/admin/queues/q-sales", "PUT", { userAssignments: [{ userId: "agent-sales", enabled: true }] }), params("q-sales"));
  assert.equal(assignments.status, 403);
  assert.equal(assignments.body.permission, "queues:agents.assign");

  const captured = [];
  const conversation = await loadRoute("app/api/contact-center/interactions/[id]/conversation/route.js", scopeDeps(lead, pool, { "@/lib/acd/conversation-preview.mjs": { readConversationSnapshot: async (p, opts) => { captured.push(opts); return { messages: [] }; } } }));
  assert.equal((await conversation.GET(get("/api/contact-center/interactions/wi-in/conversation"), params("wi-in"))).status, 200);
  assert.equal(captured.at(-1).supervisor, true, "an elevated grant inside the scope reads as a supervisor");
  await conversation.GET(get("/api/contact-center/interactions/wi-out/conversation"), params("wi-out"));
  assert.equal(captured.at(-1).supervisor, false, "outside the scope the caller is a participant at most");
  const asAgent = await loadRoute("app/api/contact-center/interactions/[id]/conversation/route.js", scopeDeps(USERS.agent, pool, { "@/lib/acd/conversation-preview.mjs": { readConversationSnapshot: async (p, opts) => { captured.push(opts); return { messages: [] }; } } }));
  await asAgent.GET(get("/api/contact-center/interactions/wi-in/conversation"), params("wi-in"));
  assert.equal(captured.at(-1).supervisor, false, "agents never preview as supervisors");
});

test("home destination, catalogue anchor and inherited unknown keys", () => {
  const agentConfiguration = listScreenLeaves().find((leaf) => leaf.id === "agent.configuration");
  assert.ok(agentConfiguration?.path, "the agent configuration leaf has a path");
  assert.equal(resolveHomeDestination(["custom"], ["agent.configuration"]), agentConfiguration.path);
  assert.equal(getResource("wrapup_codes").anchor, null, "wrap-up codes are global objects");
  const existing = { key: "future", name: "Future", permissions: ["users:read", "future:thing"], scopes: emptyScopes() };
  const kept = rolesStore.validateRoleInput({ name: "Future", permissions: ["users:read", "future:thing"], scopes: emptyScopes() }, { isNew: false, existing });
  assert.ok(kept.permissions.includes("future:thing"), "a key the stored role already holds survives");
  assert.throws(() => rolesStore.validateRoleInput({ name: "Future", permissions: ["users:read", "other:thing"], scopes: emptyScopes() }, { isNew: false, existing }), /Unknown permissions: other:thing/);
});
