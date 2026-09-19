import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_ROLES, PRESET_ROLES, listScreenLeaves } from "../lib/authz/permissions.mjs";
import { effectiveAccess, can, canAny, describeAccess, loadRoleDefinitions, permittedScreens, scopeFor } from "../lib/authz/effective.mjs";

function definitions(extra = []) {
  const map = new Map();
  for (const role of [...SYSTEM_ROLES, ...PRESET_ROLES, ...extra]) map.set(role.key, { ...role, origin: role.origin || "system" });
  return map;
}

test("roles accumulate: agent + team leader is the union of both", async () => {
  const access = await effectiveAccess({ roles: ["agent", "team-leader"] }, definitions());
  assert.equal(can(access, "agent:self"), true);
  assert.equal(can(access, "screen:agent.desktop.desktop"), true);
  assert.equal(can(access, "screen:supervisor.monitor.agents"), true);
  assert.equal(can(access, "calls:supervise.whisper"), true);
  assert.equal(can(access, "calls:supervise.takeover"), false);
  assert.equal(can(access, "screen:admin.configuration.users"), false);
  assert.equal(can(access, "users:create"), false);
  assert.equal(access.wildcard, false);
  assert.deepEqual(access.unknownRoles, []);
});

test("scopes union: all beats lists, own stays dynamic, lists merge", async () => {
  const defs = definitions([
    { key: "sales-only", name: "Sales", permissions: ["monitor:read"], scopes: { queues: { mode: "list", ids: ["sales"] }, teams: { mode: "all" }, campaigns: { mode: "all" }, channels: { mode: "list", ids: ["voice"] } } },
    { key: "vip-only", name: "VIP", permissions: ["monitor:read"], scopes: { queues: { mode: "list", ids: ["vip"] }, teams: { mode: "all" }, campaigns: { mode: "all" }, channels: { mode: "list", ids: ["email"] } } },
  ]);
  const merged = await effectiveAccess({ roles: ["sales-only", "vip-only"] }, defs);
  assert.deepEqual(merged.scopes.queues, { mode: "list", ids: ["sales", "vip"], own: false });
  assert.deepEqual(merged.scopes.channels, { mode: "list", ids: ["voice", "email"], own: false });
  assert.deepEqual(merged.scopes.teams, { mode: "all" });
  const withLeader = await effectiveAccess({ roles: ["sales-only", "team-leader"] }, defs);
  assert.deepEqual(withLeader.scopes.queues, { mode: "list", ids: ["sales"], own: true });
  assert.deepEqual(withLeader.scopes.teams, { mode: "all" }, "sales-only grants all teams, and all beats own");
  const leaderOnly = await effectiveAccess({ roles: ["team-leader"] }, defs);
  assert.deepEqual(leaderOnly.scopes.teams, { mode: "own", own: true });
  assert.deepEqual(leaderOnly.scopes.queues, { mode: "own", own: true });
  const withSupervisor = await effectiveAccess({ roles: ["sales-only", "supervisor"] }, defs);
  assert.deepEqual(withSupervisor.scopes.queues, { mode: "all" });
  assert.deepEqual(withSupervisor.scopes.channels, { mode: "all" });
});

test("scope applies per grant: an agent role does not widen a team leader's monitor scope", async () => {
  const blended = await effectiveAccess({ roles: ["agent", "team-leader"] }, definitions());
  assert.deepEqual(blended.scopes.queues, { mode: "all" }, "the user-wide summary unions every role");
  assert.deepEqual(scopeFor(blended, "monitor:read").queues, { mode: "own", own: true }, "only team-leader grants monitor:read");
  assert.deepEqual(scopeFor(blended, "agents:status.set").teams, { mode: "own", own: true });
  assert.deepEqual(scopeFor(blended, "kb_articles:read").queues, { mode: "all" }, "agent grants kb_articles:read on everything");
  assert.equal(scopeFor(blended, "users:create"), null, "no role grants it");
  const withSupervisor = await effectiveAccess({ roles: ["supervisor", "team-leader"] }, definitions());
  assert.deepEqual(scopeFor(withSupervisor, "monitor:read").queues, { mode: "all" }, "supervisor grants monitor:read on all queues, and all beats own");
  const owner = await effectiveAccess({ roles: ["owner"] }, definitions());
  assert.deepEqual(scopeFor(owner, "monitor:read").queues, { mode: "all" });
});

test("owner is a wildcard and unknown roles are reported, not fatal", async () => {
  const owner = await effectiveAccess({ roles: ["owner"] }, definitions());
  assert.equal(owner.wildcard, true);
  assert.equal(can(owner, "anything:goes"), true);
  assert.equal(permittedScreens(owner).length, listScreenLeaves().length);
  const stale = await effectiveAccess({ roles: ["agent", "deleted-role"] }, definitions());
  assert.deepEqual(stale.unknownRoles, ["deleted-role"]);
  assert.equal(can(stale, "agent:self"), true);
  const nobody = await effectiveAccess({ roles: [] }, definitions());
  assert.deepEqual(nobody.roles, ["agent"], "an empty role list falls back to agent, as the legacy code does");
});

test("can handles screen groups, canAny and the serialised summary", async () => {
  const access = await effectiveAccess({ roles: ["channel-administrator"] }, definitions());
  assert.equal(can(access, "screen:admin.email.*"), true);
  assert.equal(can(access, "screen:admin.email.templates"), true);
  assert.equal(can(access, "screen:admin.sms.*"), true);
  assert.equal(can(access, "screen:admin.system.*"), false);
  assert.equal(canAny(access, ["users:read", "widgets:publish"]), true);
  assert.equal(can(access, "*"), false);
  const summary = describeAccess(access);
  assert.ok(summary.permissions.includes("email_admin:*"));
  assert.ok(summary.operations.includes("email_admin:templates.manage"));
  assert.ok(summary.screens.includes("admin.email.templates"));
  assert.deepEqual(summary.scopes.queues, { mode: "all" });
  assert.equal(summary.wildcard, false);
});

test("without a database no default or system roles grant access", async () => {
  const defs = await loadRoleDefinitions(null);
  assert.equal(defs.size, 0);
  assert.equal(can(await effectiveAccess({ roles: ["owner"] }, defs), "users:delete"), false);
});
