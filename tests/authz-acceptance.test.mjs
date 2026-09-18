// RBAC Phase 5 acceptance: permission decisions are final. Built-in roles keep
// the access they had; the three custom roles of the plan see only their
// screens and receive 403 elsewhere; owner protections and audit hold.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { SYSTEM_ROLES, PRESET_ROLES, emptyScopes, isKnownPermission, screensPermit } from "../lib/authz/permissions.mjs";
import { effectiveAccess, can, canAny } from "../lib/authz/effective.mjs";
import { screenGrantsFor } from "../lib/authz/page-access-server.mjs";
import { decidePageAccess } from "../lib/authz/page-access.mjs";
import { validateRoleInput, RoleStoreError } from "../lib/authz/roles-store.mjs";
import { loadRoute } from "./helpers/route-harness.mjs";

const root = new URL("../", import.meta.url).pathname;
const apiRoot = join(root, "app", "api");
const definitions = new Map([...SYSTEM_ROLES, ...PRESET_ROLES].map((r) => [r.key, r]));

// The three custom roles named in the plan's Phase 4 exit criteria.
const CUSTOM_ROLES = [
  { key: "qa-reviewer", name: "QA reviewer", permissions: ["screen:supervisor.quality.*", "screen:supervisor.analytics.call-history", "quality:read", "quality_forms:read", "quality_evaluations:read", "quality_evaluations:create", "quality_evaluations:update", "quality_evaluations:ai", "interactions_history:read", "recordings:read"], scopes: emptyScopes() },
  { key: "campaign-mgr", name: "Campaign manager", permissions: ["screen:supervisor.outbound-dialer.*", "campaigns:*", "contact_lists:*", "dnc_lists:*", "dialer_filters:*", "dialer_time_sets:*", "disposition_codes:*", "dialer_attempt_controls:*", "dialer_settings:read", "reports:read"], scopes: emptyScopes() },
  { key: "user-admin", name: "User administrator", permissions: ["screen:admin.configuration.users", "screen:admin.configuration.teams", "users:*", "teams:read", "roles:read"], scopes: emptyScopes() },
];
const catalogue = new Map([...definitions, ...CUSTOM_ROLES.map((r) => [r.key, r])]);
const access = async (roles) => effectiveAccess({ id: `u-${roles.join("+")}`, roles }, catalogue);

async function routeInventory() {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else if (entry.name === "route.js") files.push(full);
    }
  }
  await walk(apiRoot);
  const calls = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const key = relative(apiRoot, file).replace(/\/route\.js$/, "");
    for (const m of source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = withPermission\(\s*(\[[^\]]*\]|"[^"]+"|AUTHENTICATED|Object\.values\(SUPERVISION_PERMISSION\))/g)) {
      const raw = m[2];
      const perms = raw === "AUTHENTICATED" ? ["authenticated"]
        : raw.startsWith("Object.values") ? ["calls:supervise.listen", "calls:supervise.whisper", "calls:supervise.barge"]
        : raw.startsWith("[") ? [...raw.matchAll(/"([^"]+)"|AUTHENTICATED/g)].map((x) => x[1] || "authenticated")
        : [raw.replace(/"/g, "")];
      calls.push({ route: key, method: m[1], perms });
    }
  }
  return calls;
}

test("every guarded route names catalogue permissions and the built-in roles keep their reach", async () => {
  const calls = await routeInventory();
  assert.ok(calls.length > 400, `route inventory: ${calls.length}`);
  const unknown = calls.flatMap((c) => c.perms.filter((p) => p !== "authenticated" && !isKnownPermission(p)).map((p) => `${c.route} ${c.method}: ${p}`));
  assert.deepEqual(unknown, []);
  const owner = await access(["owner"]);
  const admin = await access(["admin"]);
  const supervisor = await access(["supervisor"]);
  const agent = await access(["agent"]);
  const permits = (acc, perms) => perms.some((p) => p === "authenticated" || can(acc, p));
  const adminRefused = calls.filter((c) => !permits(admin, c.perms));
  assert.deepEqual(adminRefused.map((c) => `${c.route} ${c.method}`), [], "the system admin reaches every route");
  assert.ok(calls.every((c) => permits(owner, c.perms)));
  // Supervisor essentials (monitor, analytics, quality, agent actions, TTS and assistants for scheduled events)
  for (const [route, method] of [["contact-center/monitor/dashboard", "GET"], ["contact-center/analytics", "GET"], ["contact-center/quality/evaluations", "POST"], ["contact-center/agent/status", "PUT"], ["tts/voices", "GET"], ["ai/assistants", "GET"], ["voice/recordings", "GET"]]) {
    const call = calls.find((c) => c.route === route && c.method === method);
    assert.ok(call, `${route} ${method} exists`);
    assert.ok(permits(supervisor, call.perms), `supervisor reaches ${route} ${method}`);
  }
  // Supervisor does not administer (D-13: the dialer stays with administrators)
  for (const [route, method] of [["admin/users", "POST"], ["admin/roles", "POST"], ["contact-center/outbound-dialer/campaigns", "GET"], ["ai/assistants", "POST"]]) {
    const call = calls.find((c) => c.route === route && c.method === method);
    assert.ok(call && !permits(supervisor, call.perms), `supervisor is refused ${route} ${method}`);
  }
  // Agent desktop essentials stay open to agents; supervision and administration are refused (D-15)
  for (const [route, method] of [["contact-center/agent/status", "PUT"], ["contact-center/agent/queues/activate", "POST"], ["contact-center/interactions/[id]/wrapup", "POST"], ["contact-center/forms/[id]/submissions", "POST"], ["voice/recordings/[id]/stream", "GET"], ["ai/conversations/[id]", "GET"], ["admin/web-pages", "GET"], ["admin/kb-articles", "GET"], ["contact-center/stats/agents", "GET"]]) {
    const call = calls.find((c) => c.route === route && c.method === method);
    assert.ok(call && permits(agent, call.perms), `agent reaches ${route} ${method}`);
  }
  for (const [route, method] of [["voice/recordings", "GET"], ["contact-center/monitor/dashboard", "GET"], ["contact-center/monitor/stream", "GET"], ["voice/flows/[id]/monitor-stream", "GET"], ["admin/users", "GET"], ["contact-center/calls/supervise", "POST"], ["contact-center/quality/evaluations", "POST"]]) {
    const call = calls.find((c) => c.route === route && c.method === method);
    assert.ok(call && !permits(agent, call.perms), `agent is refused ${route} ${method}`);
  }
});

test("the three custom roles of the plan validate and see only their screens", async () => {
  for (const role of CUSTOM_ROLES) {
    assert.doesNotThrow(() => validateRoleInput({ name: role.name, key: role.key, permissions: role.permissions, scopes: role.scopes }, { isNew: true }), `${role.key} validates`);
  }
  const qa = await access(["qa-reviewer"]);
  const qaScreens = screenGrantsFor(qa);
  assert.equal(screensPermit(qaScreens, "supervisor.quality", { group: true }), true);
  assert.equal(screensPermit(qaScreens, "supervisor.analytics.call-history"), true);
  assert.equal(screensPermit(qaScreens, "supervisor.monitor", { group: true }), false);
  assert.equal(screensPermit(qaScreens, "admin.configuration", { group: true }), false);
  assert.equal(decidePageAccess({ pathname: "/supervisor/quality", search: "?section=evaluations", screens: qaScreens }).allowed, true);
  assert.equal(decidePageAccess({ pathname: "/supervisor/monitor", screens: qaScreens }).allowed, false);
  assert.equal(decidePageAccess({ pathname: "/admin/users", screens: qaScreens }).allowed, false);
  assert.equal(can(qa, "quality_evaluations:create"), true);
  assert.equal(can(qa, "quality_forms:create"), false, "the reviewer does not edit scorecards");
  assert.equal(canAny(qa, ["campaigns:read", "users:read", "monitor:read"]), false);

  const campaigns = await access(["campaign-mgr"]);
  const campaignScreens = screenGrantsFor(campaigns);
  assert.equal(screensPermit(campaignScreens, "supervisor.outbound-dialer", { group: true }), true);
  assert.equal(screensPermit(campaignScreens, "supervisor.monitor", { group: true }), false);
  assert.equal(decidePageAccess({ pathname: "/supervisor/outbound-dialer", screens: campaignScreens }).allowed, true);
  assert.equal(can(campaigns, "campaigns:execute"), true);
  assert.equal(canAny(campaigns, ["users:read", "quality:read", "monitor:read"]), false);

  const userAdmin = await access(["user-admin"]);
  const userAdminScreens = screenGrantsFor(userAdmin);
  assert.deepEqual(userAdminScreens, ["admin.configuration.users", "admin.configuration.teams"]);
  assert.equal(decidePageAccess({ pathname: "/admin/users", screens: userAdminScreens }).allowed, true);
  assert.equal(decidePageAccess({ pathname: "/admin/queues", screens: userAdminScreens }).allowed, false);
  assert.equal(can(userAdmin, "users:invite"), true);
  assert.equal(can(userAdmin, "teams:update"), false);
});

test("custom roles are refused by the routes outside their grant and admitted inside it (route harness)", async () => {
  const quiet = { error() {}, warn() {}, info() {}, debug() {} };
  const deps = (user, more = {}) => ({
    authzRoles: CUSTOM_ROLES,
    "@/lib/auth-server": { getAuthenticatedUser: async () => user },
    "@/lib/postgres.mjs": { getPostgresPool: () => ({ query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }) },
    "@/lib/runtime-logging.mjs": { adminRuntimeLogger: quiet, contactCenterRuntimeLogger: quiet, platformApiLogger: quiet, platformDbLogger: quiet, voiceRuntimeLogger: quiet, runtimePayload: (v) => v },
    "@/lib/contact-center/logging.mjs": { queuesLogger: quiet, statusLogger: quiet, contactCenterErrorPayload: (e) => ({ error: e?.message }), agentPayload: (v) => v },
    ...more,
  });
  const qa = { id: "qa-1", username: "qa@test.local", roles: ["qa-reviewer"] };
  const campaignManager = { id: "cm-1", username: "cm@test.local", roles: ["campaign-mgr"] };
  const userAdmin = { id: "ua-1", username: "ua@test.local", roles: ["user-admin"] };

  const users = await loadRoute("app/api/admin/users/route.js", deps(userAdmin, {
    "@/lib/acd/utilization.mjs": { saveAdminSettings: async (p, o, fn) => fn(p) },
    "@/lib/pgdb": { PgDb: { findUserById: async () => null, updateUserById: async () => {} } },
    "@/lib/acd/agent-state.mjs": { effectiveAgentStatusSql: () => "'Available'", ensureAgentState: async () => {} },
    "@/lib/authz/effective.mjs": { effectiveAccess: async () => ({}), publishAuthzChanged: async () => {} },
    "@/lib/authz/roles-store.mjs": { validateRoleAssignment: async () => [], recordRoleAssignment: async () => false },
    "@/lib/email/invites.mjs": { sendInviteEmail: async () => {} },
    crypto: { randomUUID: () => "new-user", randomBytes: () => Buffer.alloc(16) },
  }));
  assert.equal((await users.GET(new Request("https://cc.test/api/admin/users"))).status, 200, "the user administrator lists users");
  const usersAsQa = await loadRoute("app/api/admin/users/route.js", deps(qa, {
    "@/lib/acd/utilization.mjs": {}, "@/lib/pgdb": { PgDb: {} }, "@/lib/acd/agent-state.mjs": { effectiveAgentStatusSql: () => "'x'" }, "@/lib/authz/effective.mjs": {}, "@/lib/authz/roles-store.mjs": {}, "@/lib/email/invites.mjs": {}, crypto: {},
  }));
  const refused = await usersAsQa.GET(new Request("https://cc.test/api/admin/users"));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.permission, "users:read");

  const campaigns = await loadRoute("app/api/contact-center/outbound-dialer/campaigns/route.js", deps(campaignManager, {
    "@/lib/outbound-dialer/api": { getOutboundPool: () => ({ query: async () => ({ rows: [] }) }), jsonError: (error, status) => ({ body: { error }, status }), mapCampaign: (r) => r, requireString: (v) => v, optionalString: (v) => v, ensureEnum: (v, a, f) => f, safeJson: (v, f) => f, usernameFor: (u) => u.username },
    "@/lib/outbound-dialer/execution": { normalizeAmdConfig: (v) => v },
    "@/lib/outbound-dialer/schema": { OUTBOUND_CAMPAIGN_MODES: [], OUTBOUND_CHANNELS: [], OUTBOUND_HANDLER_TYPES: [], isOutboundMessagingChannel: () => false },
    "@/lib/outbound-dialer/messaging/api.mjs": { assertMessagingCampaignSavable: () => {}, normalizeMessagingMetadata: (v) => v },
    "@/lib/outbound-dialer/attempt-limits": { normalizeCampaignMaxAttempts: (v) => v, normalizeGlobalMaxAttempts: (v) => v },
    "@/lib/outbound-dialer/logging.mjs": { campaignsLogger: quiet, outboundErrorPayload: (e) => ({ error: e?.message }) },
    "@/lib/outbound-dialer/answered-without-agent-policy.mjs": { normalizedCampaignPacingConfig: (v) => v },
  }));
  assert.equal((await campaigns.GET(new Request("https://cc.test/api/contact-center/outbound-dialer/campaigns"))).status, 200, "the campaign manager lists campaigns");
  const campaignsAsUserAdmin = await loadRoute("app/api/contact-center/outbound-dialer/campaigns/route.js", deps(userAdmin, {
    "@/lib/outbound-dialer/api": {}, "@/lib/outbound-dialer/execution": {}, "@/lib/outbound-dialer/schema": {}, "@/lib/outbound-dialer/messaging/api.mjs": {}, "@/lib/outbound-dialer/attempt-limits": {}, "@/lib/outbound-dialer/logging.mjs": {}, "@/lib/outbound-dialer/answered-without-agent-policy.mjs": {},
  }));
  assert.equal((await campaignsAsUserAdmin.GET(new Request("https://cc.test/api/contact-center/outbound-dialer/campaigns"))).status, 403);

  const evaluations = await loadRoute("app/api/contact-center/quality/dashboard/route.js", deps(qa, {
    "@/lib/acd/interaction-channels.mjs": { parseChannel: () => null },
    "@/lib/diagnostic-logger.mjs": { createDiagnosticLogger: () => quiet },
  }));
  const dashboard = await evaluations.GET(new Request("https://cc.test/api/contact-center/quality/dashboard"));
  assert.notEqual(dashboard.status, 403, "the QA reviewer opens the quality dashboard");
  const dashboardAsCampaigns = await loadRoute("app/api/contact-center/quality/dashboard/route.js", deps(campaignManager, { "@/lib/acd/interaction-channels.mjs": {}, "@/lib/diagnostic-logger.mjs": { createDiagnosticLogger: () => quiet } }));
  assert.equal((await dashboardAsCampaigns.GET(new Request("https://cc.test/api/contact-center/quality/dashboard"))).status, 403);
});

test("owner protections stay: nobody but an owner grants '*' and the owner key cannot be reused", () => {
  assert.throws(() => validateRoleInput({ name: "Root", permissions: ["*"] }, { isNew: true }), (err) => err instanceof RoleStoreError && /owner/.test(err.message));
  assert.throws(() => validateRoleInput({ name: "Owner Two", key: "owner", permissions: ["users:read"] }, { isNew: true }), /reserved for a system role/);
});
