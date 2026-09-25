// Phase 3a: routes narrow their data to the scope of the roles that admitted
// the request. A custom "Sales Lead" role scoped to queue q-sales and campaign
// camp-1 exercises the endpoints in enforce mode through the route harness.
import test from "node:test";
import assert from "node:assert/strict";
import { loadRoute } from "./helpers/route-harness.mjs";
import { emptyScopes } from "../lib/authz/permissions.mjs";
import * as channelRegistry from "../lib/acd/channel-registry.mjs";
import * as interactionChannels from "../lib/acd/interaction-channels.mjs";

const salesLead = {
  key: "sales-lead",
  name: "Sales Lead",
  permissions: ["monitor:read", "interactions:read", "interactions_history:read", "reports:read", "queues:read", "queues:delete", "agents:read", "agents:status.set", "campaigns:read", "campaigns:delete", "users:read", "users:delete", "agent:self"],
  scopes: { ...emptyScopes(), queues: { mode: "list", ids: ["q-sales"] }, campaigns: { mode: "list", ids: ["camp-1"] } },
};
const lead = { id: "lead-1", username: "lead@test.local", roles: ["sales-lead"] };
const admin = { id: "admin-1", username: "admin@test.local", roles: ["admin"] };

/** Pool for the scope resolver plus the route's own queries, recorded for assertions. */
function makePool(extra = () => null) {
  const calls = [];
  const pool = {
    calls,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      calls.push({ text, params });
      if (text.startsWith("SELECT DISTINCT user_id FROM cc_queue_user_assignments")) return { rows: [{ user_id: "agent-sales" }] };
      if (text.startsWith("SELECT queue_id, agent_id FROM acd_segments")) return { rows: pool.segments?.[params[0]] || [] };
      const answer = extra(text, params);
      if (answer) return answer;
      return { rows: [] };
    },
    async connect() { return { query: pool.query, release() {} }; },
  };
  return pool;
}

function deps(user, pool, more = {}) {
  return {
    env: { AUTHZ_MODE: "enforce" },
    authzRoles: [salesLead],
    "@/lib/auth-server": { getAuthenticatedUser: async () => user },
    "@/lib/postgres.mjs": { getPostgresPool: () => pool },
    "@/lib/role-utils": { isAdmin: (u) => u?.roles?.includes("admin"), isSupervisorOrAdmin: (u) => u?.roles?.some((r) => ["supervisor", "admin", "owner"].includes(r)) },
    "@/lib/runtime-logging.mjs": { adminRuntimeLogger: { error() {} }, contactCenterRuntimeLogger: { error() {} }, platformApiLogger: { error() {} }, platformDbLogger: { error() {} }, voiceRuntimeLogger: { error() {} }, runtimePayload: (v) => v },
    "@/lib/contact-center/logging.mjs": { queuesLogger: { error() {}, info() {}, debug() {} }, statusLogger: { error() {}, info() {}, debug() {} }, contactCenterErrorPayload: (e) => ({ error: e?.message }), agentPayload: (v) => v },
    "@/lib/acd/channel-registry.mjs": channelRegistry,
    "@/lib/acd/interaction-channels.mjs": interactionChannels,
    "@/lib/contact-center/caller-identity.mjs": { normalizeCallerPhone: (v) => v, resolveCallerIdentities: async () => new Map() },
    "@/lib/contact-center/interaction-duration.mjs": { resolveInteractionDurationSeconds: () => 0 },
    crypto: { randomUUID: () => "generated-id", randomBytes: () => Buffer.alloc(16) },
    ...more,
  };
}

const request = (url, init) => new Request(`https://cc.test${url}`, init);

test("interaction history appends the scope to the WHERE clause with the queue list and the caller", async () => {
  const pool = makePool((text) => (text.startsWith("SELECT COUNT(*)::int AS total") ? { rows: [{ total: 0 }] } : { rows: [] }));
  const route = await loadRoute("app/api/contact-center/interactions/history/route.js", deps(lead, pool, {
    "@/lib/acd/reporting-scope.mjs": { resolveReportingScope: async () => ({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", timezone: "UTC" }) },
  }));
  const response = await route.GET(request("/api/contact-center/interactions/history?summary=true"));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const scoped = pool.calls.find((c) => c.text.includes("sc_q.queue_id = ANY("));
  assert.ok(scoped, "history queries carry the segment-queue restriction");
  assert.ok(scoped.params.some((p) => Array.isArray(p) && p.includes("q-sales")));
  assert.ok(scoped.params.some((p) => Array.isArray(p) && p.includes("lead-1")), "the caller's own interactions stay visible");
});

test("history stays unrestricted for an administrator", async () => {
  const pool = makePool((text) => (text.startsWith("SELECT COUNT(*)::int AS total") ? { rows: [{ total: 0 }] } : { rows: [] }));
  const route = await loadRoute("app/api/contact-center/interactions/history/route.js", deps(admin, pool, {
    "@/lib/acd/reporting-scope.mjs": { resolveReportingScope: async () => ({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", timezone: "UTC" }) },
  }));
  assert.equal((await route.GET(request("/api/contact-center/interactions/history?summary=true"))).status, 200);
  assert.equal(pool.calls.some((c) => c.text.includes("sc_q.queue_id")), false);
});

test("interaction detail: elevated callers get 403 outside their scope and 200 inside it", async () => {
  async function detail(row, segments) {
    const pool = makePool();
    pool.segments = segments;
    const route = await loadRoute("app/api/contact-center/interactions/[id]/route.js", deps(lead, pool, {
      "@/lib/acd/work-item-repository.mjs": { findInteractionViewByReference: async () => row, loadAcdHistoryDto: async () => ({}) },
      "@/lib/acd/history-projection.mjs": { loadAcdTimelineProjection: async () => ({ timeline: [] }), loadAcdInteractionSegments: async () => [] },
    }));
    return route.GET(request("/api/contact-center/interactions/w1"), { params: { id: "w1" } });
  }
  const support = { id: "w1", work_item_id: "w1", queue_id: "q-support", agent_id: "agent-x", interaction_type: "voice", routing_metadata: {} };
  assert.equal((await detail(support, {})).status, 403);
  assert.equal((await detail({ ...support, queue_id: "q-sales" }, {})).status, 200);
  assert.equal((await detail(support, { w1: [{ queue_id: "q-sales", agent_id: "agent-x" }] })).status, 200, "a later segment in the scoped queue admits the interaction");
  assert.equal((await detail({ ...support, agent_id: "lead-1" }, {})).status, 200, "self always wins");
});

test("queue agents and queue calls answer 404 for a queue outside the scope", async () => {
  for (const path of ["app/api/contact-center/queues/[queueId]/agents/route.js", "app/api/contact-center/queues/[queueId]/calls/route.js"]) {
    const pool = makePool();
    const route = await loadRoute(path, deps(lead, pool, {
      "@/lib/acd/agent-state.mjs": { effectiveAgentStatusSql: () => "'Available'", pendingAgentStatusSql: () => "NULL" },
      "@/lib/acd/realtime-queue-calls.mjs": { getAcdRealtimeQueueCalls: async () => [], enrichAcdRealtimeCalls: async (p, calls) => calls },
    }));
    const denied = await route.GET(request("/api/x"), { params: Promise.resolve({ queueId: "q-support" }) });
    assert.equal(denied.status, 404, path);
    assert.equal(pool.calls.some((c) => /FROM users|FROM cc_queues/.test(c.text)), false, "nothing is read for an out-of-scope queue");
  }
});

test("queue statistics are filtered to the scope and a direct out-of-scope request is refused", async () => {
  const stats = [{ queueId: "q-sales", realtime: {} }, { queueId: "q-support", realtime: {} }];
  const route = await loadRoute("app/api/contact-center/stats/queues/route.js", deps(lead, makePool(), {
    "@/lib/acd/stats-aggregator": { getQueueStatistics: async (id) => (id ? stats.find((s) => s.queueId === id) : stats) },
  }));
  const list = await route.GET(request("/api/contact-center/stats/queues"));
  assert.deepEqual(list.body.stats.map((s) => s.queueId), ["q-sales"]);
  assert.equal((await route.GET(request("/api/contact-center/stats/queues?queueId=q-support"))).status, 403);
  assert.equal((await route.GET(request("/api/contact-center/stats/queues?queueId=q-sales"))).status, 200);
});

test("the monitor dashboard passes scope to SQL and preserves prefiltered global totals", async () => {
  const route = await loadRoute("app/api/contact-center/monitor/dashboard/route.js", deps(lead, makePool(), {
    "next-auth": { getServerSession: async () => ({ user: { id: "lead-1" } }) },
    "@/app/api/auth/[...nextauth]/route": { authOptions: {} },
    "@/lib/pgdb": { PgDb: { findUserById: async () => lead } },
    "@/lib/acd/stats-aggregator": {
      getQueueStatistics: async () => [
        { queueId: "q-sales", realtime: { activeCalls: 1, waitingCalls: 0 }, today: { totalCalls: 3, answeredCalls: 3, abandonedCalls: 0, failedInteractions: 0 }, sla: {} },
        { queueId: "q-support", realtime: { activeCalls: 9, waitingCalls: 9 }, today: { totalCalls: 99, answeredCalls: 90, abandonedCalls: 9, failedInteractions: 0 }, sla: {} },
      ],
      getAgentStatistics: async () => [{ userId: "agent-sales", status: "Available", isAvailableForRouting: true, usedCapacity: 0 }, { userId: "agent-other", status: "Busy", usedCapacity: 1 }],
      getOverallStatistics: async (options) => {
        assert.deepEqual(options.restriction.queueIds, ["q-sales"]);
        // The SQL aggregate counts distinct interactions; queue participation
        // totals can be larger after transfers and must not replace it.
        return { calls: { total: 2 }, agents: { total: 1 }, queues: { total: 1 }, sla: {} };
      },
    },
  }));
  const response = await route.GET(request("/api/contact-center/monitor/dashboard"));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.queues.stats.map((q) => q.queueId), ["q-sales"]);
  assert.deepEqual(response.body.agents.stats.map((a) => a.userId), ["agent-sales"]);
  assert.equal(response.body.overall.calls.total, 2);
  assert.equal(response.body.overall.agents.total, 1);
  assert.equal(response.body.overall.scoped, true);
});

test("changing another agent's status is refused outside the scope and allowed inside it", async () => {
  async function put(userId) {
    const pool = makePool((text) => (text.includes("FROM users u JOIN acd_agent_state") ? { rows: [{ id: userId, username: "x", presence: "online" }] } : null));
    const route = await loadRoute("app/api/contact-center/agent/status/route.js", deps(lead, pool, {
      "@/lib/acd/agent-state.mjs": { effectiveAgentStatus: () => "Available", ensureAgentState: async () => {}, readAgentStatusPresentation: async () => ({ status: "Away" }), setManualAgentStatus: async () => "Away" },
      "@/lib/pgdb": { PgDb: { logUserActivity: async () => {} } },
    }));
    return route.PUT(request("/api/contact-center/agent/status", { method: "PUT", body: JSON.stringify({ status: "Away", userId }), headers: { "content-type": "application/json" } }));
  }
  assert.equal((await put("agent-other")).status, 403);
  const allowed = await put("agent-sales");
  assert.notEqual(allowed.status, 403, JSON.stringify(allowed.body));
});

test("campaign list and detail follow the campaign scope", async () => {
  const pool = makePool((text) => (text.includes("FROM outbound_campaigns c") ? { rows: [] } : null));
  const outbound = {
    "@/lib/outbound-dialer/api": { getOutboundPool: () => pool, jsonError: (error, status) => ({ body: { error }, status }), mapCampaign: (r) => r, requireString: (v) => v, optionalString: (v) => v, ensureEnum: (v, a, f) => f, safeJson: (v, f) => f, usernameFor: (u) => u.username, requireUuid: (v) => v },
    "@/lib/outbound-dialer/execution": { normalizeAmdConfig: (v) => v },
    "@/lib/outbound-dialer/schema": { OUTBOUND_CAMPAIGN_MODES: [], OUTBOUND_CHANNELS: [], OUTBOUND_HANDLER_TYPES: [], isOutboundMessagingChannel: () => false },
    "@/lib/outbound-dialer/messaging/api.mjs": { assertMessagingCampaignSavable: () => {}, normalizeMessagingMetadata: (v) => v },
    "@/lib/outbound-dialer/attempt-limits": { normalizeCampaignMaxAttempts: (v) => v, normalizeGlobalMaxAttempts: (v) => v },
    "@/lib/outbound-dialer/logging.mjs": { campaignsLogger: { error() {}, info() {} }, outboundErrorPayload: (e) => ({ error: e?.message }) },
    "@/lib/outbound-dialer/answered-without-agent-policy.mjs": { normalizedCampaignPacingConfig: (v) => v },
    "@/lib/outbound-dialer/campaign-runtime.mjs": { normalizeRetryPolicy: (v) => v },
  };
  const list = await loadRoute("app/api/contact-center/outbound-dialer/campaigns/route.js", deps(lead, pool, outbound));
  assert.equal((await list.GET(request("/api/contact-center/outbound-dialer/campaigns"))).status, 200);
  const listQuery = pool.calls.find((c) => c.text.includes("FROM outbound_campaigns c"));
  assert.match(listQuery.text, /c\.status <> 'archived' AND c\.id::text = ANY\(\$1::text\[\]\)/, "campaign ids are UUIDs and must be cast for the text[] scope");
  assert.deepEqual(listQuery.params, [["camp-1"]]);

  const detail = await loadRoute("app/api/contact-center/outbound-dialer/campaigns/[campaignId]/route.js", deps(lead, pool, outbound));
  assert.equal((await detail.GET(request("/api/x"), { params: Promise.resolve({ campaignId: "camp-2" }) })).status, 404);
  assert.equal((await detail.DELETE(request("/api/x"), { params: Promise.resolve({ campaignId: "camp-2" }) })).status, 404);
});

test("admin users list narrows to agents of the scoped queues and the user detail hides others", async () => {
  const pool = makePool((text) => (text.startsWith("SELECT COUNT(*) AS c") ? { rows: [{ c: 0 }] } : null));
  const shared = {
    "@/lib/acd/utilization.mjs": { saveAdminSettings: async (p, o, fn) => fn(p) },
    "@/lib/pgdb": { PgDb: { findUserById: async () => null, updateUserById: async () => {} } },
    "@/lib/acd/agent-state.mjs": { effectiveAgentStatusSql: () => "'Available'", ensureAgentState: async () => {} },
    "@/lib/authz/effective.mjs": { effectiveAccess: async () => ({}), publishAuthzChanged: async () => {} },
    "@/lib/authz/roles-store.mjs": { validateRoleAssignment: async () => [], recordRoleAssignment: async () => false },
    "@/lib/email/invites.mjs": { sendInviteEmail: async () => {} },
  };
  const list = await loadRoute("app/api/admin/users/route.js", deps(lead, pool, shared));
  const response = await list.GET(request("/api/admin/users"));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const rowsQuery = pool.calls.find((c) => c.text.startsWith("SELECT u.id, u.username"));
  assert.match(rowsQuery.text, /u\.id = ANY\(\$1::text\[\]\)/);
  assert.match(rowsQuery.text, /u\.profile_picture_uri/, "user lists include the assigned profile photo");
  assert.deepEqual(rowsQuery.params[0], ["agent-sales", "lead-1"]);

  const detail = await loadRoute("app/api/admin/users/[id]/route.js", deps(lead, pool, shared));
  assert.equal((await detail.GET(request("/api/admin/users/agent-other"), { params: Promise.resolve({ id: "agent-other" }) })).status, 404);
  assert.equal((await detail.DELETE(request("/api/admin/users/agent-other"), { params: Promise.resolve({ id: "agent-other" }) })).status, 404);
});

test("admin queue detail answers 404 outside the scope; the list carries the queue restriction", async () => {
  const pool = makePool((text) => (text.startsWith("SELECT COUNT(*) AS c") ? { rows: [{ c: 0 }] } : null));
  const shared = {
    "@/lib/acd/utilization.mjs": { saveAdminSettings: async (p, o, fn) => fn(p) },
    "@/lib/contact-center/queue-assignment-priorities.mjs": { updateAssignmentPriorities: async () => {} },
    "@/lib/authz/roles-store.mjs": { removeScopeIds: async () => [] },
  };
  const detail = await loadRoute("app/api/admin/queues/[id]/route.js", deps(lead, pool, shared));
  assert.equal((await detail.GET(request("/api/admin/queues/q-support"), { params: Promise.resolve({ id: "q-support" }) })).status, 404);
  assert.equal((await detail.DELETE(request("/api/admin/queues/q-support"), { params: Promise.resolve({ id: "q-support" }) })).status, 404);
  const list = await loadRoute("app/api/admin/queues/route.js", deps(lead, pool, shared));
  assert.equal((await list.GET(request("/api/admin/queues"))).status, 200);
  const rowsQuery = pool.calls.find((c) => c.text.startsWith("SELECT id, name, display_name"));
  assert.match(rowsQuery.text, /WHERE id = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(rowsQuery.params, [["q-sales"]]);
});

test("deleting a queue removes it from every role scope", async () => {
  let cascade = null;
  const pool = makePool((text) => (text.startsWith("SELECT COUNT(*) AS c FROM cc_queues WHERE overflow_queue_id") ? { rows: [{ c: 0 }] } : null));
  const route = await loadRoute("app/api/admin/queues/[id]/route.js", deps(admin, pool, {
    "@/lib/acd/utilization.mjs": { saveAdminSettings: async (p, o, fn) => fn(p) },
    "@/lib/contact-center/queue-assignment-priorities.mjs": { updateAssignmentPriorities: async () => {} },
    "@/lib/authz/roles-store.mjs": { removeScopeIds: async (p, anchor, ids, options) => { cascade = { anchor, ids, reason: options.reason }; return ["sales-lead"]; } },
  }));
  const response = await route.DELETE(request("/api/admin/queues/q-vip"), { params: Promise.resolve({ id: "q-vip" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(cascade, { anchor: "queues", ids: ["q-vip"], reason: "queue deleted" });
});

test("an agent without an elevated grant cannot change another agent's status, only their own", async () => {
  // Found in the dev acceptance: the route checked the scope but not the elevated grant, so an agent
  // whose scope covered a colleague could set that colleague's status.
  const agentUser = { id: "agent-sales", username: "agent-sales@test.local", roles: ["agent"] };
  async function put(userId) {
    const pool = makePool((text) => (text.includes("FROM users u JOIN acd_agent_state") ? { rows: [{ id: userId, username: "x", presence: "online" }] } : null));
    const route = await loadRoute("app/api/contact-center/agent/status/route.js", deps(agentUser, pool, {
      "@/lib/acd/agent-state.mjs": { effectiveAgentStatus: () => "Available", ensureAgentState: async () => {}, readAgentStatusPresentation: async () => ({ status: "Away" }), setManualAgentStatus: async () => "Away" },
      "@/lib/pgdb": { PgDb: { logUserActivity: async () => {} } },
    }));
    return route.PUT(request("/api/contact-center/agent/status", { method: "PUT", body: JSON.stringify({ status: "Away", userId }), headers: { "content-type": "application/json" } }));
  }
  assert.equal((await put("agent-other")).status, 403);
  const own = await put("agent-sales");
  assert.notEqual(own.status, 403, JSON.stringify(own.body));
});
