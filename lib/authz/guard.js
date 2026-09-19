/**
 * Request-facing authorisation guard.
 *
 * The permission decision is final (RBAC Phase 5): a route names the
 * permission (or any of a list) that admits a caller, and the caller's roles
 * decide. The `AUTHZ_MODE` rollout switch and the per-route legacy role
 * predicates of Phases 0–3 are gone.
 *
 * Options:
 *   elevated              permission (or list) that unlocks acting on other people's
 *                         data in routes with a self rule; exposed as `authz.elevated`
 *   apiKey(request)       machine access check (e.g. requireAiApiKey); a passing key
 *                         skips the session entirely and yields `authz.apiKey === true`
 *   route                 label for logs
 *
 * The handler receives `authz = { user, access, permitted, elevated, apiKey, can, scope }`;
 * `authz.scope` (lib/authz/scope.mjs) is the data scope of the grants that admitted the
 * request — the elevated keys when the caller is elevated, otherwise the required keys (D-22).
 */
import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { effectiveAccess, can, canAny, onAuthzChanged } from "@/lib/authz/effective.mjs";
import { resolveScopeForKeys, UNRESTRICTED } from "@/lib/authz/scope.mjs";
import { authLogger } from "@/lib/security-logging.mjs";

/** Permission value meaning "any signed-in user". */
export const AUTHENTICATED = "authenticated";

export class AuthzError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function permittedBy(access, required) {
  return required.some((key) => key === AUTHENTICATED || can(access, key));
}

/**
 * Resolve the caller and check one permission (or any of a list).
 * @returns {Promise<{ user, access, permitted, elevated, apiKey, can, scope }>}
 * @throws {AuthzError} 401 when unauthenticated, 403 when denied
 */
export async function requirePermission(permission, { request, route, elevated, apiKey } = {}) {
  const required = Array.isArray(permission) ? permission : [permission];
  if (typeof apiKey === "function" && request) {
    const check = apiKey(request);
    if (check?.ok) return { user: null, access: null, permitted: true, elevated: true, apiKey: true, can: () => true, scope: UNRESTRICTED };
  }
  const user = await getAuthenticatedUser(request?.url);
  if (!user || user.active === false) throw new AuthzError(401, "Unauthorized");
  const access = await effectiveAccess(user);
  const permitted = permittedBy(access, required);
  if (!permitted) {
    authLogger.warn("authz_denied", { route: route || request?.url || null, method: request?.method || null, userId: String(user.id), roles: user.roles || [], permission: required });
    throw new AuthzError(403, "Forbidden", { permission: required.length === 1 ? required[0] : required });
  }
  let elevatedFlag = false;
  let scopeKeys = required.filter((key) => key !== AUTHENTICATED && can(access, key));
  if (elevated) {
    const elevatedKeys = Array.isArray(elevated) ? elevated : [elevated];
    elevatedFlag = canAny(access, elevatedKeys);
    if (elevatedFlag) scopeKeys = elevatedKeys.filter((key) => can(access, key));
  }
  const scope = await resolveScopeForKeys(await scopePool(access, scopeKeys), user, access, scopeKeys);
  return { user, access, permitted, elevated: elevatedFlag, apiKey: false, can: (key) => (Array.isArray(key) ? canAny(access, key) : can(access, key)), scope };
}

// The pool is only needed when a scoped role admitted the request (`own`
// anchors and team membership are resolved from the database).
async function scopePool(access, keys) {
  if (!keys.length || access.wildcard || !(access.definitions || []).some((def) => hasNarrowedAnchor(def.scopes))) return null;
  const { getPostgresPool } = await import("@/lib/postgres.mjs");
  return getPostgresPool();
}

function hasNarrowedAnchor(scopes) {
  return Boolean(scopes) && Object.values(scopes).some((entry) => entry && typeof entry === "object" && "mode" in entry && entry.mode !== "all");
}

/** Turn an AuthzError (or any error with .status) into a JSON response. */
export function authzErrorResponse(err) {
  const status = err?.status || 500;
  const body = { error: err?.message || "Request failed" };
  if (err?.extra?.permission) body.permission = err.extra.permission;
  if (err?.extra?.details) body.details = err.extra.details;
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Wrap a route handler: `withPermission("users:read", async (request, context, authz) => ...)`.
 */
export function withPermission(permission, handler, options = {}) {
  return async (request, context) => {
    try {
      const authz = await requirePermission(permission, { ...options, request, route: options.route });
      const source = new AbortController();
      const originalSignal = request?.signal;
      const handlerRequest = request ? new Proxy(request, { get(target, key) {
        if (key === "signal") return source.signal;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } }) : request;
      const abort = () => source.abort();
      originalSignal?.addEventListener("abort", abort, { once: true });
      let response;
      try { response = await handler(handlerRequest, context, authz); }
      catch (err) { originalSignal?.removeEventListener("abort", abort); abort(); throw err; }
      if (!authz.apiKey && response?.headers?.get("content-type")?.includes("text/event-stream") && response.body) {
        const { guardEventStream } = await import("@/lib/authz/stream.mjs");
        const { PgDb } = await import("@/lib/pgdb");
        const fingerprint = (user, access) => JSON.stringify([user.roles, user.agent_groups, access.definitions]);
        const initial = fingerprint(authz.user, authz.access);
        return guardEventStream(response, {
          signal: originalSignal,
          abort: () => { originalSignal?.removeEventListener("abort", abort); abort(); },
          subscribe: onAuthzChanged,
          authorize: async () => {
            const user = await PgDb.findUserById(authz.user.id);
            if (!user || user.active === false) return false;
            const access = await effectiveAccess(user);
            if (fingerprint(user, access) !== initial) return false;
            const required = Array.isArray(permission) ? permission : [permission];
            if (!permittedBy(access, required)) return false;
            const elevatedKeys = options.elevated ? (Array.isArray(options.elevated) ? options.elevated : [options.elevated]) : [];
            const keys = (authz.elevated ? elevatedKeys : required).filter((key) => key !== AUTHENTICATED && can(access, key));
            const scope = await resolveScopeForKeys(await scopePool(access, keys), user, access, keys);
            return JSON.stringify(scope) === JSON.stringify(authz.scope);
          },
        });
      }
      originalSignal?.removeEventListener("abort", abort);
      return response;
    } catch (err) {
      if (err instanceof AuthzError || (err && typeof err.status === "number" && err.status < 500)) return authzErrorResponse(err);
      throw err;
    }
  };
}
