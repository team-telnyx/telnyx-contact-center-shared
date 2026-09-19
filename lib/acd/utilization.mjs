import { createHash } from "node:crypto";
import { CONFIGURABLE_CHANNELS, RELEASED_CHANNELS, defaultChannelPolicy, effectiveChannelPolicy, parseChannelPolicies } from "./channel-policy.mjs";
import { appendEvent } from "./events.mjs";
import { ensureAgentState } from "./agent-state.mjs";
import { NATIVE_LIFECYCLE_CHANNELS } from "./channel-registry.mjs";

const SCOPES = Object.freeze({
  agent: { table: "cc_agent_channel_policies", key: "agent_id", subject: "users" },
  queue: { table: "cc_queue_channels", key: "queue_id", subject: "cc_queues" },
});

function mappedPolicy(row, channel) {
  return row ? { channel, enabled: row.enabled, maxConcurrent: Number(row.max_concurrent), weight: Number(row.weight) } : defaultChannelPolicy(channel);
}

export async function readUtilization(db, scope, id) {
  const spec = SCOPES[scope];
  if (!spec) throw Object.assign(new Error("Invalid policy scope"), { status: 400 });
  const rows = (await db.query(`SELECT * FROM ${spec.table} WHERE ${spec.key}=$1`, [id])).rows;
  const policies = CONFIGURABLE_CHANNELS.map(channel => mappedPolicy(rows.find(row => row.channel === channel), channel));
  const budgetRow = scope === "agent"
    ? (await db.query("SELECT budget FROM cc_agent_utilization WHERE agent_id=$1", [id])).rows[0] : null;
  const budget = Number(budgetRow?.budget ?? 1);
  const revision = createHash("sha256").update(JSON.stringify({ policies, budget })).digest("hex");
  const occupancy = scope === "agent" ? (await db.query(`SELECT channel, COUNT(*)::int AS count, SUM(weight)::float AS weight
    FROM acd_reservations WHERE agent_id=$1 AND state <> 'released'
      AND (state='active' OR owner_saga_id IS NOT NULL OR lease_expires_at>now()) GROUP BY channel`, [id])).rows : [];
  return { scope, id, policies, budget, revision, occupancy, releasedChannels: RELEASED_CHANNELS };
}

// The caller holds the agent lock. Queue counts deliberately use the agent's
// GLOBAL channel occupancy; joining a second queue never multiplies capacity.
export async function readEffectiveChannelPolicy(db, { agentId, queueId, channel }) {
  const a = (await db.query("SELECT * FROM cc_agent_channel_policies WHERE agent_id=$1 AND channel=$2", [agentId, channel])).rows[0];
  const q = queueId ? (await db.query(`SELECT p.*, q.enabled AS queue_enabled FROM cc_queues q
    LEFT JOIN cc_queue_channels p ON p.queue_id=q.id AND p.channel=$2 WHERE q.id=$1`, [queueId, channel])).rows[0] : null;
  const agent = mappedPolicy(a, channel);
  const queue = mappedPolicy(q?.channel ? q : null, channel);
  const result = effectiveChannelPolicy(agent, queue);
  if (queueId) {
    const membership = await db.query(`SELECT 1 FROM cc_queue_user_assignments qa
      WHERE qa.queue_id=$1 AND qa.user_id=$2 AND qa.enabled=true
        AND qa.activated_at IS NOT NULL AND qa.deactivated_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM cc_agent_queue_channels n
          WHERE n.queue_id=qa.queue_id AND n.agent_id=qa.user_id AND n.channel=$3 AND n.enabled=false)`, [queueId, agentId, channel]);
    result.enabled = result.enabled && q?.queue_enabled === true && membership.rowCount > 0;
  } else if (channel !== "voice") {
    result.enabled = false;
  }
  return result;
}

export async function saveUtilizationInTransaction(tx, { scope, id, policies: input, budget = 1, expectedRevision, actor }) {
  const spec = SCOPES[scope];
  if (!spec) throw Object.assign(new Error("Invalid policy scope"), { status: 400 });
  const policies = parseChannelPolicies(input);
  if (!Number.isFinite(budget) || budget < 0.01 || budget > 1 || Math.abs(budget*100-Math.round(budget*100)) > 0.000001) {
    throw Object.assign(new Error("Budget must be between 1% and 100%"), { status: 400 });
  }
    await tx.query("SELECT pg_advisory_xact_lock(741901,5)");
    const subject = await tx.query(`SELECT id FROM ${spec.subject} WHERE id=$1 FOR UPDATE`, [id]);
    if (!subject.rowCount) throw Object.assign(new Error("Not found"), { status: 404 });
    const before = await readUtilization(tx, scope, id);
    if (expectedRevision !== before.revision) throw Object.assign(new Error("Settings changed; reload before saving"), { status: 409 });
    // Match the lifecycle lock order: work before agent. The routing advisory
    // lock prevents new offers while we capture the affected work items.
    await tx.query(`SELECT w.id FROM acd_work_items w WHERE w.channel = ANY($3::text[]) AND EXISTS
      (SELECT 1 FROM acd_offers o WHERE o.work_item_id=w.id AND o.state IN ('created','ringing')
        AND ($1='agent' AND o.agent_id=$2 OR $1='queue' AND w.queue_id=$2))
      ORDER BY w.id FOR UPDATE`, [scope,id,NATIVE_LIFECYCLE_CHANNELS]);
    if (scope === "agent") {
      await ensureAgentState(tx, id);
      await tx.query("SELECT agent_id FROM acd_agent_state WHERE agent_id=$1 FOR UPDATE", [id]);
      await tx.query(`INSERT INTO cc_agent_utilization(agent_id,budget) VALUES($1,$2)
        ON CONFLICT(agent_id) DO UPDATE SET budget=$2,version=cc_agent_utilization.version+1,updated_at=now()`, [id,budget]);
      await tx.query("UPDATE acd_agent_state SET capacity=$2 WHERE agent_id=$1", [id,budget]);
    }
    for (const p of policies) await tx.query(`INSERT INTO ${spec.table}(${spec.key},channel,enabled,max_concurrent,weight)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(${spec.key},channel) DO UPDATE SET enabled=$3,max_concurrent=$4,weight=$5,updated_at=now()`,
    [id,p.channel,p.enabled,p.maxConcurrent,p.weight]);
    const { revalidateTextOffers } = await import("./text-lifecycle.mjs");
    const cancelledOffers = await revalidateTextOffers(tx, { scope, id });
    await appendEvent(tx, { agentId: scope === "agent" ? id : null, actor,
      type: "channel_utilization_changed", payload: { scope, id, before: { policies: before.policies, budget: before.budget }, policies, budget, cancelledOffers } });
    return readUtilization(tx, scope, id);
}

export async function saveUtilization(pool, options) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const result = await saveUtilizationInTransaction(tx, options);
    await tx.query("COMMIT");
    return result;
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}

// One sheet save owns the entity, assignments, and utilization commit. Provider
// notifications are deferred until the database transaction has committed.
export async function saveAdminSettings(pool, { scope, id, utilization, actor, create = false }, write) {
  const tx = await pool.connect();
  const afterCommit = [];
  let result;
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(741901,5)");
    result = await write(tx, afterCommit);
    const subjectId = id || result.id;
    if (utilization !== undefined) {
      if (!utilization || typeof utilization !== "object") throw Object.assign(new Error("Invalid utilization settings"), { status: 400 });
      const expectedRevision = create ? (await readUtilization(tx, scope, subjectId)).revision : utilization.expectedRevision;
      await saveUtilizationInTransaction(tx, { ...utilization, expectedRevision, scope, id: subjectId, actor });
    }
    await tx.query("SELECT pg_notify('acd_work_ready', $1)", [String(subjectId)]);
    await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
  for (const notify of afterCommit) await notify().catch(() => undefined);
  return result;
}
