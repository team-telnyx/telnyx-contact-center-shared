import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_ROLES, PRESET_ROLES, emptyScopes, normalizeScopes } from "../lib/authz/permissions.mjs";
import { effectiveAccess, scopeFor } from "../lib/authz/effective.mjs";
import {
  UNRESTRICTED,
  resolveGrantScope,
  resolveScope,
  resolveScopeForKeys,
  mergeScopes,
  queueInScope,
  agentInScope,
  campaignInScope,
  channelInScope,
  interactionInScope,
  workItemInScope,
  interactionScopeSql,
  queueScopeSql,
  agentScopeSql,
  campaignScopeSql,
  scopedChannels,
  sqlTextArray,
  restrictMonitorSnapshot,
  recordingInScope,
  describeScope,
} from "../lib/authz/scope.mjs";
import { removeScopeIds } from "../lib/authz/roles-store.mjs";

/** Pool answering the membership queries the scope resolver makes. */
function membershipPool({ ownQueues = [], ownTeams = [], ownCampaigns = [], teamAgents = {}, queueAgents = {}, segments = [], recordings = [], workItems = {} } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      calls.push([text, params]);
      if (text.startsWith("SELECT queue_id FROM cc_queue_user_assignments")) return { rows: ownQueues.map((queue_id) => ({ queue_id })) };
      if (text.startsWith("SELECT agent_groups FROM users")) return { rows: [{ agent_groups: ownTeams }] };
      if (text.startsWith("SELECT to_regclass")) return { rows: [{ present: "outbound_campaign_agent_assignments" }] };
      if (text.startsWith("SELECT campaign_id FROM outbound_campaign_agent_assignments")) return { rows: ownCampaigns.map((campaign_id) => ({ campaign_id })) };
      if (text.startsWith("SELECT id FROM users WHERE agent_groups &&")) return { rows: params[0].flatMap((team) => teamAgents[team] || []).map((id) => ({ id })) };
      if (text.startsWith("SELECT DISTINCT user_id FROM cc_queue_user_assignments")) return { rows: params[0].flatMap((queue) => queueAgents[queue] || []).map((user_id) => ({ user_id })) };
      if (text.startsWith("SELECT queue_id, agent_id FROM acd_segments")) return { rows: segments.filter((s) => s.work_item_id === params[0]) };
      if (text.startsWith("SELECT work_item_id, queue_id, agent_id, interaction_type FROM acd_history_interactions")) {
        return { rows: recordings.filter((r) => (params[0] && r.recording_id === params[0]) || (params[1] && r.recording_url === params[1])) };
      }
      if (text.startsWith("SELECT channel FROM acd_work_items")) return { rows: workItems[params[0]] ? [{ channel: workItems[params[0]] }] : [] };
      throw new Error(`Unmocked query: ${text}`);
    },
  };
}

const leader = { id: "lead-1", username: "lead@test.local", roles: ["team-leader"], agent_groups: ["team-warsaw"] };

test("an all-anchors grant, a wildcard and a missing grant resolve to no restriction", async () => {
  assert.equal(await resolveGrantScope(null, leader, emptyScopes()), UNRESTRICTED);
  assert.equal(await resolveGrantScope(null, leader, null), UNRESTRICTED);
  const owner = await effectiveAccess({ id: "o", roles: ["owner"] }, new Map(SYSTEM_ROLES.map((r) => [r.key, r])));
  assert.equal(await resolveScope(null, { id: "o" }, owner, "monitor:read"), UNRESTRICTED);
});

test("a list grant narrows queues, derives the agents assigned to them and always keeps the caller", async () => {
  const pool = membershipPool({ queueAgents: { "q-sales": ["agent-a", "agent-b"] } });
  const scope = await resolveGrantScope(pool, { id: "sup-1" }, { ...emptyScopes(), queues: { mode: "list", ids: ["q-sales"] } });
  assert.equal(scope.restricted, true);
  assert.deepEqual(scope.queueIds, ["q-sales"]);
  assert.equal(scope.teamAgentIds, null);
  assert.deepEqual(scope.agentIds, ["agent-a", "agent-b", "sup-1"]);
  assert.equal(scope.campaignIds, null);
  assert.equal(scope.channels, null);
  assert.equal(queueInScope(scope, "q-sales"), true);
  assert.equal(queueInScope(scope, "q-support"), false);
  assert.equal(agentInScope(scope, "agent-a"), true);
  assert.equal(agentInScope(scope, "sup-1"), true);
  assert.equal(agentInScope(scope, "stranger"), false);
  assert.equal(campaignInScope(scope, "anything"), true, "campaigns are not narrowed by a queues-only grant");
});

test("own anchors resolve from the caller's memberships and combine with OR (D-20, D-21)", async () => {
  const pool = membershipPool({ ownQueues: ["q-vip"], teamAgents: { "team-warsaw": ["agent-w1", "agent-w2"] }, queueAgents: { "q-vip": ["agent-v"] } });
  const scope = await resolveGrantScope(pool, leader, { ...emptyScopes(), queues: { mode: "own" }, teams: { mode: "own" } });
  assert.deepEqual(scope.queueIds, ["q-vip"]);
  assert.deepEqual(scope.teamAgentIds, ["agent-w1", "agent-w2"]);
  assert.deepEqual(scope.agentIds, ["agent-w1", "agent-w2", "agent-v", "lead-1"]);
  // interaction of a team member in another queue: in scope through the team
  assert.equal(interactionInScope(scope, { queueIds: ["q-support"], agentIds: ["agent-w1"], channel: "voice" }), true);
  // interaction in the own queue handled by a stranger: in scope through the queue
  assert.equal(interactionInScope(scope, { queueIds: ["q-vip"], agentIds: ["stranger"], channel: "voice" }), true);
  // neither queue nor team nor self
  assert.equal(interactionInScope(scope, { queueIds: ["q-support"], agentIds: ["stranger"], channel: "voice" }), false);
  // the caller's own interaction is always visible (rule 5)
  assert.equal(interactionInScope(scope, { queueIds: ["q-support"], agentIds: ["lead-1"], channel: "voice" }), true);
});

test("an own anchor that resolves to nothing is inactive: the caller sees only their own data", async () => {
  const pool = membershipPool();
  const scope = await resolveGrantScope(pool, { id: "lead-2", agent_groups: [] }, { ...emptyScopes(), queues: { mode: "own" }, teams: { mode: "own" } });
  assert.deepEqual(scope.queueIds, []);
  assert.deepEqual(scope.teamAgentIds, []);
  assert.deepEqual(scope.agentIds, ["lead-2"]);
  assert.equal(queueInScope(scope, "q-sales"), false);
  assert.equal(interactionInScope(scope, { queueIds: ["q-sales"], agentIds: ["agent-a"] }), false);
  assert.equal(interactionInScope(scope, { queueIds: ["q-sales"], agentIds: ["lead-2"] }), true);
});

test("a list anchor with own adds the memberships to the explicit ids", async () => {
  const pool = membershipPool({ ownQueues: ["q-own"] });
  const scope = await resolveGrantScope(pool, { id: "u" }, { ...emptyScopes(), queues: { mode: "list", ids: ["q-a"], own: true } });
  assert.deepEqual(scope.queueIds, ["q-a", "q-own"]);
});

test("channels narrow with AND and campaigns are an independent axis", async () => {
  const pool = membershipPool({ ownCampaigns: ["camp-own"], queueAgents: {} });
  const scope = await resolveGrantScope(pool, { id: "u", username: "u@test" }, {
    ...emptyScopes(),
    queues: { mode: "list", ids: ["q-a"] },
    campaigns: { mode: "own" },
    channels: { mode: "list", ids: ["voice", "email"] },
  });
  assert.deepEqual(scope.channels, ["voice", "email"]);
  assert.deepEqual(scope.campaignIds, ["camp-own"]);
  assert.equal(channelInScope(scope, "chat"), false);
  assert.equal(interactionInScope(scope, { queueIds: ["q-a"], agentIds: [], channel: "chat" }), false, "channel AND");
  assert.equal(interactionInScope(scope, { queueIds: ["q-a"], agentIds: [], channel: "email" }), true);
  assert.equal(campaignInScope(scope, "camp-own"), true);
  assert.equal(campaignInScope(scope, "camp-other"), false);
  assert.deepEqual(scopedChannels(scope, null, ["voice", "chat", "email", "sms"]), ["voice", "email"]);
  assert.deepEqual(scopedChannels(scope, "chat", ["voice", "chat"]), []);
  assert.deepEqual(scopedChannels(UNRESTRICTED, "chat", ["voice", "chat"]), ["chat"]);
});

test("scope applies per grant: the union of the roles that grant the permission (D-22)", async () => {
  const defs = new Map([...SYSTEM_ROLES, ...PRESET_ROLES].map((r) => [r.key, r]));
  defs.set("sales-lead", { key: "sales-lead", permissions: ["monitor:read", "reports:read"], scopes: { ...emptyScopes(), queues: { mode: "list", ids: ["q-sales"] } } });
  const access = await effectiveAccess({ id: "u", roles: ["agent", "sales-lead"] }, defs);
  // agent grants interactions:read with scope all; sales-lead grants monitor:read with a list
  assert.equal(scopeFor(access, "monitor:read").queues.mode, "list");
  const monitor = await resolveScope(membershipPool(), { id: "u" }, access, "monitor:read");
  assert.deepEqual(monitor.queueIds, ["q-sales"]);
  assert.equal(await resolveScope(membershipPool(), { id: "u" }, access, "interactions:read"), UNRESTRICTED);
  // union of several keys: the unrestricted one wins
  assert.equal(await resolveScopeForKeys(membershipPool(), { id: "u" }, access, ["monitor:read", "interactions:read"]), UNRESTRICTED);
  const both = await resolveScopeForKeys(membershipPool(), { id: "u" }, access, ["monitor:read", "reports:read"]);
  assert.deepEqual(both.queueIds, ["q-sales"]);
});

test("mergeScopes unions every axis and null means no narrowing", () => {
  const a = { restricted: true, queueIds: ["q1"], teamAgentIds: null, agentIds: ["u", "x"], campaignIds: ["c1"], channels: ["voice"], selfId: "u" };
  const b = { restricted: true, queueIds: ["q2"], teamAgentIds: ["t1"], agentIds: ["u", "y"], campaignIds: null, channels: ["email"], selfId: "u" };
  const merged = mergeScopes(a, b);
  assert.deepEqual(merged.queueIds, ["q1", "q2"]);
  assert.equal(merged.teamAgentIds, null);
  assert.deepEqual(merged.agentIds, ["u", "x", "y"]);
  assert.equal(merged.campaignIds, null);
  assert.deepEqual(merged.channels, ["voice", "email"]);
  assert.equal(mergeScopes(a, UNRESTRICTED), UNRESTRICTED);
  assert.equal(mergeScopes(null, null), UNRESTRICTED);
});

test("SQL helpers append parameters in order and inline literals safely when asked", () => {
  const scope = { restricted: true, queueIds: ["q-sales"], teamAgentIds: ["agent-w1"], agentIds: ["agent-w1", "sup"], campaignIds: ["c1"], channels: ["voice"], selfId: "sup" };
  const params = ["2026-01-01"];
  const conditions = interactionScopeSql(scope, { queue: "i.queue_id", agent: "i.agent_id", channel: "i.interaction_type", workItem: "i.work_item_id" }, params);
  assert.equal(conditions.length, 2);
  assert.equal(conditions[0], "i.interaction_type = ANY($2::text[])");
  assert.match(conditions[1], /^\(i\.queue_id = ANY\(\$3::text\[\]\) OR EXISTS\(SELECT 1 FROM acd_segments sc_q WHERE sc_q\.work_item_id = i\.work_item_id AND sc_q\.queue_id = ANY\(\$3::text\[\]\)\) OR i\.agent_id = ANY\(\$4::text\[\]\) OR EXISTS\(SELECT 1 FROM acd_segments sc_a/);
  assert.deepEqual(params, ["2026-01-01", ["voice"], ["q-sales"], ["agent-w1", "sup"]]);
  assert.deepEqual(queueScopeSql(scope, "q.id", []), ["q.id = ANY($1::text[])"]);
  assert.deepEqual(agentScopeSql(scope, "u.id", []), ["u.id = ANY($1::text[])"]);
  assert.deepEqual(campaignScopeSql(scope, "c.id", []), ["c.id = ANY($1::text[])"]);
  assert.deepEqual(interactionScopeSql(UNRESTRICTED, { queue: "w.queue_id" }, []), []);
  // inline mode for fixed-position report queries
  const inline = interactionScopeSql(scope, { queue: "w.queue_id", workItem: "w.id", channel: "w.channel" }, null);
  assert.equal(inline[0], "w.channel = ANY(ARRAY['voice']::text[])");
  assert.match(inline[1], /w\.queue_id = ANY\(ARRAY\['q-sales'\]::text\[\]\)/);
  assert.equal(sqlTextArray(["it's", "plain", "bad\\slash", "ctl\nchar"]), "ARRAY['it''s','plain']::text[]");
  // a narrowed membership with nothing to match yields FALSE rather than dropping the restriction
  const nothing = { ...scope, queueIds: [], teamAgentIds: [], selfId: null };
  assert.deepEqual(interactionScopeSql(nothing, { queue: "w.queue_id" }, []), ["FALSE"]);
});

test("workItemInScope reads the segments (rule 3) and recordingInScope maps a recording to its interaction", async () => {
  const pool = membershipPool({
    queueAgents: {},
    segments: [{ work_item_id: "w1", queue_id: "q-support", agent_id: "x" }, { work_item_id: "w1", queue_id: "q-sales", agent_id: "y" }],
    recordings: [{ recording_id: "rec-1", recording_url: "https://s3/rec-1.wav", work_item_id: "w1", queue_id: "q-support", agent_id: "x", interaction_type: "voice" }],
  });
  const scope = await resolveGrantScope(pool, { id: "sup" }, { ...emptyScopes(), queues: { mode: "list", ids: ["q-sales"] } });
  assert.equal(await workItemInScope(pool, scope, "w1", { queueId: "q-support", agentId: "x", channel: "voice" }), true, "a later segment in the scoped queue admits the interaction");
  assert.equal(await workItemInScope(pool, scope, "w2", { queueId: "q-support", agentId: "x", channel: "voice" }), false);
  assert.equal(await workItemInScope(pool, UNRESTRICTED, "w2"), true);
  assert.equal(await recordingInScope(pool, scope, { recordingId: "rec-1" }), true);
  assert.equal(await recordingInScope(pool, scope, { recordingUrl: "https://s3/rec-1.wav" }), true);
  assert.equal(await recordingInScope(pool, scope, { recordingId: "rec-unknown" }), false, "unknown recordings are out of scope for a restricted caller");
  assert.equal(await recordingInScope(pool, UNRESTRICTED, {}), true);
});

test("restrictMonitorSnapshot keeps only scoped queues and agents and recomputes the overall figures", () => {
  const snapshot = {
    queues: [
      { queueId: "q-sales", realtime: { activeCalls: 2, waitingCalls: 1 }, today: { totalCalls: 10, answeredCalls: 8, abandonedCalls: 1, failedInteractions: 1 }, sla: { met: 6, breached: 2, unserved: 0, atRisk: 1, denominator: 8, target: 80 } },
      { queueId: "q-support", realtime: { activeCalls: 5, waitingCalls: 4 }, today: { totalCalls: 50, answeredCalls: 40, abandonedCalls: 5, failedInteractions: 5 }, sla: { met: 30, breached: 10, unserved: 0, atRisk: 0, denominator: 40, target: 90 } },
    ],
    agents: [
      { userId: "agent-a", isAvailableForRouting: true, usedCapacity: 0, status: "Available" },
      { userId: "agent-z", isAvailableForRouting: false, usedCapacity: 1, status: "Busy" },
    ],
    overall: { calls: { total: 60 }, agents: { total: 2 }, queues: { total: 2 }, sla: { rate: 75 } },
  };
  const scope = { restricted: true, queueIds: ["q-sales"], teamAgentIds: null, agentIds: ["agent-a"], campaignIds: null, channels: null, selfId: "sup" };
  const out = restrictMonitorSnapshot(snapshot, scope);
  assert.deepEqual(out.queues.map((q) => q.queueId), ["q-sales"]);
  assert.deepEqual(out.agents.map((a) => a.userId), ["agent-a"]);
  assert.deepEqual(out.overall.calls, { total: 10, answered: 8, abandoned: 1, failed: 1, active: 2 });
  assert.deepEqual(out.overall.queues, { total: 1, active: 1, totalWaitingCalls: 1 });
  assert.deepEqual(out.overall.agents, { available: 1, busy: 0, totalActive: 1, total: 1 });
  assert.equal(out.overall.sla.rate, 75);
  assert.equal(out.overall.sla.target, 80);
  assert.equal(out.overall.scoped, true);
  assert.equal(restrictMonitorSnapshot(snapshot, UNRESTRICTED), snapshot);
  assert.deepEqual(describeScope(scope), { restricted: true, queues: ["q-sales"], agents: ["agent-a"], campaigns: null, channels: null });
});

test("stored scopes keep an emptied list as nothing instead of widening to all (rule 6)", () => {
  const strict = normalizeScopes({ queues: { mode: "list", ids: [] } });
  assert.equal(strict.scopes.queues.mode, "all", "editor input falls back and reports the error");
  assert.ok(strict.errors.some((e) => /selection is empty/.test(e)));
  const stored = normalizeScopes({ queues: { mode: "list", ids: [] } }, { strict: false });
  assert.deepEqual(stored.scopes.queues, { mode: "list", ids: [] });
  assert.deepEqual(stored.errors, []);
  assert.deepEqual(normalizeScopes({ queues: { mode: "list", ids: ["a"], own: true } }, { strict: false }).scopes.queues, { mode: "list", ids: ["a"], own: true });
});

test("removeScopeIds drops deleted objects from every role scope, audits and reports the roles", async () => {
  const roles = new Map([
    ["sales-lead", { id: "sales-lead", name: "Sales Lead", scopes: { queues: { mode: "list", ids: ["q-sales", "q-vip"] }, teams: { mode: "all" } } }],
    ["vip-only", { id: "vip-only", name: "VIP", scopes: { queues: { mode: "list", ids: ["q-vip"] } } }],
    ["untouched", { id: "untouched", name: "Other", scopes: { queues: { mode: "list", ids: ["q-support"] } } }],
  ]);
  const writes = [];
  const pool = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      if (text.startsWith("SELECT id, name, scopes FROM cc_roles WHERE scopes->$1->>'mode' = 'list'")) {
        return { rows: [...roles.values()].filter((r) => r.scopes[params[0]]?.mode === "list" && r.scopes[params[0]].ids.some((id) => params[1].includes(id))) };
      }
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.startsWith("UPDATE cc_roles SET scopes = $2::jsonb")) { writes.push(["scopes", params[0], JSON.parse(params[1])]); roles.get(params[0]).scopes = JSON.parse(params[1]); return { rows: [] }; }
      if (text.startsWith("INSERT INTO cc_authz_audit")) { writes.push(["audit", params[2], params[4]]); return { rows: [] }; }
      if (text.startsWith("SELECT id FROM users WHERE roles && $1::text[]")) return { rows: [{ id: "u1" }] };
      throw new Error(`Unmocked query: ${text}`);
    },
    async connect() { return { query: this.query, release() {} }; },
  };
  const changed = await removeScopeIds(pool, "queues", ["q-vip"], { actor: { id: "admin" }, reason: "queue deleted" });
  assert.deepEqual(changed, ["sales-lead", "vip-only"]);
  assert.deepEqual(roles.get("sales-lead").scopes.queues, { mode: "list", ids: ["q-sales"] });
  assert.deepEqual(roles.get("vip-only").scopes.queues, { mode: "list", ids: [] }, "an emptied list stays nothing");
  assert.deepEqual(roles.get("untouched").scopes.queues.ids, ["q-support"]);
  assert.equal(writes.filter((w) => w[0] === "audit" && w[1] === "role.scope.cascade").length, 2);
  assert.deepEqual(await removeScopeIds(pool, "queues", ["nothing-here"]), []);
  assert.deepEqual(await removeScopeIds(pool, "not-an-anchor", ["q-vip"]), []);
});

test("workItemInScope reads the work item's channel when the caller passes only the id", async () => {
  // Codex review of #1481: the conversation, attachment and transcription routes
  // know only the id, and a channel-list scope refused every interaction because
  // the missing channel defaulted to null.
  const pool = membershipPool({
    segments: [{ work_item_id: "0f4d3a1e-6c7b-4a2d-9e1f-2b3c4d5e6f70", queue_id: "q-sales", agent_id: "x" }, { work_item_id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", queue_id: "q-sales", agent_id: "x" }],
    workItems: { "0f4d3a1e-6c7b-4a2d-9e1f-2b3c4d5e6f70": "email", "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d": "voice" },
  });
  const scope = await resolveGrantScope(pool, { id: "sup" }, { ...emptyScopes(), queues: { mode: "list", ids: ["q-sales"] }, channels: { mode: "list", ids: ["email"] } });
  assert.equal(await workItemInScope(pool, scope, "0f4d3a1e-6c7b-4a2d-9e1f-2b3c4d5e6f70"), true, "an e-mail interaction in the scoped queue is admitted without the caller naming the channel");
  assert.equal(await workItemInScope(pool, scope, "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"), false, "a voice interaction stays outside an e-mail-only scope");
  assert.equal(await workItemInScope(pool, scope, "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b"), false, "an unknown work item has no channel and is refused");
  const malformed = pool.calls.length;
  assert.equal(await workItemInScope(pool, scope, "not-a-uuid"), false, "a malformed id is refused without a lookup");
  assert.ok(!pool.calls.slice(malformed).some(([text]) => text.startsWith("SELECT channel FROM acd_work_items")), "no channel query for a value PostgreSQL could not cast to uuid");
  const before = pool.calls.length;
  assert.equal(await workItemInScope(pool, scope, "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", { channel: "email" }), true, "an explicit channel is trusted");
  assert.ok(!pool.calls.slice(before).some(([text]) => text.startsWith("SELECT channel FROM acd_work_items")), "no channel lookup when the caller names the channel");
  const channelOnly = await resolveGrantScope(pool, { id: "sup" }, { ...emptyScopes(), channels: { mode: "list", ids: ["voice"] } });
  assert.equal(await workItemInScope(pool, channelOnly, "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"), true);
  assert.equal(await workItemInScope(pool, channelOnly, "0f4d3a1e-6c7b-4a2d-9e1f-2b3c4d5e6f70"), false);
  const queuesOnly = await resolveGrantScope(pool, { id: "sup" }, { ...emptyScopes(), queues: { mode: "list", ids: ["q-sales"] } });
  const start = pool.calls.length;
  assert.equal(await workItemInScope(pool, queuesOnly, "0f4d3a1e-6c7b-4a2d-9e1f-2b3c4d5e6f70"), true);
  assert.ok(!pool.calls.slice(start).some(([text]) => text.startsWith("SELECT channel FROM acd_work_items")), "no channel lookup when no channel axis is narrowed");
});
