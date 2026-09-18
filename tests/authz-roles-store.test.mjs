import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_ROLES, PRESET_ROLES, expandGrants, emptyScopes } from "../lib/authz/permissions.mjs";
import { effectiveAccess } from "../lib/authz/effective.mjs";
import {
  validateRoleInput,
  assertDelegation,
  validateRoleAssignment,
  deleteRole,
  createRole,
  updateRole,
  restoreRole,
  toRoleView,
  sortRoles,
  slugify,
  RoleStoreError,
} from "../lib/authz/roles-store.mjs";

function access(roleKeys) {
  const defs = new Map([...SYSTEM_ROLES, ...PRESET_ROLES].map((r) => [r.key, r]));
  const keys = roleKeys.flatMap((k) => defs.get(k)?.permissions || []);
  const expanded = expandGrants(keys);
  return { roles: roleKeys, keys, screens: expanded.screens, operations: expanded.operations, wildcard: expanded.wildcard, scopes: { queues: { mode: "all" }, teams: { mode: "all" }, campaigns: { mode: "all" }, channels: { mode: "all" } } };
}

function roleRow(key, overrides = {}) {
  const preset = PRESET_ROLES.find((r) => r.key === key);
  const system = SYSTEM_ROLES.find((r) => r.key === key);
  const def = preset || system;
  return { id: key, name: def?.name || key, description: def?.description || "", is_system: Boolean(system), origin: system ? "system" : preset ? "preset" : "custom", permissions: def?.permissions || [], scopes: def?.scopes || {}, ...overrides };
}

/** Minimal pool that answers by SQL prefix and records every write. */
function mockPool({ roles = [], users = [], owners = 1 } = {}) {
  const writes = [];
  const state = { roles: new Map(roles.map((r) => [r.id, r])), users };
  async function query(sql, params = []) {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith("SELECT r.*, COALESCE(u.c, 0)")) return { rows: [...state.roles.values()].map((r) => ({ ...r, users_count: state.users.filter((u) => u.roles.includes(r.id)).length })) };
    if (text.startsWith("SELECT r.*, (SELECT COUNT(*)::int FROM users")) { const r = state.roles.get(params[0]); return { rows: r ? [{ ...r, users_count: state.users.filter((u) => u.roles.includes(r.id)).length }] : [] }; }
    if (text.startsWith("SELECT id FROM users WHERE $1 = ANY(roles)")) return { rows: state.users.filter((u) => u.roles.includes(params[0])).map((u) => ({ id: u.id })) };
    if (text.startsWith("SELECT id FROM cc_roles WHERE id = $1")) return { rows: state.roles.has(params[0]) ? [{ id: params[0] }] : [] };
    if (text.startsWith("SELECT id, permissions, scopes, is_system FROM cc_roles WHERE id = ANY")) return { rows: params[0].filter((k) => state.roles.has(k)).map((k) => state.roles.get(k)) };
    if (text.startsWith("SELECT COUNT(*)::int AS c FROM users WHERE 'owner' = ANY(roles) AND id <> $1")) return { rows: [{ c: owners }] };
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") { writes.push(text); return { rows: [] }; }
    if (text.startsWith("INSERT INTO cc_roles")) { writes.push(["insert-role", params]); state.roles.set(params[0], { id: params[0], name: params[1], description: params[2], is_system: false, origin: "custom", permissions: params[3], scopes: JSON.parse(params[4]) }); return { rows: [] }; }
    if (text.startsWith("UPDATE cc_roles SET")) { writes.push(["update-role", params]); const r = state.roles.get(params[0]); Object.assign(r, { name: params[1], description: params[2], permissions: params[3], scopes: JSON.parse(params[4]) }); return { rows: [] }; }
    if (text.startsWith("SELECT id, username FROM users WHERE $1 = ANY(roles) AND array_length(array_remove(roles, $1), 1) IS NULL")) return { rows: state.users.filter((u) => u.roles.length === 1 && u.roles[0] === params[0]).map((u) => ({ id: u.id, username: u.username || u.id })) };
    if (text.startsWith("UPDATE users SET roles = array_remove")) { writes.push(["strip-users", params]); state.users.forEach((u) => { u.roles = u.roles.filter((k) => k !== params[0]); }); return { rows: [] }; }
    if (text.startsWith("DELETE FROM cc_roles")) { writes.push(["delete-role", params]); state.roles.delete(params[0]); return { rows: [] }; }
    if (text.startsWith("INSERT INTO app_settings")) { writes.push(["remember-preset", params]); return { rows: [] }; }
    if (text.startsWith("INSERT INTO cc_authz_audit")) { writes.push(["audit", params]); return { rows: [] }; }
    throw new Error(`Unmocked query: ${text}`);
  }
  return { query, connect: async () => ({ query, release() {} }), writes, state };
}

test("role input validation names every problem", () => {
  assert.throws(() => validateRoleInput({ name: "", permissions: [] }, { isNew: true }), (err) => err instanceof RoleStoreError && err.status === 422 && err.details.includes("Give the role a name.") && err.details.includes("Grant at least one screen or operation."));
  assert.throws(() => validateRoleInput({ name: "Owner Two", key: "owner", permissions: ["users:read"] }, { isNew: true }), /reserved for a system role/);
  assert.throws(() => validateRoleInput({ name: "Root", permissions: ["*"] }, { isNew: true }), /reserved for the owner role/);
  assert.throws(() => validateRoleInput({ name: "Typo", permissions: ["users:fly"] }, { isNew: true }), /Unknown permissions: users:fly/);
  assert.throws(() => validateRoleInput({ name: "Empty scope", permissions: ["users:read"], scopes: { queues: { mode: "list", ids: [] } } }, { isNew: true }), /Queues: the selection is empty/);
  const ok = validateRoleInput({ name: "QA Reviewer · Sales", permissions: ["quality:read", "Quality_Evaluations:Create"], scopes: { queues: { mode: "list", ids: ["sales"] } } }, { isNew: true });
  assert.equal(ok.key, "qa-reviewer-sales");
  assert.deepEqual(ok.permissions, ["quality:read", "quality_evaluations:create"]);
  assert.deepEqual(ok.scopes.queues, { mode: "list", ids: ["sales"] });
  assert.equal(slugify("  Team   Leader (PL) "), "team-leader-pl");
});

test("delegation: user administrators cannot mint roles beyond their own access, owners can", () => {
  const userAdmin = access(["user-administrator"]);
  assert.doesNotThrow(() => assertDelegation(userAdmin, ["users:read", "skills:create"], { queues: { mode: "all" } }));
  assert.throws(() => assertDelegation(userAdmin, ["users:read", "campaigns:execute"], { queues: { mode: "all" } }), (err) => err.status === 403 && err.details.some((d) => d.includes("campaigns:execute")));
  assert.doesNotThrow(() => assertDelegation(access(["owner"]), ["campaigns:execute", "screen:admin.*"], {}));
});

test("role assignment rules: unknown keys, owner protections, last owner, delegation", async () => {
  const pool = mockPool({ roles: [roleRow("agent"), roleRow("owner"), roleRow("supervisor"), roleRow("campaign-manager")], users: [{ id: "u1", roles: ["agent"] }], owners: 0 });
  const admin = { id: "a1", roles: ["admin"] };
  await assert.rejects(validateRoleAssignment(pool, { actor: admin, actorAccess: access(["admin"]), targetUserId: "u1", currentRoles: ["agent"], nextRoles: ["agent", "ghost"] }), /Unknown roles: ghost/);
  await assert.rejects(validateRoleAssignment(pool, { actor: admin, actorAccess: access(["admin"]), targetUserId: "u1", currentRoles: ["agent"], nextRoles: ["agent", "owner"] }), /Only an owner can grant or revoke the Owner role/);
  await assert.rejects(validateRoleAssignment(pool, { actor: { id: "o1" }, actorAccess: access(["owner"]), targetUserId: "o1", currentRoles: ["owner"], nextRoles: ["admin"] }), /The last owner cannot lose the Owner role/);
  await assert.rejects(validateRoleAssignment(pool, { actor: admin, actorAccess: access(["admin"]), targetUserId: "u1", currentRoles: ["agent"], nextRoles: [] }), /at least one role/);
  await assert.rejects(validateRoleAssignment(pool, { actor: { id: "s1" }, actorAccess: access(["user-administrator"]), targetUserId: "u1", currentRoles: ["agent"], nextRoles: ["agent", "campaign-manager"] }), (err) => err.status === 403);
  const normalised = await validateRoleAssignment(pool, { actor: admin, actorAccess: access(["admin"]), targetUserId: "u1", currentRoles: ["agent"], nextRoles: [" Agent ", "supervisor", "supervisor"] });
  assert.deepEqual(normalised, ["agent", "supervisor"]);
  const ownerGrant = await validateRoleAssignment(pool, { actor: { id: "o1" }, actorAccess: access(["owner"]), targetUserId: "u1", currentRoles: ["agent"], nextRoles: ["agent", "owner"] });
  assert.deepEqual(ownerGrant, ["agent", "owner"]);
});

test("deleting an assigned role requires confirmation and then strips it from users with an audit row", async () => {
  const pool = mockPool({ roles: [roleRow("team-leader"), roleRow("agent")], users: [{ id: "u1", roles: ["agent", "team-leader"] }, { id: "u2", roles: ["supervisor", "team-leader"] }] });
  await assert.rejects(deleteRole(pool, "agent", { actor: { id: "a1" } }), /System roles cannot be deleted/);
  await assert.rejects(deleteRole(pool, "team-leader", { actor: { id: "a1" } }), (err) => err.status === 409 && err.details.usersCount === 2);
  const result = await deleteRole(pool, "team-leader", { actor: { id: "a1" }, removeFromUsers: true });
  assert.equal(result.removedFromUsers, 2);
  assert.deepEqual(pool.state.users.map((u) => u.roles), [["agent"], ["supervisor"]]);
  assert.ok(pool.writes.some((w) => w[0] === "strip-users"));
  assert.ok(pool.writes.some((w) => w[0] === "delete-role"));
  assert.ok(pool.writes.some((w) => w[0] === "remember-preset" && w[1][0] === "team-leader"), "a deleted preset is remembered so it does not come back");
  const audit = pool.writes.find((w) => w[0] === "audit");
  assert.equal(audit[1][2], "role.delete");
  assert.equal(pool.state.roles.has("team-leader"), false);
});

test("create, update and restore write the row and the audit inside a transaction", async () => {
  const pool = mockPool({ roles: [roleRow("agent"), roleRow("team-leader", { name: "Team Lead PL", permissions: ["monitor:read"] })], users: [{ id: "u1", roles: ["team-leader"] }] });
  const created = await createRole(pool, { name: "QA Reviewer", permissions: ["quality:read", "quality_evaluations:read"], scopes: { queues: { mode: "list", ids: ["sales"] } } }, { actor: { id: "a1" }, actorAccess: access(["owner"]) });
  assert.equal(created.key, "qa-reviewer");
  assert.equal(created.origin, "custom");
  assert.deepEqual(created.scopes.queues, { mode: "list", ids: ["sales"] });
  await assert.rejects(createRole(pool, { name: "QA Reviewer", permissions: ["quality:read"] }, { actor: { id: "a1" }, actorAccess: access(["owner"]) }), /already exists/);
  await assert.rejects(updateRole(pool, "agent", { name: "Agent", permissions: ["agent:self"] }, { actor: { id: "a1" }, actorAccess: access(["owner"]) }), /System roles are read-only/);
  const updated = await updateRole(pool, "qa-reviewer", { name: "QA Reviewer", description: "x", permissions: ["quality:read"] }, { actor: { id: "a1" }, actorAccess: access(["owner"]) });
  assert.deepEqual(updated.permissions, ["quality:read"]);
  const edited = toRoleView(pool.state.roles.get("team-leader"), { usersCount: 1 });
  assert.equal(edited.edited, true, "a preset whose permissions differ from the shipped set is marked edited");
  const restored = await restoreRole(pool, "team-leader", { actor: { id: "a1" }, actorAccess: access(["owner"]) });
  assert.equal(restored.edited, false);
  assert.equal(restored.name, "Team Leader");
  await assert.rejects(restoreRole(pool, "qa-reviewer", { actor: { id: "a1" }, actorAccess: access(["owner"]) }), /Only shipped roles can be restored/);
  const sequence = pool.writes.filter((w) => typeof w === "string");
  assert.equal(sequence.filter((w) => w === "BEGIN").length, sequence.filter((w) => w === "COMMIT").length);
});

test("roles list orders system roles first in the fixed order, then shipped, then custom by name", () => {
  const views = [roleRow("owner"), roleRow("zeta", { origin: "custom" }), roleRow("team-leader"), roleRow("agent"), roleRow("alpha", { origin: "custom" }), roleRow("admin")].map((r) => toRoleView(r));
  assert.deepEqual(sortRoles(views).map((v) => v.key), ["agent", "admin", "owner", "team-leader", "alpha", "zeta"]);
});

test("a scope list emptied by a cascade stays 'nothing' in the role view and in the assignment check", async () => {
  // Found in the dev acceptance: after a team delete the editor showed the emptied anchor as "All",
  // and saving the role untouched would have widened the scope.
  const row = roleRow("qa-reviewer", { origin: "custom", permissions: ["quality:read"], scopes: { queues: { mode: "list", ids: [] }, teams: { mode: "all" }, campaigns: { mode: "all" }, channels: { mode: "all" } } });
  assert.deepEqual(toRoleView(row).scopes.queues, { mode: "list", ids: [] }, "the editor shows an empty selection instead of All");
  const pool = mockPool({ roles: [row], users: [{ id: "u1", roles: ["agent"] }] });
  await assert.doesNotReject(validateRoleAssignment(pool, { actor: { id: "a1" }, actorAccess: access(["admin"]), targetUserId: "u1", currentRoles: ["agent"], nextRoles: ["agent", "qa-reviewer"] }));
});

test("anyone who edits users assigns the system role agent without holding it; every other role stays delegated", async () => {
  // Decision of 2026-09-16: agent is the base role every person needs, so a user administrator
  // without the agent grants still hands it out; supervisor and the shipped or custom roles do not follow.
  const pool = mockPool({ roles: [roleRow("user-administrator"), roleRow("team-leader")], users: [{ id: "u2", roles: [] }] });
  const actor = { id: "ua-1" };
  const actorAccess = access(["user-administrator"]);
  assert.deepEqual(await validateRoleAssignment(pool, { actor, actorAccess, targetUserId: "u2", currentRoles: [], nextRoles: ["agent"] }), ["agent"]);
  await assert.rejects(validateRoleAssignment(pool, { actor, actorAccess, targetUserId: "u2", currentRoles: ["agent"], nextRoles: ["agent", "supervisor"] }), /hold yourself/);
  await assert.rejects(validateRoleAssignment(pool, { actor, actorAccess, targetUserId: "u2", currentRoles: ["agent"], nextRoles: ["agent", "team-leader"] }), /hold yourself/);
  await assert.rejects(validateRoleAssignment(pool, { actor, actorAccess, targetUserId: "u2", currentRoles: ["agent"], nextRoles: ["agent", "owner"] }), /Only an owner/);
});

test("deleting a role that is somebody's only role is refused instead of leaving them with the agent defaults", async () => {
  const pool = mockPool({ roles: [roleRow("qa-reviewer", { origin: "custom", permissions: ["quality:read"] })], users: [{ id: "u1", username: "solo@test.local", roles: ["qa-reviewer"] }, { id: "u2", username: "duo@test.local", roles: ["agent", "qa-reviewer"] }] });
  await assert.rejects(deleteRole(pool, "qa-reviewer", { actor: { id: "a1" }, removeFromUsers: true }), (err) => err.status === 409 && /only role of 1 user \(solo@test.local\)/.test(err.message) && err.details.usersWithoutRole[0] === "solo@test.local");
  assert.ok(!pool.writes.some((w) => Array.isArray(w) && w[0] === "delete-role"), "nothing is written");
  pool.state.users[0].roles = ["agent", "qa-reviewer"];
  assert.deepEqual(await deleteRole(pool, "qa-reviewer", { actor: { id: "a1" }, removeFromUsers: true }), { removedFromUsers: 2 });
});

test("delegation measures the actor's scope per grant, not as the union of every role", async () => {
  // Team-scoped monitor:read from one role plus an unrelated wide role must not let the actor hand out an unrestricted monitor:read.
  const definitions = new Map([
    ["lead", { key: "lead", permissions: ["monitor:read", "agents:read"], scopes: { ...emptyScopes(), teams: { mode: "list", ids: ["t1"] } } }],
    ["role-admin", { key: "role-admin", permissions: ["roles:*", "users:*"], scopes: emptyScopes() }],
  ]);
  const actorAccess = await effectiveAccess({ id: "a1", roles: ["lead", "role-admin"] }, definitions);
  assert.throws(() => assertDelegation(actorAccess, ["monitor:read"], emptyScopes()), (err) => err.status === 403 && err.details.some((d) => /Teams: you cannot grant "all"/.test(d) && /monitor:read/.test(d)));
  assert.throws(() => assertDelegation(actorAccess, ["monitor:read"], { ...emptyScopes(), teams: { mode: "list", ids: ["t1", "t2"] } }), /hold yourself/);
  assert.doesNotThrow(() => assertDelegation(actorAccess, ["monitor:read"], { ...emptyScopes(), teams: { mode: "list", ids: ["t1"] } }));
  assert.doesNotThrow(() => assertDelegation(actorAccess, ["users:read"], emptyScopes()), "the wide role delegates its own permissions unrestricted");
  const pool = mockPool({ roles: [roleRow("wide-lead", { origin: "custom", permissions: ["monitor:read"], scopes: emptyScopes() })], users: [{ id: "u1", roles: ["agent"] }] });
  await assert.rejects(validateRoleAssignment(pool, { actor: { id: "a1" }, actorAccess, targetUserId: "u1", currentRoles: ["agent"], nextRoles: ["agent", "wide-lead"] }), /hold yourself/);
});

test("restoring a shipped role applies the delegation rule to the shipped definition", async () => {
  const pool = mockPool({ roles: [roleRow("team-leader", { permissions: ["monitor:read"] })], users: [] });
  await assert.rejects(restoreRole(pool, "team-leader", { actor: { id: "a1" }, actorAccess: access(["agent"]) }), (err) => err.status === 403 && /hold yourself/.test(err.message));
  await assert.rejects(restoreRole(pool, "team-leader", { actor: { id: "a1" } }), /actor's access is required/);
  const restored = await restoreRole(pool, "team-leader", { actor: { id: "a1" }, actorAccess: access(["admin"]) });
  assert.equal(restored.edited, false);
});

test("roles assigned together are delegated role by role, each against its own scope", async () => {
  // Codex review of #1481: the union of both roles' permissions was tested against
  // each role's scope, so a team-scoped monitor role next to an unrestricted reader
  // role failed on the reader's pass (monitor:read measured as unrestricted).
  const definitions = new Map([
    ["lead", { key: "lead", permissions: ["monitor:read"], scopes: { ...emptyScopes(), teams: { mode: "list", ids: ["t1"] } } }],
    ["role-admin", { key: "role-admin", permissions: ["roles:*", "users:*"], scopes: emptyScopes() }],
  ]);
  const actorAccess = await effectiveAccess({ id: "a1", roles: ["lead", "role-admin"] }, definitions);
  const pool = mockPool({
    roles: [
      roleRow("team-monitor", { origin: "custom", permissions: ["monitor:read"], scopes: { ...emptyScopes(), teams: { mode: "list", ids: ["t1"] } } }),
      roleRow("reader", { origin: "custom", permissions: ["users:read"], scopes: emptyScopes() }),
      roleRow("wide-monitor", { origin: "custom", permissions: ["monitor:read"], scopes: emptyScopes() }),
    ],
    users: [{ id: "u1", roles: ["agent"] }],
  });
  const assign = (nextRoles) => validateRoleAssignment(pool, { actor: { id: "a1" }, actorAccess, targetUserId: "u1", currentRoles: ["agent"], nextRoles });
  assert.deepEqual(await assign(["agent", "team-monitor", "reader"]), ["agent", "team-monitor", "reader"], "each role is covered by the actor's grant for that role's permissions");
  assert.deepEqual(await assign(["agent", "reader", "team-monitor"]), ["agent", "reader", "team-monitor"], "the order of the roles does not matter");
  await assert.rejects(assign(["agent", "reader", "wide-monitor"]), (err) => err.status === 403 && err.details.some((d) => /Teams: you cannot grant "all"/.test(d) && /monitor:read/.test(d)), "a role that really exceeds the actor's scope is still refused");
});
