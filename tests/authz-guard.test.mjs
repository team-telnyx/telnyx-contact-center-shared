import test from "node:test";
import assert from "node:assert/strict";
import { loadRoute } from "./helpers/route-harness.mjs";
import { SYSTEM_ROLES, PRESET_ROLES } from "../lib/authz/permissions.mjs";
import { effectiveAccess, can, canAny } from "../lib/authz/effective.mjs";

const definitions = new Map([...SYSTEM_ROLES, ...PRESET_ROLES].map((role) => [role.key, role]));

async function guard({ user } = {}) {
  const logs = [];
  const authz = await loadRoute("lib/authz/guard.js", {
    "@/lib/auth-server": { getAuthenticatedUser: async () => user },
    "@/lib/authz/effective.mjs": { effectiveAccess: async (u) => effectiveAccess(u, definitions), can, canAny },
    "@/lib/security-logging.mjs": { authLogger: { warn: (name, payload) => logs.push([name, payload]) } },
  });
  return { authz, logs };
}

const request = { url: "http://test.local/api/admin/roles", method: "GET" };
const handler = async (req, ctx, auth) => ({ status: 200, body: { userId: auth.user.id, permitted: auth.permitted } });

test("an anonymous caller receives 401 before any permission logic", async () => {
  const { authz } = await guard({ user: null });
  const response = await authz.withPermission("roles:manage", handler)(request, {});
  assert.equal(response.status, 401);
});

test("the permission decides: admin passes, agent is refused with the permission named", async () => {
  const { authz } = await guard({ user: { id: "a1", roles: ["admin"] } });
  assert.equal((await authz.withPermission("roles:manage", handler)(request, {})).status, 200);
  const { authz: agentGuard, logs } = await guard({ user: { id: "u1", roles: ["agent"] } });
  const denied = await agentGuard.withPermission("roles:manage", handler)(request, {});
  assert.equal(denied.status, 403);
  assert.equal(denied.body.permission, "roles:manage");
  assert.equal(logs.some(([name]) => name === "authz_denied"), true);
});

test("a shipped role passes on its own permissions; a role name never decides (Phase 5)", async () => {
  const supervisor = await guard({ user: { id: "s1", roles: ["supervisor"] } });
  const denied = await supervisor.authz.withPermission("roles:manage", handler, { route: "/api/admin/roles" })(request, {});
  assert.equal(denied.status, 403);
  assert.equal(supervisor.logs.find(([name]) => name === "authz_denied")[1].route, "/api/admin/roles");

  // user-administrator holds roles:manage without being an admin
  const userAdmin = await guard({ user: { id: "m1", roles: ["user-administrator"] } });
  assert.equal((await userAdmin.authz.withPermission("roles:manage", handler)(request, {})).status, 200);
  assert.equal(userAdmin.logs.length, 0, "nothing is logged for a granted request");

  // `elevated` follows the permission too
  const elevatedHandler = async (req, ctx, auth) => ({ status: 200, body: { elevated: auth.elevated } });
  const agent = await guard({ user: { id: "u1", roles: ["agent"] } });
  assert.equal((await agent.authz.withPermission(["interactions:read", "agent:self"], elevatedHandler, { elevated: "monitor:read" })(request, {})).body.elevated, false);
  assert.equal((await supervisor.authz.withPermission(["interactions:read", "agent:self"], elevatedHandler, { elevated: "monitor:read" })(request, {})).body.elevated, true);
});

test("a list of permissions passes when any of them is held", async () => {
  const { authz } = await guard({ user: { id: "c1", roles: ["compliance-auditor"] } });
  assert.equal((await authz.withPermission(["roles:manage", "roles:read"], handler)(request, {})).status, 200);
  assert.equal((await authz.withPermission(["roles:manage", "users:create"], handler)(request, {})).status, 403);
});

test("handler errors with a client status become JSON responses, others propagate", async () => {
  const { authz } = await guard({ user: { id: "o1", roles: ["owner"] } });
  const clientError = await authz.withPermission("roles:manage", async () => { throw Object.assign(new Error("Bad input"), { status: 422 }); })(request, {});
  assert.equal(clientError.status, 422);
  assert.equal(clientError.body.error, "Bad input");
  await assert.rejects(authz.withPermission("roles:manage", async () => { throw new Error("boom"); })(request, {}), /boom/);
});
