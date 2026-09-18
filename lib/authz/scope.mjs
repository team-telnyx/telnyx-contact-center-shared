/**
 * Data scoping — Phase 3a of the internal documentation
 * (decisions D-17, D-20, D-21, D-22; rules in the permission tree, section 4).
 *
 * A role limits the objects its grants reach through four anchors: queues,
 * teams, campaigns and channels. The guard resolves the caller's scope for the
 * permission that admitted the request and hands it to the handler as
 * `authz.scope`:
 *
 *   {
 *     restricted:   boolean          — false means "no narrowing at all"
 *     queueIds:     string[] | null  — queues in scope (null = every queue)
 *     teamIds:      string[] | null  — teams in scope (null = teams not narrowed)
 *     teamAgentIds: string[] | null  — agents of the teams in scope (null = teams not narrowed)
 *     agentIds:     string[] | null  — agents in scope: team members ∪ agents assigned to
 *                                      queues in scope ∪ the caller (null = every agent)
 *     campaignIds:  string[] | null  — campaigns in scope (null = every campaign)
 *     channels:     string[] | null  — channels in scope (null = every channel)
 *     selfId:       string           — the caller; self always stays in scope (rule 5)
 *   }
 *
 * Membership anchors (queues, teams) combine with OR, channels with AND
 * (D-21): an interaction is in scope when one of its segment queues is in
 * scope or one of its agents belongs to a team in scope or is the caller. An
 * anchor left at `all` is neutral and takes no part in the OR; a dynamic
 * `own` anchor that resolves to nothing is inactive in the same way (rule 2a).
 * When every narrowed membership anchor is inactive the caller sees their own
 * data only.
 */
import { scopeFor } from "./effective.mjs";
import { SCOPE_ANCHORS } from "./permissions.mjs";

export const UNRESTRICTED = Object.freeze({
  restricted: false,
  queueIds: null,
  teamIds: null,
  teamAgentIds: null,
  agentIds: null,
  campaignIds: null,
  channels: null,
  selfId: null,
});

const uniq = (values) => [...new Set((values || []).map((v) => String(v)).filter(Boolean))];

export function isRestricted(scope) {
  return Boolean(scope?.restricted);
}

/** Queue ids the user is assigned to (`own` for the queues anchor). */
export async function ownQueueIds(pool, user) {
  if (!pool || !user?.id) return [];
  const result = await pool.query(
    "SELECT queue_id FROM cc_queue_user_assignments WHERE user_id = $1 AND enabled = true",
    [String(user.id)],
  );
  return uniq(result.rows.map((row) => row.queue_id));
}

/** Team ids the user belongs to (`own` for the teams anchor). */
export async function ownTeamIds(pool, user) {
  if (!user?.id) return [];
  if (Array.isArray(user.agent_groups)) return uniq(user.agent_groups);
  if (!pool) return [];
  const result = await pool.query("SELECT agent_groups FROM users WHERE id = $1", [String(user.id)]);
  return uniq(result.rows[0]?.agent_groups);
}

/** Campaign ids the user is assigned to (`own` for the campaigns anchor). */
export async function ownCampaignIds(pool, user) {
  if (!pool || !user?.username) return [];
  const present = (await pool.query("SELECT to_regclass('public.outbound_campaign_agent_assignments') AS present")).rows[0]?.present;
  if (!present) return [];
  const result = await pool.query(
    "SELECT campaign_id FROM outbound_campaign_agent_assignments WHERE agent_username = $1 AND enabled = true",
    [String(user.username)],
  );
  return uniq(result.rows.map((row) => row.campaign_id));
}

/** Agents that belong to any of the given teams. */
export async function teamAgentIds(pool, teamIds) {
  const ids = uniq(teamIds);
  if (!pool || !ids.length) return [];
  const result = await pool.query("SELECT id FROM users WHERE agent_groups && $1::text[]", [ids]);
  return uniq(result.rows.map((row) => row.id));
}

/** Agents assigned to any of the given queues (rule 4). */
export async function queueAgentIds(pool, queueIds) {
  const ids = uniq(queueIds);
  if (!pool || !ids.length) return [];
  const result = await pool.query(
    "SELECT DISTINCT user_id FROM cc_queue_user_assignments WHERE queue_id = ANY($1::text[]) AND enabled = true",
    [ids],
  );
  return uniq(result.rows.map((row) => row.user_id));
}

async function resolveAnchor(anchor, pool, user, ownResolver) {
  if (!anchor || anchor.mode === "all") return null;
  let ids = anchor.mode === "list" ? uniq(anchor.ids) : [];
  if (anchor.mode === "own" || anchor.own) ids = uniq([...ids, ...(await ownResolver(pool, user))]);
  return ids;
}

/**
 * Resolve the scope of one grant for a user.
 * @param {import("pg").Pool|null} pool
 * @param {object} user       the caller (id, username, agent_groups)
 * @param {object} grant      normalised scopes as returned by `scopeFor()`; null/undefined → unrestricted
 */
export async function resolveGrantScope(pool, user, grant) {
  if (!grant) return UNRESTRICTED;
  if (grant.grants) {
    let scope = null;
    for (const clause of grant.grants) scope = mergeScopes(scope, await resolveGrantScope(pool, user, clause));
    return scope || UNRESTRICTED;
  }
  const anchors = Object.fromEntries(SCOPE_ANCHORS.map((a) => [a.id, grant[a.id] || { mode: "all" }]));
  if (SCOPE_ANCHORS.every((a) => anchors[a.id].mode === "all")) return UNRESTRICTED;
  const selfId = user?.id != null ? String(user.id) : null;
  const channels = anchors.channels.mode === "list" ? uniq(anchors.channels.ids) : null;
  const campaignIds = await resolveAnchor(anchors.campaigns, pool, user, ownCampaignIds);
  const queueIds = await resolveAnchor(anchors.queues, pool, user, ownQueueIds);
  const teamIds = await resolveAnchor(anchors.teams, pool, user, ownTeamIds);
  const teamAgents = teamIds ? await teamAgentIds(pool, teamIds) : null;
  let agentIds = null;
  if (queueIds || teamAgents) {
    agentIds = uniq([...(teamAgents || []), ...(queueIds?.length ? await queueAgentIds(pool, queueIds) : []), selfId]);
  }
  return {
    restricted: true,
    queueIds,
    teamIds,
    teamAgentIds: teamAgents,
    agentIds,
    campaignIds,
    channels,
    selfId,
  };
}

/**
 * Resolve the scope for a permission from the user's effective access (D-22:
 * the union of the scopes of the roles that grant it).
 */
export async function resolveScope(pool, user, access, permission) {
  if (!access || access.wildcard) return UNRESTRICTED;
  return resolveGrantScope(pool, user, scopeFor(access, permission));
}

const unionAxis = (a, b) => (a == null || b == null ? null : uniq([...a, ...b]));

/** Union of complete scopes, with projections for single-axis lookups. */
export function mergeScopes(a, b) {
  if (!a || !a.restricted) return a || b || UNRESTRICTED;
  if (!b || !b.restricted) return b || a;
  const merged = {
    restricted: true,
    queueIds: unionAxis(a.queueIds, b.queueIds),
    teamIds: unionAxis(a.teamIds, b.teamIds),
    teamAgentIds: unionAxis(a.teamAgentIds, b.teamAgentIds),
    agentIds: unionAxis(a.agentIds, b.agentIds),
    campaignIds: unionAxis(a.campaignIds, b.campaignIds),
    channels: unionAxis(a.channels, b.channels),
    selfId: a.selfId || b.selfId || null,
  };
  // Projections serve single-axis lookups only. Compound checks must OR whole grants.
  merged.clauses = [...(a.clauses || [a]), ...(b.clauses || [b])];
  return merged;
}

/** A scope that admits only the caller's own data (used when a route is entered through `agent:self`). */
export function selfOnlyScope(user) {
  const selfId = user?.id != null ? String(user.id) : null;
  return { restricted: true, queueIds: [], teamIds: [], teamAgentIds: [], agentIds: selfId ? [selfId] : [], campaignIds: [], channels: null, selfId };
}

/** Resolve and union the scopes of several permissions (the keys that admitted a request). */
export async function resolveScopeForKeys(pool, user, access, keys = []) {
  let scope = null;
  for (const key of keys) {
    scope = mergeScopes(scope, await resolveScope(pool, user, access, key));
    if (!scope.restricted) return UNRESTRICTED;
  }
  return scope || UNRESTRICTED;
}

// ------------------------------------------------------------- predicates

export function queueInScope(scope, queueId) {
  if (!scope?.restricted || scope.queueIds == null) return true;
  return queueId != null && scope.queueIds.includes(String(queueId));
}

export function teamInScope(scope, teamId) {
  if (!scope?.restricted || scope.teamIds == null) return true;
  return teamId != null && scope.teamIds.includes(String(teamId));
}

export function agentInScope(scope, agentId) {
  if (!scope?.restricted || scope.agentIds == null) return true;
  if (agentId == null) return false;
  const id = String(agentId);
  return id === scope.selfId || scope.agentIds.includes(id);
}

export function campaignInScope(scope, campaignId) {
  if (!scope?.restricted || scope.campaignIds == null) return true;
  return campaignId != null && scope.campaignIds.includes(String(campaignId));
}

export function channelInScope(scope, channel) {
  if (!scope?.restricted || scope.channels == null) return true;
  return channel != null && scope.channels.includes(String(channel));
}

/** Is a membership axis (queues or teams) narrowed at all? */
export function membershipRestricted(scope) {
  return Boolean(scope?.restricted) && (scope.queueIds != null || scope.teamAgentIds != null);
}

/**
 * Interaction predicate (rules 2, 3 and 5): any segment queue in scope, or
 * any agent in a team in scope, or the caller among the agents; channel AND.
 * @param {{ queueIds?: string[], agentIds?: string[], channel?: string }} interaction
 */
export function interactionInScope(scope, interaction = {}) {
  if (!scope?.restricted) return true;
  if (scope.clauses) return scope.clauses.some((clause) => interactionInScope(clause, interaction));
  if (!channelInScope(scope, interaction.channel)) return false;
  if (!membershipRestricted(scope)) return true;
  const queues = uniq(interaction.queueIds);
  const agents = uniq(interaction.agentIds);
  if (scope.queueIds != null && queues.some((id) => scope.queueIds.includes(id))) return true;
  if (scope.selfId && agents.includes(scope.selfId)) return true;
  if (scope.teamAgentIds != null && agents.some((id) => scope.teamAgentIds.includes(id))) return true;
  return false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Does the scope, or any of its per-role clauses, narrow the channel axis? */
function channelRestricted(scope) {
  return Boolean(scope?.restricted) && (scope.channels != null || (scope.clauses || []).some((clause) => clause.channels != null));
}

/**
 * Load the segment queues and agents of a work item and apply `interactionInScope`.
 * Callers that know only the work item id (conversation, attachment and
 * transcription routes) leave the channel out; a scope with a channel list
 * would then refuse every interaction, so the channel is read from the work
 * item before the channel predicate runs. An explicit channel is trusted.
 */
export async function workItemInScope(pool, scope, workItemId, { queueId = null, agentId = null, channel = null } = {}) {
  if (!scope?.restricted) return true;
  // The id column is a UUID: a malformed route parameter would make PostgreSQL
  // raise a conversion error (a 500) instead of returning no row, so anything
  // that is not a UUID has no channel and is refused by a channel-list scope.
  const resolvedChannel = channel != null || !channelRestricted(scope) || !pool || !UUID.test(String(workItemId || ""))
    ? channel
    : (await pool.query("SELECT channel FROM acd_work_items WHERE id = $1", [String(workItemId)])).rows[0]?.channel ?? null;
  if (!channelInScope(scope, resolvedChannel)) return false;
  if (!scope.clauses && !membershipRestricted(scope)) return true;
  const segments = workItemId && pool
    ? (await pool.query("SELECT queue_id, agent_id FROM acd_segments WHERE work_item_id = $1", [String(workItemId)])).rows
    : [];
  return interactionInScope(scope, {
    channel: resolvedChannel,
    queueIds: [queueId, ...segments.map((s) => s.queue_id)],
    agentIds: [agentId, ...segments.map((s) => s.agent_id)],
  });
}

// ------------------------------------------------------------- SQL helpers
// Every helper appends its values to `params` and returns SQL conditions
// (without a leading AND) so callers can splice them into an existing WHERE.
// Pass `params = null` to inline the id lists as literals instead — for
// queries whose parameter positions are fixed (`$1..$5` reports).

function agentIdsForInteractions(scope) {
  return uniq([...(scope.teamAgentIds || []), scope.selfId]);
}

/** A `text[]` literal; ids with quotes are escaped, backslashes and control characters are refused. */
export function sqlTextArray(ids) {
  const safe = uniq(ids).filter((id) => !/[\\\x00-\x1f]/.test(id));
  return `ARRAY[${safe.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")}]::text[]`;
}

function arrayRef(ids, params) {
  if (params) {
    params.push(ids);
    return `$${params.length}::text[]`;
  }
  return sqlTextArray(ids);
}

/**
 * Conditions narrowing interaction rows.
 * @param {object} scope
 * @param {{ queue?: string, agent?: string, channel?: string, workItem?: string }} columns
 *        SQL expressions: the row's queue id, agent id and channel, and the work
 *        item id used to look at every segment (rule 3). Any may be omitted.
 * @param {any[]} params
 * @returns {string[]}
 */
export function interactionScopeSql(scope, columns = {}, params = []) {
  const conditions = [];
  if (!scope?.restricted) return conditions;
  if (scope.clauses) {
    const alternatives = scope.clauses.map((clause) => {
      const parts = interactionScopeSql(clause, columns, params);
      return parts.length ? `(${parts.join(" AND ")})` : "TRUE";
    });
    return [`(${alternatives.join(" OR ")})`];
  }
  if (scope.channels != null && columns.channel) {
    conditions.push(`${columns.channel} = ANY(${arrayRef(scope.channels, params)})`);
  }
  if (!membershipRestricted(scope)) return conditions;
  const parts = [];
  if (scope.queueIds != null && scope.queueIds.length && (columns.queue || columns.workItem)) {
    const ref = arrayRef(scope.queueIds, params);
    const alternatives = [];
    if (columns.queue) alternatives.push(`${columns.queue} = ANY(${ref})`);
    if (columns.workItem) alternatives.push(`EXISTS(SELECT 1 FROM acd_segments sc_q WHERE sc_q.work_item_id = ${columns.workItem} AND sc_q.queue_id = ANY(${ref}))`);
    parts.push(alternatives.join(" OR "));
  }
  const agents = agentIdsForInteractions(scope);
  if (agents.length && (columns.agent || columns.workItem)) {
    const ref = arrayRef(agents, params);
    const alternatives = [];
    if (columns.agent) alternatives.push(`${columns.agent} = ANY(${ref})`);
    if (columns.workItem) alternatives.push(`EXISTS(SELECT 1 FROM acd_segments sc_a WHERE sc_a.work_item_id = ${columns.workItem} AND sc_a.agent_id = ANY(${ref}))`);
    parts.push(alternatives.join(" OR "));
  }
  conditions.push(parts.length ? `(${parts.join(" OR ")})` : "FALSE");
  return conditions;
}

/** Conditions narrowing queue rows (`queueColumn` = the queue id expression). */
export function queueScopeSql(scope, queueColumn, params = []) {
  if (!scope?.restricted || scope.queueIds == null) return [];
  return [`${queueColumn} = ANY(${arrayRef(scope.queueIds, params)})`];
}

/** Conditions narrowing team rows (`teamColumn` = the team id expression). */
export function teamScopeSql(scope, teamColumn, params = []) {
  if (!scope?.restricted || scope.teamIds == null) return [];
  return [`${teamColumn} = ANY(${arrayRef(scope.teamIds, params)})`];
}

/** Conditions narrowing agent/user rows (`agentColumn` = the user id expression). */
export function agentScopeSql(scope, agentColumn, params = []) {
  if (!scope?.restricted || scope.agentIds == null) return [];
  return [`${agentColumn} = ANY(${arrayRef(uniq([...scope.agentIds, scope.selfId]), params)})`];
}

/** Conditions narrowing campaign rows (`campaignColumn` = the campaign id expression). */
export function campaignScopeSql(scope, campaignColumn, params = []) {
  if (!scope?.restricted || scope.campaignIds == null) return [];
  return [`${campaignColumn} = ANY(${arrayRef(scope.campaignIds, params)})`];
}

/** Conditions narrowing rows by channel (`channelColumn` = the channel expression). */
export function channelScopeSql(scope, channelColumn, params = []) {
  if (!scope?.restricted || scope.channels == null) return [];
  return [`${channelColumn} = ANY(${arrayRef(scope.channels, params)})`];
}

/** Channels a report may cover: the requested channel (or every released one) intersected with the scope. */
export function scopedChannels(scope, channel, released = []) {
  const requested = channel ? [String(channel)] : released.map(String);
  if (!scope?.restricted || scope.channels == null) return requested;
  return requested.filter((id) => scope.channels.includes(id));
}

/** Usernames of the agents in scope (reports keyed by username); null when agents are not narrowed. */
export async function agentUsernamesInScope(pool, scope) {
  if (!scope?.restricted || scope.agentIds == null) return null;
  const ids = uniq([...scope.agentIds, scope.selfId]);
  if (!pool || !ids.length) return [];
  const result = await pool.query("SELECT username FROM users WHERE id = ANY($1::text[])", [ids]);
  return uniq(result.rows.map((row) => row.username));
}

/**
 * Locate the interaction that owns a recording (by Telnyx recording id or by
 * recording URL) and tell whether it is in scope. Unknown recordings are out
 * of scope for a restricted caller.
 */
export async function recordingInScope(pool, scope, { recordingId = null, recordingUrl = null } = {}) {
  if (!scope?.restricted) return true;
  if (!pool || (!recordingId && !recordingUrl)) return false;
  const result = await pool.query(
    `SELECT work_item_id, queue_id, agent_id, interaction_type FROM acd_history_interactions
      WHERE ($1::text IS NOT NULL AND (metadata->'recording'->>'recording_id' = $1 OR recording_url LIKE '%' || $1 || '%'))
         OR ($2::text IS NOT NULL AND recording_url = $2)
      LIMIT 1`,
    [recordingId ? String(recordingId) : null, recordingUrl ? String(recordingUrl) : null],
  );
  const row = result.rows[0];
  if (!row) return false;
  return workItemInScope(pool, scope, row.work_item_id, { queueId: row.queue_id, agentId: row.agent_id, channel: row.interaction_type });
}

// ------------------------------------------------------------- snapshots

const sum = (rows, pick) => rows.reduce((total, row) => total + Number(pick(row) || 0), 0);

function combineSla(queues) {
  const keys = ["met", "breached", "unserved", "pending", "excluded", "not_configured", "disabled", "unavailable", "atRisk"];
  const totals = Object.fromEntries(keys.map((key) => [key, sum(queues, (q) => q.sla?.[key])]));
  const denominator = totals.met + totals.breached + totals.unserved;
  const configured = queues.filter((q) => q.sla?.target != null && (q.sla.denominator || 0) > 0);
  const weight = sum(configured, (q) => q.sla.target * q.sla.denominator);
  const weightBase = sum(configured, (q) => q.sla.denominator);
  return {
    ...totals,
    denominator,
    rate: denominator ? (100 * totals.met) / denominator : null,
    target: weightBase ? weight / weightBase : null,
    unit: "measurements",
    cohort: "started",
  };
}

/**
 * Narrow a monitor snapshot ({ queues, agents, overall }) to the scope and
 * recompute the overall figures from what remains.
 */
export function restrictMonitorSnapshot(snapshot, scope, { prefiltered = false } = {}) {
  if (!snapshot || !scope?.restricted) return snapshot;
  const queues = (snapshot.queues || []).filter((q) => queueInScope(scope, q.queueId));
  const agents = (snapshot.agents || []).filter((a) => agentInScope(scope, a.userId));
  const overall = snapshot.overall ? { ...snapshot.overall } : null;
  if (overall) {
    if (scope.queueIds != null && !prefiltered) {
      overall.calls = {
        total: sum(queues, (q) => q.today?.totalCalls),
        answered: sum(queues, (q) => q.today?.answeredCalls),
        abandoned: sum(queues, (q) => q.today?.abandonedCalls),
        failed: sum(queues, (q) => q.today?.failedInteractions),
        active: sum(queues, (q) => q.realtime?.activeCalls),
      };
      overall.queues = {
        total: queues.length,
        active: queues.length,
        totalWaitingCalls: sum(queues, (q) => q.realtime?.waitingCalls),
      };
      overall.sla = combineSla(queues);
    }
    if (scope.agentIds != null && !prefiltered) {
      overall.agents = {
        available: agents.filter((a) => a.isAvailableForRouting).length,
        busy: agents.filter((a) => a.usedCapacity > 0).length,
        totalActive: agents.filter((a) => a.status !== "Offline").length,
        total: agents.length,
      };
    }
    overall.scoped = true;
  }
  return { ...snapshot, queues, agents, overall };
}

/** Serialisable form for clients and logs. */
export function describeScope(scope) {
  if (!scope?.restricted) return { restricted: false };
  return {
    restricted: true,
    queues: scope.queueIds,
    agents: scope.agentIds,
    campaigns: scope.campaignIds,
    channels: scope.channels,
  };
}
