/**
 * Teams (`agent_groups`) and their membership (`users.agent_groups`).
 *
 * Phase 3a of the internal documentation: the teams scope
 * anchor resolves through these tables, so the Teams screen is the place where
 * membership is managed. Every change is audited in `cc_authz_audit` and pushed
 * as `authz_changed` to the members concerned.
 */
import { publishAuthzChanged } from "../authz/effective.mjs";
import { removeScopeIds, writeAudit } from "../authz/roles-store.mjs";

export class TeamStoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const NAME_MAX = 120;
const DESCRIPTION_MAX = 1000;

export function toTeamView(row, { membersCount = null, members = null } = {}) {
  if (!row) return null;
  const view = {
    id: row.id,
    name: row.name,
    description: row.description || "",
    isActive: row.is_active !== false,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
  if (membersCount != null) view.membersCount = Number(membersCount);
  if (members) view.members = members;
  return view;
}

function normalizeMemberIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TeamStoreError(400, "memberIds must be an array of user ids.");
  return [...new Set(value.map((id) => String(id).trim()).filter(Boolean))];
}

function validate(body = {}, { isNew = false } = {}) {
  const out = {};
  if (body.name !== undefined || isNew) {
    const name = String(body.name ?? "").trim();
    if (!name) throw new TeamStoreError(400, "Name is required.");
    if (name.length > NAME_MAX) throw new TeamStoreError(400, `Name must be at most ${NAME_MAX} characters.`);
    out.name = name;
  }
  if (body.description !== undefined) {
    const description = body.description == null ? "" : String(body.description).trim();
    if (description.length > DESCRIPTION_MAX) throw new TeamStoreError(400, `Description must be at most ${DESCRIPTION_MAX} characters.`);
    out.description = description || null;
  }
  if (body.isActive !== undefined) out.isActive = Boolean(body.isActive);
  const memberIds = normalizeMemberIds(body.memberIds);
  if (memberIds !== undefined) out.memberIds = memberIds;
  return out;
}

export async function listTeams(pool, { page = 1, pageSize = 20, q = "", active = "all", teamIds = null } = {}) {
  const currentPage = Math.max(1, Math.floor(Number(page) || 1));
  const size = Math.min(1000, Math.max(1, Math.floor(Number(pageSize) || 20)));
  const where = [];
  const vals = [];
  if (q && String(q).trim()) {
    vals.push(`%${String(q).trim()}%`);
    where.push(`(g.name ILIKE $${vals.length} OR g.description ILIKE $${vals.length})`);
  }
  if (active === "true" || active === "false") {
    vals.push(active === "true");
    where.push(`g.is_active = $${vals.length}`);
  }
  if (Array.isArray(teamIds)) {
    // The caller's teams scope (RBAC review fix): only the listed teams are visible.
    vals.push(teamIds.map(String));
    where.push(`g.id = ANY($${vals.length}::text[])`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number((await pool.query(`SELECT COUNT(*)::int AS total FROM agent_groups g ${whereSql}`, vals)).rows[0]?.total || 0);
  const rows = (await pool.query(
    `SELECT g.*, (SELECT COUNT(*)::int FROM users u WHERE g.id = ANY(u.agent_groups)) AS members_count
       FROM agent_groups g ${whereSql}
      ORDER BY g.name ASC
      LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
    [...vals, size, (currentPage - 1) * size],
  )).rows;
  return { items: rows.map((row) => toTeamView(row, { membersCount: row.members_count })), total, page: currentPage, pageSize: size };
}

export async function teamMembers(pool, id) {
  const rows = (await pool.query(
    `SELECT id, username, first_name, last_name, roles, active FROM users WHERE $1 = ANY(agent_groups) ORDER BY last_name NULLS LAST, first_name NULLS LAST, username`,
    [String(id)],
  )).rows;
  return rows.map((row) => ({ id: row.id, username: row.username, firstName: row.first_name, lastName: row.last_name, roles: row.roles || [], active: row.active !== false }));
}

export async function getTeam(pool, id) {
  const row = (await pool.query("SELECT * FROM agent_groups WHERE id = $1", [String(id)])).rows[0];
  if (!row) return null;
  const members = await teamMembers(pool, row.id);
  return toTeamView(row, { membersCount: members.length, members });
}

/** Replace the member list of a team; returns the user ids whose membership changed. */
export async function setTeamMembers(db, teamId, memberIds) {
  const id = String(teamId);
  const wanted = [...new Set((memberIds || []).map(String))];
  const current = (await db.query("SELECT id FROM users WHERE $1 = ANY(agent_groups)", [id])).rows.map((r) => String(r.id));
  const removed = current.filter((userId) => !wanted.includes(userId));
  const added = wanted.filter((userId) => !current.includes(userId));
  if (added.length) {
    const known = (await db.query("SELECT id FROM users WHERE id = ANY($1::text[])", [added])).rows.map((r) => String(r.id));
    const unknown = added.filter((userId) => !known.includes(userId));
    if (unknown.length) throw new TeamStoreError(422, `Unknown user${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  if (removed.length) await db.query("UPDATE users SET agent_groups = array_remove(agent_groups, $1), updated_at = NOW() WHERE id = ANY($2::text[])", [id, removed]);
  if (added.length) await db.query("UPDATE users SET agent_groups = array_append(COALESCE(agent_groups, '{}'), $1), updated_at = NOW() WHERE id = ANY($2::text[]) AND NOT ($1 = ANY(COALESCE(agent_groups, '{}')))", [id, added]);
  return { added, removed };
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function uniqueViolation(err) {
  return err?.code === "23505";
}

export async function createTeam(pool, body, { actor = null } = {}) {
  const input = validate(body, { isNew: true });
  const id = String(body.id || "").trim();
  if (!id) throw new TeamStoreError(400, "Team id is required.");
  let membership = { added: [], removed: [] };
  try {
    await withTransaction(pool, async (db) => {
      await db.query(
        "INSERT INTO agent_groups (id, name, description, is_active, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())",
        [id, input.name, input.description ?? null, input.isActive ?? true],
      );
      if (input.memberIds) membership = await setTeamMembers(db, id, input.memberIds);
      await writeAudit(db, { actorId: actor?.id, action: "team.create", targetType: "team", targetId: id, after: { name: input.name, members: input.memberIds || [] } });
    });
  } catch (err) {
    if (uniqueViolation(err)) throw new TeamStoreError(409, "A team with this name already exists.");
    throw err;
  }
  if (membership.added.length) await publishAuthzChanged({ userIds: membership.added, reason: "team.members" });
  return getTeam(pool, id);
}

export async function updateTeam(pool, id, body, { actor = null } = {}) {
  const current = (await pool.query("SELECT * FROM agent_groups WHERE id = $1", [String(id)])).rows[0];
  if (!current) throw new TeamStoreError(404, "Team not found.");
  const input = validate(body);
  let membership = { added: [], removed: [] };
  try {
    await withTransaction(pool, async (db) => {
      await db.query(
        "UPDATE agent_groups SET name = $2, description = $3, is_active = $4, updated_at = NOW() WHERE id = $1",
        [current.id, input.name ?? current.name, input.description !== undefined ? input.description : current.description, input.isActive ?? current.is_active !== false],
      );
      if (input.memberIds) membership = await setTeamMembers(db, current.id, input.memberIds);
      await writeAudit(db, {
        actorId: actor?.id, action: "team.update", targetType: "team", targetId: current.id,
        before: { name: current.name, description: current.description, isActive: current.is_active },
        after: { name: input.name ?? current.name, description: input.description !== undefined ? input.description : current.description, isActive: input.isActive ?? current.is_active, membersAdded: membership.added, membersRemoved: membership.removed },
      });
    });
  } catch (err) {
    if (uniqueViolation(err)) throw new TeamStoreError(409, "A team with this name already exists.");
    throw err;
  }
  const touched = [...membership.added, ...membership.removed];
  if (touched.length) await publishAuthzChanged({ userIds: touched, reason: "team.members" });
  return getTeam(pool, id);
}

export async function deleteTeam(pool, id, { actor = null } = {}) {
  const current = (await pool.query("SELECT * FROM agent_groups WHERE id = $1", [String(id)])).rows[0];
  if (!current) throw new TeamStoreError(404, "Team not found.");
  const members = (await pool.query("SELECT id FROM users WHERE $1 = ANY(agent_groups)", [current.id])).rows.map((r) => String(r.id));
  await withTransaction(pool, async (db) => {
    if (members.length) await db.query("UPDATE users SET agent_groups = array_remove(agent_groups, $1), updated_at = NOW() WHERE $1 = ANY(agent_groups)", [current.id]);
    await db.query("DELETE FROM agent_groups WHERE id = $1", [current.id]);
    await writeAudit(db, { actorId: actor?.id, action: "team.delete", targetType: "team", targetId: current.id, before: { name: current.name, members } });
  });
  // The team leaves every role scope that listed it (Phase 3a cascade).
  const roles = await removeScopeIds(pool, "teams", [current.id], { actor, reason: "team deleted" });
  if (members.length) await publishAuthzChanged({ userIds: members, reason: "team.delete" });
  return { removedFromUsers: members.length, rolesUpdated: roles.length };
}
