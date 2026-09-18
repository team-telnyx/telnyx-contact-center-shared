// Teams (agent_groups) store and API — the prerequisite of the teams scope anchor (Phase 3a).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadRoute } from "./helpers/route-harness.mjs";
import { listScreenLeaves, resolveScreenForPath, getResource } from "../lib/authz/permissions.mjs";
import * as teamsStore from "../lib/teams/store.mjs";

const { listTeams, getTeam, createTeam, updateTeam, deleteTeam, TeamStoreError } = teamsStore;

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** In-memory agent_groups + users with the SQL the store issues. */
function teamsPool({ teams = [], users = [], roles = [] } = {}) {
  const state = { teams: new Map(teams.map((t) => [t.id, { is_active: true, description: null, ...t }])), users: users.map((u) => ({ agent_groups: [], ...u })), roles: new Map(roles.map((r) => [r.id, r])) };
  const writes = [];
  const membersOf = (id) => state.users.filter((u) => u.agent_groups.includes(id));
  async function query(sql, params = []) {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") { writes.push(text); return { rows: [] }; }
    if (text.startsWith("SELECT COUNT(*)::int AS total FROM agent_groups g")) {
      const rows = [...state.teams.values()].filter((t) => !text.includes("is_active") || t.is_active === params[params.length - 1]);
      return { rows: [{ total: rows.length }] };
    }
    if (text.startsWith("SELECT g.*, (SELECT COUNT(*)::int FROM users u WHERE g.id = ANY(u.agent_groups)) AS members_count FROM agent_groups g")) {
      let rows = [...state.teams.values()];
      if (text.includes("g.name ILIKE")) { const needle = String(params[0]).replace(/%/g, "").toLowerCase(); rows = rows.filter((t) => t.name.toLowerCase().includes(needle) || (t.description || "").toLowerCase().includes(needle)); }
      if (text.includes("g.is_active = $")) rows = rows.filter((t) => t.is_active === params[params.length - 3]);
      rows = rows.sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ ...t, members_count: membersOf(t.id).length }));
      const [limit, offset] = params.slice(-2);
      return { rows: rows.slice(offset, offset + limit) };
    }
    if (text.startsWith("SELECT * FROM agent_groups WHERE id = $1")) return { rows: state.teams.has(params[0]) ? [state.teams.get(params[0])] : [] };
    if (text.startsWith("SELECT id, username, first_name, last_name, roles, active FROM users WHERE $1 = ANY(agent_groups)")) return { rows: membersOf(params[0]) };
    if (text.startsWith("SELECT id FROM users WHERE $1 = ANY(agent_groups)")) return { rows: membersOf(params[0]).map((u) => ({ id: u.id })) };
    if (text.startsWith("SELECT id FROM users WHERE id = ANY($1::text[])")) return { rows: state.users.filter((u) => params[0].includes(u.id)).map((u) => ({ id: u.id })) };
    if (text.startsWith("UPDATE users SET agent_groups = array_remove(agent_groups, $1), updated_at = NOW() WHERE id = ANY($2::text[])")) {
      writes.push(["remove-members", params]);
      for (const u of state.users) if (params[1].includes(u.id)) u.agent_groups = u.agent_groups.filter((g) => g !== params[0]);
      return { rows: [] };
    }
    if (text.startsWith("UPDATE users SET agent_groups = array_remove(agent_groups, $1), updated_at = NOW() WHERE $1 = ANY(agent_groups)")) {
      writes.push(["remove-all-members", params]);
      for (const u of state.users) u.agent_groups = u.agent_groups.filter((g) => g !== params[0]);
      return { rows: [] };
    }
    if (text.startsWith("UPDATE users SET agent_groups = array_append")) {
      writes.push(["add-members", params]);
      for (const u of state.users) if (params[1].includes(u.id) && !u.agent_groups.includes(params[0])) u.agent_groups.push(params[0]);
      return { rows: [] };
    }
    if (text.startsWith("INSERT INTO agent_groups")) {
      if ([...state.teams.values()].some((t) => t.name === params[1])) { const err = new Error("duplicate"); err.code = "23505"; throw err; }
      writes.push(["insert-team", params]);
      state.teams.set(params[0], { id: params[0], name: params[1], description: params[2], is_active: params[3] });
      return { rows: [] };
    }
    if (text.startsWith("UPDATE agent_groups SET")) {
      if ([...state.teams.values()].some((t) => t.id !== params[0] && t.name === params[1])) { const err = new Error("duplicate"); err.code = "23505"; throw err; }
      writes.push(["update-team", params]); Object.assign(state.teams.get(params[0]), { name: params[1], description: params[2], is_active: params[3] }); return { rows: [] };
    }
    if (text.startsWith("DELETE FROM agent_groups")) { writes.push(["delete-team", params]); state.teams.delete(params[0]); return { rows: [] }; }
    if (text.startsWith("INSERT INTO cc_authz_audit")) { writes.push(["audit", params[2], params[3], params[4]]); return { rows: [] }; }
    if (text.startsWith("SELECT id, name, scopes FROM cc_roles WHERE scopes->$1->>'mode' = 'list'")) {
      return { rows: [...state.roles.values()].filter((r) => r.scopes?.[params[0]]?.mode === "list" && r.scopes[params[0]].ids.some((id) => params[1].includes(id))) };
    }
    if (text.startsWith("UPDATE cc_roles SET scopes = $2::jsonb")) { writes.push(["role-scopes", params[0]]); state.roles.get(params[0]).scopes = JSON.parse(params[1]); return { rows: [] }; }
    if (text.startsWith("SELECT id FROM users WHERE roles && $1::text[]")) return { rows: state.users.filter((u) => (u.roles || []).some((r) => params[0].includes(r))).map((u) => ({ id: u.id })) };
    throw new Error(`Unmocked query: ${text}`);
  }
  return { query, connect: async () => ({ query, release() {} }), writes, state };
}

const users = [
  { id: "u-anna", username: "anna@test.local", first_name: "Anna", last_name: "Kowalska", roles: ["agent"] },
  { id: "u-bob", username: "bob@test.local", first_name: "Bob", last_name: "Nowak", roles: ["agent"] },
  { id: "u-lead", username: "lead@test.local", first_name: "Lea", last_name: "Der", roles: ["team-leader"] },
];

test("the Teams screen is in the catalogue, in the rail before Permissions, and has a help article", () => {
  assert.ok(listScreenLeaves().some((leaf) => leaf.id === "admin.configuration.teams"));
  assert.deepEqual(resolveScreenForPath("/admin/teams"), { screen: "admin.configuration.teams", group: false });
  assert.deepEqual(getResource("teams").named, ["members.assign"]);
  const nav = source("components/admin/ConfigurationSectionNav.jsx");
  const ids = [...nav.matchAll(/\{\s*id:\s*"([a-z-]+)",\s*label:\s*"([^"]+)"[^}]*href:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids[ids.indexOf("users") + 1], "teams");
  assert.equal(ids[ids.length - 1], "permissions", "Permissions stays the last rail item");
  assert.match(source("app/(portal)/admin/teams/page.jsx"), /ConfigurationSectionPage activeId="teams"/);
  const meta = JSON.parse(source("content/help/administration/meta.json"));
  assert.equal(meta.pages[meta.pages.indexOf("users") + 1], "teams");
  assert.match(source("content/help/administration/teams.mdx"), /\naudiences: \[admin, owner\]\n/);
  assert.match(source("content/help/administration/index.mdx"), /Users, Teams, Queues/);
});

test("create, list, update membership and delete a team; every step is audited", async () => {
  const pool = teamsPool({ users, roles: [{ id: "warsaw-lead", scopes: { teams: { mode: "list", ids: ["t-1"] } } }] });
  const team = await createTeam(pool, { id: "t-1", name: "Warsaw", description: "Site A", memberIds: ["u-anna", "u-bob"] }, { actor: { id: "admin" } });
  assert.equal(team.name, "Warsaw");
  assert.equal(team.membersCount, 2);
  assert.deepEqual(team.members.map((m) => m.username), ["anna@test.local", "bob@test.local"]);
  assert.ok(pool.writes.some((w) => w[0] === "audit" && w[1] === "team.create"));

  await assert.rejects(createTeam(pool, { id: "t-dup", name: "Warsaw" }), (err) => err instanceof TeamStoreError && err.status === 409);
  await assert.rejects(createTeam(pool, { id: "t-x", name: " " }), (err) => err instanceof TeamStoreError && err.status === 400);
  await assert.rejects(updateTeam(pool, "t-1", { memberIds: ["ghost"] }), (err) => err instanceof TeamStoreError && err.status === 422 && /ghost/.test(err.message));

  const listed = await listTeams(pool, { q: "war", pageSize: 10 });
  assert.equal(listed.total, 1);
  assert.deepEqual(listed.items.map((t) => [t.name, t.membersCount, t.isActive]), [["Warsaw", 2, true]]);

  const updated = await updateTeam(pool, "t-1", { isActive: false, memberIds: ["u-bob", "u-lead"] }, { actor: { id: "admin" } });
  assert.equal(updated.isActive, false);
  assert.deepEqual(updated.members.map((m) => m.id), ["u-bob", "u-lead"]);
  assert.deepEqual(pool.state.users.find((u) => u.id === "u-anna").agent_groups, []);
  assert.deepEqual(pool.state.users.find((u) => u.id === "u-lead").agent_groups, ["t-1"]);
  const audit = pool.writes.filter((w) => w[0] === "audit" && w[1] === "team.update");
  assert.equal(audit.length, 1);

  const removed = await deleteTeam(pool, "t-1", { actor: { id: "admin" } });
  assert.deepEqual(removed, { removedFromUsers: 2, rolesUpdated: 1 });
  assert.equal(await getTeam(pool, "t-1"), null);
  assert.ok(pool.state.users.every((u) => !u.agent_groups.includes("t-1")));
  assert.deepEqual(pool.state.roles.get("warsaw-lead").scopes.teams, { mode: "list", ids: [] }, "the team leaves the role scope and the emptied list stays nothing");
  await assert.rejects(deleteTeam(pool, "t-1"), (err) => err instanceof TeamStoreError && err.status === 404);
});

test("the teams API is guarded by teams:* and answers with the store's status codes", async () => {
  const pool = teamsPool({ users, teams: [{ id: "t-1", name: "Warsaw" }] });
  const deps = (user) => ({
    env: { AUTHZ_MODE: "enforce" },
    "@/lib/auth-server": { getAuthenticatedUser: async () => user },
    "@/lib/postgres.mjs": { getPostgresPool: () => pool },
    "@/lib/role-utils": { isAdmin: (u) => u?.roles?.includes("admin") },
    "@/lib/runtime-logging.mjs": { adminRuntimeLogger: { error() {} }, runtimePayload: (v) => v },
    "@/lib/teams/store.mjs": teamsStore,
    crypto: { randomUUID: () => "t-new" },
  });
  const admin = { id: "admin-1", roles: ["admin"] };
  const agent = { id: "agent-1", roles: ["agent"] };
  const list = await loadRoute("app/api/admin/teams/route.js", deps(admin));
  const detail = await loadRoute("app/api/admin/teams/[id]/route.js", deps(admin));
  const listed = await list.GET(new Request("https://cc.test/api/admin/teams?pageSize=5"));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.map((t) => t.name), ["Warsaw"]);
  const created = await list.POST(new Request("https://cc.test/api/admin/teams", { method: "POST", body: JSON.stringify({ name: "Kraków", memberIds: ["u-anna"] }), headers: { "content-type": "application/json" } }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.team.membersCount, 1);
  const missing = await detail.GET(new Request("https://cc.test/api/admin/teams/nope"), { params: Promise.resolve({ id: "nope" }) });
  assert.equal(missing.status, 404);
  const duplicate = await detail.PUT(new Request("https://cc.test/api/admin/teams/t-1", { method: "PUT", body: JSON.stringify({ name: "Kraków" }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: "t-1" }) });
  assert.equal(duplicate.status, 409);
  const deleted = await detail.DELETE(new Request("https://cc.test/api/admin/teams/t-1"), { params: Promise.resolve({ id: "t-1" }) });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.ok, true);

  const agentList = await loadRoute("app/api/admin/teams/route.js", deps(agent));
  assert.equal((await agentList.GET(new Request("https://cc.test/api/admin/teams"))).status, 403);
  const anonymous = await loadRoute("app/api/admin/teams/route.js", deps(null));
  assert.equal((await anonymous.GET(new Request("https://cc.test/api/admin/teams"))).status, 401);
  // a Team Leader (preset) may read teams but not create them
  const leader = { id: "lead-1", roles: ["team-leader"] };
  const leaderList = await loadRoute("app/api/admin/teams/route.js", deps(leader));
  const leaderRead = await leaderList.GET(new Request("https://cc.test/api/admin/teams"));
  assert.ok([200, 403].includes(leaderRead.status));
  assert.equal((await leaderList.POST(new Request("https://cc.test/api/admin/teams", { method: "POST", body: "{}" }))).status, 403);
});
