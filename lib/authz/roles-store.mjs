/**
 * Roles store — cc_roles and cc_authz_audit access with the protective rules
 * of the model: immutable system roles, owner as wildcard, delegation
 * (nobody grants what they do not hold), and delete-with-cleanup.
 */
import { randomUUID } from "crypto";
import {
  SYSTEM_ROLES,
  PRESET_ROLES,
  RESERVED_ROLE_KEYS,
  ROLE_KEY_PATTERN,
  normalizePermissionKeys,
  normalizeScopes,
  summarizeGrants,
  isSubsetOf,
  expandGrants,
  WILDCARD, SCOPE_ANCHORS } from "./permissions.mjs";
import { publishAuthzChanged, effectiveAccess, scopeFor } from "./effective.mjs";

const PRESET_BY_KEY = new Map(PRESET_ROLES.map((role) => [role.key, role]));
/** The base role of every person; assignable without holding its grants (decision of 2026-09-16). */
const BASE_ROLE_KEY = "agent";

const SYSTEM_BY_KEY = new Map(SYSTEM_ROLES.map((role) => [role.key, role]));

export class RoleStoreError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    if (details) this.details = details;
  }
}

function sameSet(a = [], b = []) {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

function presetEdited(row) {
  const preset = PRESET_BY_KEY.get(row.id);
  if (!preset) return false;
  const { scopes } = normalizeScopes(row.scopes || {}, { strict: false });
  return !sameSet(row.permissions || [], preset.permissions) || JSON.stringify(scopes) !== JSON.stringify(preset.scopes) || row.name !== preset.name;
}

export function toRoleView(row, { usersCount = 0 } = {}) {
  // Stored scopes are read leniently: a list emptied by a cascade delete stays "nothing" in the editor instead of showing (and, on save, becoming) "all".
  const { scopes } = normalizeScopes(row.scopes || {}, { strict: false });
  const permissions = Array.isArray(row.permissions) ? row.permissions : [];
  const summary = summarizeGrants(permissions);
  return {
    key: row.id,
    name: row.name,
    description: row.description || "",
    isSystem: Boolean(row.is_system),
    origin: row.origin || (row.is_system ? "system" : "custom"),
    permissions,
    scopes,
    summary,
    edited: row.origin === "preset" ? presetEdited(row) : false,
    usersCount: Number(usersCount || 0),
    createdBy: row.created_by || null,
    createdAt: row.created_at || null,
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at || null,
  };
}

const ORIGIN_RANK = { system: 0, preset: 1, custom: 2 };
const SYSTEM_RANK = { agent: 0, supervisor: 1, admin: 2, owner: 3 };

export function sortRoles(views) {
  return [...views].sort((a, b) => {
    const ra = ORIGIN_RANK[a.origin] ?? 3;
    const rb = ORIGIN_RANK[b.origin] ?? 3;
    if (ra !== rb) return ra - rb;
    if (a.origin === "system") return (SYSTEM_RANK[a.key] ?? 9) - (SYSTEM_RANK[b.key] ?? 9);
    return a.name.localeCompare(b.name);
  });
}

export async function listRoles(pool) {
  const res = await pool.query(
    `SELECT r.*, COALESCE(u.c, 0) AS users_count
       FROM cc_roles r
       LEFT JOIN LATERAL (SELECT COUNT(*)::int AS c FROM users WHERE r.id = ANY(users.roles)) u ON true`,
  );
  return sortRoles((res.rows || []).map((row) => toRoleView(row, { usersCount: row.users_count })));
}

export async function getRole(pool, key) {
  const res = await pool.query(
    `SELECT r.*, (SELECT COUNT(*)::int FROM users WHERE r.id = ANY(users.roles)) AS users_count FROM cc_roles r WHERE r.id = $1`,
    [String(key || "").toLowerCase()],
  );
  const row = res.rows?.[0];
  return row ? toRoleView(row, { usersCount: row.users_count }) : null;
}

export async function usersWithRole(pool, key) {
  const res = await pool.query(`SELECT id FROM users WHERE $1 = ANY(roles)`, [key]);
  return (res.rows || []).map((row) => String(row.id));
}

export async function writeAudit(db, { actorId, action, targetType, targetId, before = null, after = null }) {
  await db.query(
    `INSERT INTO cc_authz_audit (id, actor_id, action, target_type, target_id, before, after) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), actorId ? String(actorId) : null, action, targetType, String(targetId), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
  );
}

export async function listAudit(pool, { targetType, targetId, limit = 20 } = {}) {
  const params = [];
  const where = [];
  if (targetType) { params.push(targetType); where.push(`a.target_type = $${params.length}`); }
  if (targetId) { params.push(String(targetId)); where.push(`a.target_id = $${params.length}`); }
  params.push(Math.min(200, Math.max(1, Number(limit) || 20)));
  const res = await pool.query(
    `SELECT a.*, u.username AS actor_username, u.first_name AS actor_first_name, u.last_name AS actor_last_name
       FROM cc_authz_audit a LEFT JOIN users u ON u.id = a.actor_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY a.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return (res.rows || []).map((row) => ({
    id: row.id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    before: row.before,
    after: row.after,
    createdAt: row.created_at,
    actor: row.actor_id ? { id: row.actor_id, username: row.actor_username, name: [row.actor_first_name, row.actor_last_name].filter(Boolean).join(" ") || row.actor_username } : null,
  }));
}

// ---------------------------------------------------------------- validation

/**
 * Validate the body of a create/update request.
 * @returns {{ key, name, description, permissions, scopes }} normalised
 * @throws {RoleStoreError} 422 with details
 */
export function validateRoleInput(body = {}, { isNew = false, existing = null } = {}) {
  const errors = [];
  const name = String(body.name || "").trim();
  if (!name) errors.push("Give the role a name.");
  if (name.length > 80) errors.push("The name is too long (80 characters maximum).");
  let key = existing?.key || String(body.key || "").trim().toLowerCase();
  if (isNew) {
    if (!key) key = slugify(name);
    if (!ROLE_KEY_PATTERN.test(key)) errors.push("The key must be 2–40 characters: lowercase letters, digits and hyphens.");
    if (RESERVED_ROLE_KEYS.includes(key)) errors.push(`"${key}" is reserved for a system role.`);
  }
  const description = String(body.description || "").trim().slice(0, 500);
  const { keys: permissions, unknown } = normalizePermissionKeys(body.permissions);
  // Keys the running version does not know but the stored role already holds
  // (a newer deployment wrote them) are kept, never silently dropped.
  const inherited = unknown.filter((key) => (existing?.permissions || []).includes(key));
  const unexpected = unknown.filter((key) => !inherited.includes(key));
  if (unexpected.length) errors.push(`Unknown permissions: ${unexpected.join(", ")}`);
  permissions.push(...inherited);
  if (permissions.includes(WILDCARD)) errors.push("The wildcard \"*\" is reserved for the owner role.");
  if (!permissions.length) errors.push("Grant at least one screen or operation.");
  const { scopes, errors: scopeErrors } = normalizeScopes(body.scopes);
  errors.push(...scopeErrors);
  if (errors.length) throw new RoleStoreError(422, errors[0], errors);
  return { key, name, description, permissions, scopes };
}

export function slugify(text) {
  return String(text || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/**
 * The scope the actor may delegate for each operation: the scope of the roles
 * that grant it (D-22), never the user-wide union — otherwise a role with a
 * wide but unrelated scope would lend it to a permission held only narrowly.
 * Access objects without role definitions fall back to the union.
 */
function holderScopesFor(actorAccess) {
  return Array.isArray(actorAccess?.definitions) ? (operation) => scopeFor(actorAccess, operation) : actorAccess?.scopes;
}

/** Delegation rule (D-4): the actor may grant only what they hold. */
export function assertDelegation(actorAccess, permissions, scopes) {
  if (!actorAccess) throw new RoleStoreError(500, "The actor's access is required for the delegation check.");
  if (actorAccess.wildcard) return;
  const holderExpanded = { screens: actorAccess.screens, operations: actorAccess.operations, wildcard: actorAccess.wildcard };
  const check = isSubsetOf(permissions, scopes, holderExpanded, holderScopesFor(actorAccess));
  if (!check.ok) {
    const details = [...check.missing.map((k) => `Outside your own access: ${k}`), ...check.scopeIssues];
    throw new RoleStoreError(403, "You can grant only permissions and scopes you hold yourself.", details);
  }
}

// ---------------------------------------------------------------- writes

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

export async function createRole(pool, body, { actor, actorAccess }) {
  const input = validateRoleInput(body, { isNew: true });
  assertDelegation(actorAccess, input.permissions, input.scopes);
  const existing = await pool.query(`SELECT id FROM cc_roles WHERE id = $1`, [input.key]);
  if (existing.rows?.length) throw new RoleStoreError(409, `A role with the key "${input.key}" already exists.`);
  await withTransaction(pool, async (db) => {
    await db.query(
      `INSERT INTO cc_roles (id, name, description, is_system, origin, permissions, scopes, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, false, 'custom', $4, $5::jsonb, $6, $6, NOW(), NOW())`,
      [input.key, input.name, input.description, input.permissions, JSON.stringify(input.scopes), actor ? String(actor.id) : null],
    );
    await writeAudit(db, { actorId: actor?.id, action: "role.create", targetType: "role", targetId: input.key, after: { name: input.name, permissions: input.permissions, scopes: input.scopes } });
  });
  await publishAuthzChanged({ roleKeys: [input.key], reason: "role.create" });
  return getRole(pool, input.key);
}

export async function updateRole(pool, key, body, { actor, actorAccess }) {
  const current = await getRole(pool, key);
  if (!current) throw new RoleStoreError(404, "Role not found.");
  if (current.isSystem) throw new RoleStoreError(409, "System roles are read-only. Clone the role to customise it.");
  const input = validateRoleInput({ ...body, key: current.key }, { isNew: false, existing: current });
  assertDelegation(actorAccess, input.permissions, input.scopes);
  const userIds = await usersWithRole(pool, current.key);
  await withTransaction(pool, async (db) => {
    await db.query(
      `UPDATE cc_roles SET name = $2, description = $3, permissions = $4, scopes = $5::jsonb, updated_by = $6, updated_at = NOW() WHERE id = $1`,
      [current.key, input.name, input.description, input.permissions, JSON.stringify(input.scopes), actor ? String(actor.id) : null],
    );
    await writeAudit(db, {
      actorId: actor?.id, action: "role.update", targetType: "role", targetId: current.key,
      before: { name: current.name, permissions: current.permissions, scopes: current.scopes },
      after: { name: input.name, permissions: input.permissions, scopes: input.scopes },
    });
  });
  await publishAuthzChanged({ roleKeys: [current.key], userIds, reason: "role.update" });
  return getRole(pool, current.key);
}

export async function deleteRole(pool, key, { actor, removeFromUsers = false }) {
  const current = await getRole(pool, key);
  if (!current) throw new RoleStoreError(404, "Role not found.");
  if (current.isSystem) throw new RoleStoreError(409, "System roles cannot be deleted.");
  const userIds = await usersWithRole(pool, current.key);
  if (userIds.length && !removeFromUsers) {
    throw new RoleStoreError(409, `${current.name} is assigned to ${userIds.length} user${userIds.length === 1 ? "" : "s"}. Confirm removal to delete it.`, { usersCount: userIds.length });
  }
  if (userIds.length) {
    // A user left without any role would fall back to the agent defaults, so
    // removing the last role must not silently turn a revocation into a grant.
    const orphans = (await pool.query(`SELECT id, username FROM users WHERE $1 = ANY(roles) AND array_length(array_remove(roles, $1), 1) IS NULL`, [current.key])).rows || [];
    if (orphans.length) {
      const names = orphans.map((row) => row.username || row.id);
      throw new RoleStoreError(409, `${current.name} is the only role of ${orphans.length} user${orphans.length === 1 ? "" : "s"} (${names.join(", ")}). Assign another role to them first.`, { usersWithoutRole: names });
    }
  }
  await withTransaction(pool, async (db) => {
    if (userIds.length) await db.query(`UPDATE users SET roles = array_remove(roles, $1), updated_at = NOW() WHERE $1 = ANY(roles)`, [current.key]);
    await db.query(`DELETE FROM cc_roles WHERE id = $1`, [current.key]);
    if (current.origin === "preset") await rememberDeletedPreset(db, current.key);
    await writeAudit(db, { actorId: actor?.id, action: "role.delete", targetType: "role", targetId: current.key, before: { name: current.name, permissions: current.permissions, scopes: current.scopes, removedFromUsers: userIds.length } });
  });
  await publishAuthzChanged({ roleKeys: [current.key], userIds, reason: "role.delete" });
  return { removedFromUsers: userIds.length };
}

/**
 * Cascade for deleted objects (Phase 3a): drop the ids from every role scope
 * that lists them on `anchor` (queues, teams, campaigns), audit the change and
 * push `authz_changed` to the assignees. A list emptied this way keeps meaning
 * "nothing"; the editor asks the administrator to pick a new selection.
 * @returns {Promise<string[]>} keys of the roles that changed
 */
export async function removeScopeIds(pool, anchor, ids, { actor = null, reason = "object deleted" } = {}) {
  const targets = [...new Set((ids || []).map((id) => String(id)).filter(Boolean))];
  if (!pool || !targets.length || !SCOPE_ANCHORS.some((a) => a.id === anchor)) return [];
  const affected = (await pool.query(
    `SELECT id, name, scopes FROM cc_roles WHERE scopes->$1->>'mode' = 'list' AND (scopes->$1->'ids') ?| $2::text[]`,
    [anchor, targets],
  )).rows;
  if (!affected.length) return [];
  const changed = [];
  await withTransaction(pool, async (db) => {
    for (const row of affected) {
      const before = row.scopes || {};
      const entry = before[anchor] || {};
      const remaining = (entry.ids || []).map(String).filter((id) => !targets.includes(id));
      const after = { ...before, [anchor]: { ...entry, ids: remaining } };
      await db.query(`UPDATE cc_roles SET scopes = $2::jsonb, updated_at = NOW() WHERE id = $1`, [row.id, JSON.stringify(after)]);
      await writeAudit(db, { actorId: actor?.id, action: "role.scope.cascade", targetType: "role", targetId: row.id, before: { scopes: before }, after: { scopes: after, anchor, removed: targets, reason } });
      changed.push(row.id);
    }
  });
  const userIds = (await pool.query(`SELECT id FROM users WHERE roles && $1::text[]`, [changed])).rows.map((r) => String(r.id));
  await publishAuthzChanged({ roleKeys: changed, userIds, reason: "role.scope.cascade" });
  return changed;
}

/** A deleted preset must not come back on the next start (decision D-19). */
async function rememberDeletedPreset(db, key) {
  await db.query(
    `INSERT INTO app_settings (id, cc_settings) VALUES ('default', jsonb_build_object('seeded_role_presets', to_jsonb(ARRAY[$1::text])))
     ON CONFLICT (id) DO UPDATE SET cc_settings = jsonb_set(
       COALESCE(app_settings.cc_settings, '{}'::jsonb), '{seeded_role_presets}',
       (SELECT to_jsonb(ARRAY(SELECT DISTINCT v FROM jsonb_array_elements_text(COALESCE(app_settings.cc_settings->'seeded_role_presets', '[]'::jsonb) || to_jsonb(ARRAY[$1::text])) AS v))))`,
    [key],
  );
}

export async function cloneRole(pool, sourceKey, body, { actor, actorAccess }) {
  const source = await getRole(pool, sourceKey);
  if (!source) throw new RoleStoreError(404, "Role not found.");
  const name = String(body?.name || `${source.name} (copy)`).trim();
  const permissions = source.permissions.includes(WILDCARD)
    ? [...expandGrants(source.permissions).screens].map((s) => `screen:${s}`).concat([...expandGrants(source.permissions).operations])
    : source.permissions;
  return createRole(pool, { key: body?.key || slugify(name), name, description: body?.description ?? source.description, permissions, scopes: source.scopes }, { actor, actorAccess });
}

export async function restoreRole(pool, key, { actor, actorAccess }) {
  const current = await getRole(pool, key);
  if (!current) throw new RoleStoreError(404, "Role not found.");
  const preset = PRESET_BY_KEY.get(current.key);
  if (!preset || current.origin !== "preset") throw new RoleStoreError(409, "Only shipped roles can be restored.");
  // The shipped definition is a grant like any other: it must stay within the actor's own access.
  assertDelegation(actorAccess, preset.permissions, preset.scopes);
  const userIds = await usersWithRole(pool, current.key);
  await withTransaction(pool, async (db) => {
    await db.query(
      `UPDATE cc_roles SET name = $2, description = $3, permissions = $4, scopes = $5::jsonb, updated_by = $6, updated_at = NOW() WHERE id = $1`,
      [current.key, preset.name, preset.description, preset.permissions, JSON.stringify(preset.scopes), actor ? String(actor.id) : null],
    );
    await writeAudit(db, { actorId: actor?.id, action: "role.restore", targetType: "role", targetId: current.key, before: { name: current.name, permissions: current.permissions, scopes: current.scopes }, after: { name: preset.name, permissions: preset.permissions, scopes: preset.scopes } });
  });
  await publishAuthzChanged({ roleKeys: [current.key], userIds, reason: "role.restore" });
  return getRole(pool, current.key);
}

// ---------------------------------------------------------------- user assignment rules

/**
 * Validate a change of a user's role list.
 * Rules: every key must exist; only an owner grants or revokes owner; the
 * last owner cannot lose the role; the actor must hold everything the added
 * roles grant (delegation) — except the system role `agent`, the base role
 * every person needs, which anyone allowed to edit users may assign
 * (decision of 2026-09-16).
 * @returns {Promise<string[]>} normalised role keys
 */
export async function validateRoleAssignment(pool, { actor, actorAccess, targetUserId, currentRoles = [], nextRoles = [] }) {
  const next = [...new Set((Array.isArray(nextRoles) ? nextRoles : [nextRoles]).map((r) => String(r || "").trim().toLowerCase()).filter(Boolean))];
  const current = new Set((currentRoles || []).map((r) => String(r || "").toLowerCase()));
  if (!next.length) throw new RoleStoreError(422, "A user needs at least one role.");
  const defs = await pool.query(`SELECT id, permissions, scopes, is_system FROM cc_roles WHERE id = ANY($1::text[])`, [next]);
  const known = new Map((defs.rows || []).map((row) => [row.id, row]));
  const unknown = next.filter((k) => !known.has(k) && !SYSTEM_BY_KEY.has(k));
  if (unknown.length) throw new RoleStoreError(422, `Unknown roles: ${unknown.join(", ")}`);
  const added = next.filter((k) => !current.has(k));
  const removed = [...current].filter((k) => !next.includes(k));
  const actorIsOwner = Boolean(actorAccess?.wildcard);
  if ((added.includes("owner") || removed.includes("owner")) && !actorIsOwner) {
    throw new RoleStoreError(403, "Only an owner can grant or revoke the Owner role.");
  }
  if (removed.includes("owner")) {
    const owners = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE 'owner' = ANY(roles) AND id <> $1`, [String(targetUserId)]);
    if (Number(owners.rows?.[0]?.c || 0) === 0) throw new RoleStoreError(409, "The last owner cannot lose the Owner role.");
  }
  const delegated = added.filter((k) => k !== BASE_ROLE_KEY);
  if (delegated.length && !actorIsOwner) {
    const holderExpanded = { screens: actorAccess.screens, operations: actorAccess.operations, wildcard: actorAccess.wildcard };
    const holderScopes = holderScopesFor(actorAccess);
    // Role by role: each role's permissions against that role's own scope.
    // Testing the union of every role's permissions against each scope in
    // turn refused a legitimate pair such as a team-scoped monitor role next
    // to an unrestricted reader role, because monitor:read was then measured
    // as unrestricted on the reader role's pass.
    for (const k of delegated) {
      const row = known.get(k);
      const def = row ? { permissions: row.permissions || [], scopes: normalizeScopes(row.scopes || {}, { strict: false }).scopes } : SYSTEM_BY_KEY.get(k);
      const check = isSubsetOf(def?.permissions || [], def?.scopes, holderExpanded, holderScopes);
      if (!check.ok) throw new RoleStoreError(403, "You can assign only roles whose permissions and scopes you hold yourself.", [...check.missing, ...check.scopeIssues]);
    }
  }
  return next;
}

/** Persist a validated roles change with audit and push. Call inside the user update flow. */
export async function recordRoleAssignment(db, { actor, targetUserId, before, after }) {
  if (sameSet(before, after)) return false;
  await writeAudit(db, { actorId: actor?.id, action: "user.roles.update", targetType: "user", targetId: targetUserId, before: { roles: before }, after: { roles: after } });
  return true;
}

export { effectiveAccess };
