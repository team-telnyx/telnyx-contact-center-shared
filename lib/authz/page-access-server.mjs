/**
 * Server side of page authorisation: which screens a user may open, decided
 * from the database with a short per-instance cache (D-16: a role change
 * reaches the user within 10 seconds). An unreadable database grants no screens;
 * an old token snapshot cannot restore revoked access.
 */
import { getPostgresPool } from "../postgres.mjs";
import { effectiveAccess, onAuthzChanged, permittedScreens } from "./effective.mjs";
import { compactScreenGrants, WILDCARD } from "./permissions.mjs";
import { decidePageAccess } from "./page-access.mjs";
import { authLogger, securityErrorPayload } from "../security-logging.mjs";

export const SCREENS_CACHE_TTL_MS = 10_000;

const cache = new Map(); // userId -> { at, screens }
let subscribed = false;

function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  onAuthzChanged(({ roleKeys = [], userIds = [] } = {}) => {
    if (roleKeys.length || !userIds.length) cache.clear();
    else for (const id of userIds) cache.delete(String(id));
  });
}

/** Compact grant list for a user's access: "*" for owners, group wildcards where every leaf is granted. */
export function screenGrantsFor(access) {
  if (!access) return [];
  if (access.wildcard) return [WILDCARD];
  return compactScreenGrants(permittedScreens(access)).map((key) => key.replace(/^screen:/, ""));
}

/** Snapshot stored in the NextAuth token by the jwt callback. */
export async function authzSnapshotFor(user) {
  const access = await effectiveAccess(user);
  return { at: Date.now(), screens: screenGrantsFor(access) };
}

export function invalidateScreensCache(userId = null) {
  if (userId == null) cache.clear();
  else cache.delete(String(userId));
}

/**
 * Screen grants of a user: bounded cache → database → no grants on failure.
 * @param {string} userId
 * @param {{ token?: object }} options   retained for caller compatibility
 */
export async function screensForUser(userId, { token = null } = {}) {
  ensureSubscribed();
  const key = String(userId || "");
  if (!key) return null;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < SCREENS_CACHE_TTL_MS) return cached.screens;
  try {
    const pool = getPostgresPool();
    if (!pool) throw new Error("database unavailable");
    const row = (await pool.query("SELECT id, username, roles, agent_groups, active FROM users WHERE id = $1", [key])).rows[0];
    if (!row) return [];
    if (row.active === false) return [];
    const access = await effectiveAccess(row);
    const screens = screenGrantsFor(access);
    cache.set(key, { at: Date.now(), screens });
    return screens;
  } catch (err) {
    authLogger.warn("authz_page_screens_unavailable", { userId: key, ...securityErrorPayload(err) });
    return []; // A stale token must not restore revoked permissions.
  }
}

/**
 * Decide a page request for a signed-in user.
 * @returns {Promise<ReturnType<typeof decidePageAccess>>}
 */
export async function authorizePage({ token, pathname, search = "" }) {
  const userId = token?.id ? String(token.id) : null;
  if (!userId) return decidePageAccess({ pathname, search, screens: null });
  const screens = await screensForUser(userId, { token });
  return decidePageAccess({ pathname, search, screens });
}
