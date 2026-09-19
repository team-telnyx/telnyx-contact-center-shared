// Test double for lib/authz/guard.js: the same decision rules as
// withPermission (401 anonymous, 403 without the permission, `authenticated`,
// `elevated` and `apiKey` options, `authz.scope`) without next/headers or a
// database. Effective access comes from the code-defined roles.
import { SYSTEM_ROLES, PRESET_ROLES } from "../../lib/authz/permissions.mjs";
import { effectiveAccess, can, canAny } from "../../lib/authz/effective.mjs";
import { resolveScopeForKeys, UNRESTRICTED } from "../../lib/authz/scope.mjs";

const definitions = new Map([...SYSTEM_ROLES, ...PRESET_ROLES].map((role) => [role.key, role]));
const AUTHENTICATED = "authenticated";

/** Role-utils double matching lib/role-utils.js semantics. */
export const roleUtilsStub = {
  isAdmin: (user) => (user?.roles || []).some((r) => ["admin", "owner"].includes(String(r).toLowerCase())),
  isSupervisorOrAdmin: (user) => (user?.roles || []).some((r) => ["supervisor", "admin", "owner"].includes(String(r).toLowerCase())),
  isSupervisor: (user) => (user?.roles || []).some((r) => String(r).toLowerCase() === "supervisor"),
  isOwner: (user) => (user?.roles || []).some((r) => String(r).toLowerCase() === "owner"),
  isAgent: (user) => (user?.roles || []).some((r) => String(r).toLowerCase() === "agent"),
};

function buildStub({ resolveUser, apiKeyCheck = null, onDeny, pool = null, roles = [] }) {
  // Extra role definitions (e.g. a scoped custom role) join the code-defined ones.
  const catalogue = new Map([...definitions, ...roles.map((role) => [role.key, role])]);
  const withPermission = (permission, handler, options = {}) => async (request, context) => {
    const required = Array.isArray(permission) ? permission : [permission];
    const apiKey = options.apiKey || apiKeyCheck;
    if (typeof apiKey === "function" && request) {
      const check = apiKey(request);
      if (check?.ok) return handler(request, context, { user: null, access: null, permitted: true, elevated: true, apiKey: true, can: () => true, scope: UNRESTRICTED });
    }
    const user = await resolveUser(request);
    if (!user) return { status: 401, body: { error: "Unauthorized" } };
    const access = await effectiveAccess(user, catalogue);
    const permitted = required.some((key) => key === AUTHENTICATED || can(access, key));
    if (!permitted) {
      onDeny?.({ permission: required, user });
      return { status: 403, body: { error: "Forbidden", permission: required.length === 1 ? required[0] : required } };
    }
    let elevated = false;
    let scopeKeys = required.filter((key) => key !== AUTHENTICATED && can(access, key));
    if (options.elevated) {
      const keys = Array.isArray(options.elevated) ? options.elevated : [options.elevated];
      elevated = canAny(access, keys);
      if (elevated) scopeKeys = keys.filter((key) => can(access, key));
    }
    const scope = await resolveScopeForKeys(typeof pool === "function" ? pool() : pool, user, access, scopeKeys);
    try {
      return await handler(request, context, { user, access, permitted, elevated, apiKey: false, can: (key) => (Array.isArray(key) ? canAny(access, key) : can(access, key)), scope });
    } catch (err) {
      if (err && typeof err.status === "number" && err.status < 500) return { status: err.status, body: { error: err.message } };
      throw err;
    }
  };
  const authzErrorResponse = (err) => ({ status: err?.status || 500, body: { error: err?.message } });
  return { withPermission, requirePermission: async () => { throw new Error("requirePermission is not stubbed; use withPermission"); }, authzErrorResponse, AUTHENTICATED };
}

/**
 * Build the `@/lib/authz/guard` dependency for loadRoute() from a fixed user.
 * @param {{ user: object|null, onDeny?: Function, pool?: object|Function, roles?: object[] }} options
 *        `pool` answers the scope queries of `own` anchors and team membership;
 *        `roles` adds role definitions (for example a scoped custom role).
 */
export function authzGuardStub({ user, onDeny, pool = null, roles = [] } = {}) {
  return buildStub({ resolveUser: async () => user, onDeny, pool, roles });
}

/**
 * Default guard for loadRoute(): the user comes from the test's own
 * `@/lib/auth-server` mock (getAuthenticatedUser) and machine access from the
 * test's `@/app/api/_utils/ai-auth` mock, so existing route tests keep their
 * meaning without naming the guard.
 */
export function guardStubFromDeps(deps = {}) {
  const auth = deps["@/lib/auth-server"] || {};
  const nextAuth = deps["next-auth"] || {};
  const pgdb = deps["@/lib/pgdb"]?.PgDb || {};
  const resolveUser = async (request) => {
    if (typeof auth.getAuthenticatedUser === "function") return auth.getAuthenticatedUser(request?.url);
    // Older route tests mock the session and the user table the way the
    // former local requireAdmin helpers read them.
    if (typeof nextAuth.getServerSession === "function") {
      const session = await nextAuth.getServerSession(deps["@/app/api/auth/[...nextauth]/route"]?.authOptions);
      const id = session?.user?.id || null;
      const email = session?.user?.email || null;
      if (!id && !email) return null;
      let user = null;
      if (id && typeof pgdb.findUserById === "function") user = await pgdb.findUserById(id);
      if (!user && email && typeof pgdb.findUserByUsername === "function") user = await pgdb.findUserByUsername(email);
      return user || (id ? { id, username: email, roles: session?.user?.roles || ["agent"] } : null);
    }
    return null;
  };
  const apiKeyCheck = deps["@/app/api/_utils/ai-auth"]?.requireAiApiKey || null;
  const pool = deps["@/lib/postgres.mjs"]?.getPostgresPool || null;
  return buildStub({ resolveUser, apiKeyCheck, pool, roles: deps.authzRoles || [] });
}

export const USERS = {
  anonymous: null,
  agent: { id: "agent-1", username: "agent@test.local", roles: ["agent"] },
  supervisor: { id: "sup-1", username: "sup@test.local", roles: ["supervisor"] },
  admin: { id: "admin-1", username: "admin@test.local", roles: ["admin"] },
  owner: { id: "owner-1", username: "owner@test.local", roles: ["owner"] },
  teamLeader: { id: "lead-1", username: "lead@test.local", roles: ["team-leader"] },
  designer: { id: "designer-1", username: "designer@test.local", roles: ["conversation-designer"] },
  campaignManager: { id: "cm-1", username: "cm@test.local", roles: ["campaign-manager"] },
};
