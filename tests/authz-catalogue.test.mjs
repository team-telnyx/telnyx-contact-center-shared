import test from "node:test";
import assert from "node:assert/strict";
import {
  SCREEN_TREE,
  SYSTEM_ROLES,
  PRESET_ROLES,
  isKnownPermission,
  isWellFormedKey,
  matches,
  expandGrants,
  compactScreenGrants,
  screenLeavesUnder,
  resolveScreenForPath,
  listScreenLeaves,
  listOperationKeys,
  normalizeScopes,
  normalizePermissionKeys,
  isSubsetOf,
  describeCatalogue,
} from "../lib/authz/permissions.mjs";

test("every key granted by system and preset roles exists in the catalogue", () => {
  for (const role of [...SYSTEM_ROLES, ...PRESET_ROLES]) {
    for (const key of role.permissions) {
      assert.ok(isKnownPermission(key), `${role.key} grants unknown permission ${key}`);
    }
    const { errors } = normalizeScopes(role.scopes);
    assert.deepEqual(errors, [], `${role.key} ships invalid scopes`);
  }
});

test("key grammar accepts the documented forms and rejects the rest", () => {
  for (const key of ["*", "users:read", "users:*", "calls:supervise.listen", "screen:admin.email.templates", "screen:admin.email.*", "screen:*"]) {
    assert.ok(isWellFormedKey(key), key);
  }
  for (const key of ["", "users", "users:", "screen:", "users:read:extra", "*:read", "screen:admin..x"]) {
    assert.equal(isWellFormedKey(key), false, key);
  }
  assert.equal(isWellFormedKey("Users:Read"), true, "keys are lower-cased before validation");
  assert.equal(isKnownPermission("users:fly"), false);
  assert.equal(isKnownPermission("screen:admin.nowhere"), false);
  assert.equal(isKnownPermission("screen:admin.email.*"), true);
  assert.equal(isKnownPermission("nonexistent:read"), false);
});

test("wildcards match by family and prefix, never across resources", () => {
  assert.equal(matches("*", "users:delete"), true);
  assert.equal(matches("users:*", "users:create"), true);
  assert.equal(matches("users:read", "users:create"), false);
  assert.equal(matches("users:*", "roles:manage"), false);
  assert.equal(matches("screen:admin.*", "screen:admin.email.templates"), true);
  assert.equal(matches("screen:admin.email.*", "screen:admin.email"), true);
  assert.equal(matches("screen:admin.email", "screen:admin.email.templates"), false);
  assert.equal(matches("screen:admin.emailx.*", "screen:admin.email.templates"), false);
  assert.equal(matches("screen:*", "screen:agent.desktop.desktop"), true);
});

test("group grants expand to every leaf and compact back to the group key", () => {
  const emailLeaves = screenLeavesUnder("admin.email");
  assert.equal(emailLeaves.length, 7);
  const expanded = expandGrants(["screen:admin.email.*"]);
  assert.deepEqual([...expanded.screens].sort(), [...emailLeaves].sort());
  assert.deepEqual(compactScreenGrants(emailLeaves), ["screen:admin.email.*"]);
  const partial = compactScreenGrants(emailLeaves.slice(0, 2));
  assert.deepEqual(partial, emailLeaves.slice(0, 2).map((id) => `screen:${id}`));
  assert.deepEqual(compactScreenGrants(listScreenLeaves().map((l) => l.id)), ["screen:agent.*", "screen:supervisor.*", "screen:admin.*"]);
});

test("system roles reproduce the agreed access levels", () => {
  const byKey = Object.fromEntries(SYSTEM_ROLES.map((r) => [r.key, r]));
  const agent = expandGrants(byKey.agent.permissions);
  assert.ok([...agent.screens].every((s) => s.startsWith("agent.")), "agent has only agent screens");
  assert.equal(agent.operations.has("recordings:read"), false, "agent does not list recordings (D-15)");
  assert.equal(agent.operations.has("call_flows:monitor"), false, "agent does not watch flow monitors (D-15)");
  const supervisor = expandGrants(byKey.supervisor.permissions);
  assert.ok(supervisor.screens.has("supervisor.monitor.agents"));
  assert.equal([...supervisor.screens].some((s) => s.startsWith("supervisor.outbound-dialer")), false, "supervisor has no dialer");
  assert.ok(supervisor.operations.has("calls:supervise.barge"));
  const admin = expandGrants(byKey.admin.permissions);
  assert.ok([...admin.screens].some((s) => s.startsWith("supervisor.outbound-dialer")), "admin includes the dialer (D-13)");
  assert.ok(admin.screens.has("admin.configuration.permissions"));
  assert.equal(admin.operations.size, listOperationKeys().length, "admin holds every operation");
  assert.equal(admin.wildcard, false);
  assert.equal(expandGrants(byKey.owner.permissions).wildcard, true);
});

test("preset roles are add-ons without agent desktop access", () => {
  assert.equal(PRESET_ROLES.length, 10);
  for (const role of PRESET_ROLES) {
    const { screens, operations } = expandGrants(role.permissions);
    assert.equal([...screens].some((s) => s.startsWith("agent.")), false, `${role.key} must not grant agent screens`);
    assert.equal(operations.has("agent:self"), false, `${role.key} must not grant agent:self`);
    assert.ok(screens.size > 0, `${role.key} grants at least one screen`);
  }
  const teamLeader = PRESET_ROLES.find((r) => r.key === "team-leader");
  assert.equal(teamLeader.scopes.queues.mode, "own");
  assert.equal(teamLeader.scopes.teams.mode, "own");
  const reporting = expandGrants(PRESET_ROLES.find((r) => r.key === "reporting-analyst").permissions);
  assert.equal(reporting.operations.has("recordings:read"), false, "reporting analyst never sees recordings");
  assert.equal(reporting.screens.has("supervisor.analytics.call-history"), false);
});

test("paths resolve to screens, including section parameters and fail-closed unknown paths", () => {
  assert.deepEqual(resolveScreenForPath("/supervisor/monitor", "?section=agents"), { screen: "supervisor.monitor.agents", group: false });
  assert.deepEqual(resolveScreenForPath("/supervisor/monitor"), { screen: "supervisor.monitor", group: true, defaultScreen: "supervisor.monitor.overview" });
  assert.deepEqual(resolveScreenForPath("/supervisor/monitor", "?section=bogus"), { screen: "supervisor.monitor", group: true });
  assert.deepEqual(resolveScreenForPath("/admin/permissions/team-leader"), { screen: "admin.configuration.permissions", group: false });
  assert.deepEqual(resolveScreenForPath("/admin/data-sources", "?view=kb-articles"), { screen: "admin.configuration.data-sources.kb-articles", group: false });
  assert.deepEqual(resolveScreenForPath("/supervisor/call-history/abc"), { screen: "supervisor.analytics.call-history", group: false });
  assert.deepEqual(resolveScreenForPath("/supervisor/quality/evaluations/42"), { screen: "supervisor.quality.evaluations", group: false });
  assert.deepEqual(resolveScreenForPath("/settings"), { screen: "admin.system.theme-settings", group: false });
  assert.deepEqual(resolveScreenForPath("/admin/data-sources"), { screen: "admin.configuration.data-sources", group: true, defaultScreen: "admin.configuration.data-sources.contacts" });
  assert.deepEqual(resolveScreenForPath("/admin/sms/templates"), { screen: "admin.sms.templates", group: false });
  assert.equal(resolveScreenForPath("/profile"), null);
  assert.equal(resolveScreenForPath("/help/getting-started"), null);
  assert.equal(resolveScreenForPath("/admin/not-a-screen").unknown, true);
});

test("scope normalisation rejects empty selections and own on channels", () => {
  assert.deepEqual(normalizeScopes({ queues: { mode: "list", ids: [] } }).errors, ["Queues: the selection is empty"]);
  assert.deepEqual(normalizeScopes({ channels: { mode: "own" } }).errors, ['Channels: "own" is not available for this anchor']);
  assert.deepEqual(normalizeScopes({ channels: { mode: "list", ids: ["fax"] } }).errors, ["Channels: unknown value in selection"]);
  const ok = normalizeScopes({ queues: { mode: "list", ids: ["q1", "q1", "q2"] }, teams: { mode: "own" }, objects: { call_flows: { mode: "list", ids: ["f1"] }, users: { mode: "list", ids: ["x"] } } });
  assert.deepEqual(ok.scopes.queues, { mode: "list", ids: ["q1", "q2"] });
  assert.deepEqual(ok.scopes.teams, { mode: "own" });
  assert.deepEqual(ok.scopes.channels, { mode: "all" });
  assert.deepEqual(ok.scopes.objects, { call_flows: { mode: "list", ids: ["f1"] } });
  assert.deepEqual(ok.errors, ["Objects: users does not take an object list"]);
});

test("permission normalisation reports unknown keys and deduplicates", () => {
  const { keys, unknown } = normalizePermissionKeys(["Users:Read", "users:read", "users:fly", "", "screen:admin.*"]);
  assert.deepEqual(keys, ["users:read", "screen:admin.*"]);
  assert.deepEqual(unknown, ["users:fly"]);
});

test("delegation: a holder without the wildcard cannot grant beyond their own access or scope", () => {
  const holder = expandGrants(["users:*", "screen:admin.configuration.users"]);
  const ok = isSubsetOf(["users:read", "screen:admin.configuration.users"], { queues: { mode: "all" } }, holder, { queues: { mode: "all" } });
  assert.equal(ok.ok, true);
  const missing = isSubsetOf(["users:read", "roles:manage", "screen:admin.configuration.permissions"], {}, holder, {});
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing.sort(), ["roles:manage", "screen:admin.configuration.permissions"]);
  const scoped = isSubsetOf(["users:read"], { queues: { mode: "all" } }, holder, { queues: { mode: "list", ids: ["sales"] } });
  assert.equal(scoped.ok, false);
  assert.match(scoped.scopeIssues[0], /Queues: you cannot grant "all"/);
  const outside = isSubsetOf(["users:read"], { queues: { mode: "list", ids: ["sales", "vip"] } }, holder, { queues: { mode: "list", ids: ["sales"] } });
  assert.match(outside.scopeIssues[0], /vip outside your own scope/);
  const wildcardHolder = expandGrants(["*"]);
  assert.equal(isSubsetOf(["*"], {}, wildcardHolder, {}).ok, true);
});

test("Permissions is the last leaf of the Configuration group and the catalogue totals are consistent", () => {
  const configuration = SCREEN_TREE.find((w) => w.id === "admin").kids.find((g) => g.id === "admin.configuration");
  assert.equal(configuration.kids[configuration.kids.length - 1].id, "admin.configuration.permissions");
  const catalogue = describeCatalogue();
  assert.equal(catalogue.totals.screens, listScreenLeaves().length);
  assert.equal(catalogue.totals.operations, listOperationKeys().length);
  // 88 leaves in the current build: Teams arrived with Phase 3a and Roles became Permissions.
  assert.ok(catalogue.totals.screens >= 88, `expected at least 88 screens, got ${catalogue.totals.screens}`);
});
