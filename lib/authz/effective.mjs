/**
 * Effective permissions — union of every role assigned to a user.
 *
 * Role definitions come from cc_roles and are cached in-process for a short
 * time. The cache is dropped immediately on every role write in this process
 * and, across instances, on the `authz:changed` event-bus topic, so a change
 * reaches API decisions well inside the 10-second budget (decision D-16).
 */
import { getPostgresPool } from "../postgres.mjs";
import {
  SCOPE_ANCHORS,
  expandGrants,
  matches,
  normalizeKey,
  normalizeScopes,
  emptyScopes,
  WILDCARD,
  SCREEN_PREFIX,
  listScreenLeaves,
} from "./permissions.mjs";
import { authLogger, securityErrorPayload } from "../security-logging.mjs";

export const ROLE_CACHE_TTL_MS = 10_000;
export const AUTHZ_TOPIC = "authz:changed";

const runtime = (globalThis.__cc_authz_runtime ||= {
  definitions: null,
  loadedAt: 0,
  version: 0,
  subscribing: null,
  unsubscribe: null,
});

function rowToDefinition(row) {
  const { scopes } = normalizeScopes(row.scopes || {}, { strict: false });
  return {
    key: row.id,
    name: row.name,
    description: row.description || "",
    is_system: Boolean(row.is_system),
    origin: row.origin || (row.is_system ? "system" : "custom"),
    permissions: Array.isArray(row.permissions) ? row.permissions.map(normalizeKey).filter(Boolean) : [],
    scopes,
    updated_at: row.updated_at || null,
  };
}

export function invalidateRoleDefinitions() {
  runtime.definitions = null;
  runtime.loadedAt = 0;
  runtime.version += 1;
}

const changeListeners = new Set();

/**
 * Subscribe to role and assignment changes seen by this instance (local
 * publishes and bus messages from other instances). The listener receives
 * `{ roleKeys, userIds, reason }`. Returns an unsubscribe function.
 */
export function onAuthzChanged(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyChangeListeners(payload) {
  for (const listener of changeListeners) {
    try {
      listener(payload || {});
    } catch (err) {
      authLogger.warn("authz_change_listener_failed", { ...securityErrorPayload(err) });
    }
  }
}

export function roleDefinitionsVersion() {
  return runtime.version;
}

/**
 * Load persisted role definitions. A failed read grants no permissions, even
 * after a previous successful read. Never resurrect defaults after revocation.
 */
export async function loadRoleDefinitions(pool = getPostgresPool(), { force = false } = {}) {
  const fresh = runtime.definitions && Date.now() - runtime.loadedAt < ROLE_CACHE_TTL_MS;
  if (fresh && !force) return runtime.definitions;
  if (!pool) return new Map();
  try {
    const res = await pool.query(`SELECT id, name, description, is_system, origin, permissions, scopes, updated_at FROM cc_roles`);
    const map = new Map();
    for (const row of res.rows || []) map.set(row.id, rowToDefinition(row));
    // Only persisted policies may grant access; seeding is a separate bootstrap step.
    runtime.definitions = map;
    runtime.loadedAt = Date.now();
    ensureInvalidationSubscriber(pool);
    return map;
  } catch (err) {
    authLogger.warn("authz_role_definitions_unavailable", { ...securityErrorPayload(err) });
    runtime.definitions = null;
    runtime.loadedAt = 0;
    return new Map();
  }
}

/** Subscribe once per process to cross-instance invalidations (best effort). */
function ensureInvalidationSubscriber(pool) {
  if (runtime.unsubscribe || runtime.subscribing) return;
  if (!pool || String(process.env.AUTHZ_BUS || "on").toLowerCase() === "off") return;
  if (!process.env.POSTGRES_HOST) return;
  runtime.subscribing = (async () => {
    try {
      const { subscribe } = await import("../events/event-bus.js");
      runtime.unsubscribe = await subscribe(AUTHZ_TOPIC, async (message = {}) => {
        if (message?.origin === instanceId()) return;
        invalidateRoleDefinitions();
        notifyChangeListeners(message);
      });
    } catch (err) {
      authLogger.warn("authz_bus_subscribe_failed", { ...securityErrorPayload(err) });
    } finally {
      runtime.subscribing = null;
    }
  })();
}

function instanceId() {
  return (globalThis.__cc_authz_instance_id ||= `${process.pid || "pid"}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/**
 * Announce a role or assignment change: drop the local cache, tell other
 * instances, and push `authz_changed` to every affected connected user.
 */
export async function publishAuthzChanged({ roleKeys = [], userIds = [], reason = "role.update" } = {}) {
  invalidateRoleDefinitions();
  const payload = { roleKeys, userIds, reason, at: new Date().toISOString() };
  notifyChangeListeners(payload);
  try {
    if (process.env.POSTGRES_HOST) {
      const { publish } = await import("../events/event-bus.js");
      await publish(AUTHZ_TOPIC, { ...payload, origin: instanceId() });
    }
  } catch (err) {
    authLogger.warn("authz_bus_publish_failed", { ...securityErrorPayload(err) });
  }
  try {
    const { broadcastToKey } = await import("../sse.js");
    for (const userId of new Set(userIds.map(String))) {
      await broadcastToKey(`user:status:${userId}`, payload, "authz_changed");
    }
  } catch (err) {
    authLogger.warn("authz_sse_push_failed", { ...securityErrorPayload(err) });
  }
}

// ---------------------------------------------------------------- effective access

function unionScopes(definitions) {
  const scopes = emptyScopes();
  for (const anchor of SCOPE_ANCHORS) {
    const modes = definitions.map((d) => d.scopes?.[anchor.id] || { mode: "all" });
    if (!modes.length || modes.some((m) => m.mode === "all")) { scopes[anchor.id] = { mode: "all" }; continue; }
    const ids = new Set();
    let own = false;
    for (const m of modes) {
      if (m.mode === "own" || m.own) own = true;
      if (m.mode === "list") for (const id of m.ids || []) ids.add(id);
    }
    // An emptied list without `own` stays "nothing" (permission tree rule 6).
    scopes[anchor.id] = ids.size || !own ? { mode: "list", ids: [...ids], own } : { mode: "own", own: true };
  }
  const objects = {};
  for (const d of definitions) {
    for (const [resource, entry] of Object.entries(d.scopes?.objects || {})) {
      const current = objects[resource];
      if (entry.mode === "all" || current?.mode === "all") { objects[resource] = { mode: "all" }; continue; }
      objects[resource] = { mode: "list", ids: [...new Set([...(current?.ids || []), ...(entry.ids || [])])] };
    }
  }
  if (Object.keys(objects).length) scopes.objects = objects;
  return scopes;
}

/**
 * Compute a user's effective access.
 * @returns {{ roles: string[], unknownRoles: string[], keys: string[], screens: Set<string>, operations: Set<string>, wildcard: boolean, scopes: object }}
 */
export async function effectiveAccess(user, definitions = null) {
  const defs = definitions || (await loadRoleDefinitions());
  const assigned = Array.isArray(user?.roles) && user.roles.length ? user.roles.map((r) => String(r || "").toLowerCase()).filter(Boolean) : ["agent"];
  const found = [];
  const unknownRoles = [];
  for (const key of assigned) {
    const def = defs.get(key);
    if (def) found.push(def);
    else unknownRoles.push(key);
  }
  const keys = [...new Set(found.flatMap((d) => d.permissions))];
  const expanded = expandGrants(keys);
  const wildcard = expanded.wildcard;
  const scopes = wildcard ? emptyScopes() : unionScopes(found);
  return { roles: assigned, unknownRoles, keys, screens: expanded.screens, operations: expanded.operations, wildcard, scopes, definitions: found };
}

/**
 * Scope that applies to one permission: the union of the scopes of the roles
 * that grant it. A role's scope limits only what that role grants, so an
 * `agent` role (scope all) does not widen a Team Leader's `monitor:read`
 * (scope own). `access.scopes` remains the user-wide summary for display.
 */
export function scopeFor(access, required) {
  if (!access) return emptyScopes();
  if (access.wildcard) return emptyScopes();
  const key = normalizeKey(required);
  const granting = (access.definitions || []).filter((def) => (def.permissions || []).some((granted) => matches(granted, key)));
  if (!granting.length) return null;
  return { ...unionScopes(granting), grants: granting.map((def) => def.scopes || emptyScopes()) };
}

/** Does the effective access satisfy a required key? */
export function can(access, required) {
  if (!access) return false;
  if (access.wildcard) return true;
  const key = normalizeKey(required);
  if (!key) return false;
  if (key.startsWith(SCREEN_PREFIX)) {
    const target = key.slice(SCREEN_PREFIX.length);
    if (target.endsWith(".*")) return [...access.screens].some((s) => s === target.slice(0, -2) || s.startsWith(target.slice(0, -1)));
    return access.screens.has(target);
  }
  if (key === WILDCARD) return false;
  if (access.operations.has(key)) return true;
  return access.keys.some((granted) => matches(granted, key));
}

export function canAny(access, required = []) {
  return required.some((key) => can(access, key));
}

/** Screen ids the user may open (used by /api/auth/me and the sidebar). */
export function permittedScreens(access) {
  if (access.wildcard) return listScreenLeaves().map((leaf) => leaf.id);
  return [...access.screens].sort();
}

/** Serialisable summary for clients. */
export function describeAccess(access) {
  return {
    roles: access.roles,
    unknownRoles: access.unknownRoles,
    permissions: access.wildcard ? [WILDCARD] : [...new Set([...access.keys])].sort(),
    operations: access.wildcard ? [WILDCARD] : [...access.operations].sort(),
    screens: permittedScreens(access),
    scopes: access.scopes,
    wildcard: access.wildcard,
  };
}

/** Convenience for API routes and pages. */
export async function loadUserAccess(user) {
  const access = await effectiveAccess(user);
  return { access, summary: describeAccess(access) };
}
