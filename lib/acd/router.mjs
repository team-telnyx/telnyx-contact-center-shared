// ACD router (the internal documentation §5.2).
// Selection and arbitration live in the SAME transaction over the SAME tables,
// so they can never disagree. Queue membership and routing policy come from
// the persistent configuration tables; runtime truth comes from acd_*.

import { outboundBlendingBudget } from "./outbound-blending.mjs";
import { appendEvent } from "./events.mjs";
import { applyTransition } from "./lifecycle.mjs";
import { tryOfferAndReserve } from "./reservations.mjs";
import { channelProfile } from "./channels.mjs";
import { resolvePolicy } from "./policies/index.mjs";
import { createHash } from 'node:crypto';
import { loadAgentLifecycleSettings } from "./agent-lifecycle-settings.mjs";
import { RELEASED_CHANNELS } from "./channel-policy.mjs";
import { usesNativeLifecycle } from "./channel-registry.mjs";
import { readEffectiveChannelPolicy } from "./utilization.mjs";

export const MAX_RESERVE_ATTEMPTS = 5;
const DEFAULT_ANSWER_TIMEOUT_SECS = 30;
const OFFER_GRACE_MS = 10_000;

/**
 * Candidates for a queue: persistent configuration plus Core runtime truth.
 * live_weight/has_live_voice are computed from acd_reservations in this same
 * query — no cache, no second source.
 */
export async function candidatesForQueue(db, queueId, channel = "voice") {
  const result = await db.query(
    `SELECT
        u.id            AS agent_id,
        u.skills        AS skills,
        qa.priority     AS queue_priority,
        ast.capacity    AS capacity,
        ast.routability,
        ast.manual_status,
        ast.workflow_state,
        occ.live_weight,
        occ.has_live_voice,
        occ.channel_count,
        occ.last_released_at
      FROM cc_queue_user_assignments qa
      JOIN users u ON u.id = qa.user_id
      JOIN acd_agent_state ast ON ast.agent_id = u.id
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(r.weight) FILTER (
            WHERE r.state <> 'released'
              AND (r.state = 'active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at > now())
          ), 0) AS live_weight,
          bool_or(r.channel = 'voice' AND r.state <> 'released'
              AND (r.state = 'active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at > now())) AS has_live_voice,
          MAX(r.released_at) AS last_released_at
          ,COUNT(*) FILTER (WHERE r.channel=$2 AND r.state <> 'released'
            AND (r.state='active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at>now()))::int AS channel_count
        FROM acd_reservations r
        WHERE r.agent_id = u.id
      ) occ ON true
      WHERE qa.queue_id = $1
        AND qa.enabled = true
        AND qa.activated_at IS NOT NULL
        AND qa.deactivated_at IS NULL
        AND ast.presence = 'online'
        AND EXISTS (
          SELECT 1 FROM acd_agent_sessions session
           WHERE session.agent_id = ast.agent_id
             AND session.state = 'online'
             AND session.expires_at > now()
             AND session.capabilities->>$2 = 'true'
        )`,
    [queueId, channel],
  );
  for (const candidate of result.rows) {
    candidate.channel_policy = await readEffectiveChannelPolicy(db, { agentId: candidate.agent_id, queueId, channel });
  }
  return result.rows;
}

export function filterByCapacity(candidates, profile) {
  return candidates.filter((candidate) => {
    if (candidate.channel_policy?.enabled === false) return false;
    if (profile.exclusive ? candidate.routability !== "routable" : candidate.manual_status !== "Available") return false;
    if (candidate.channel_count >= (candidate.channel_policy?.maxConcurrent ?? profile.maxParallel ?? 1)) return false;
    if (profile.exclusive) {
      return (
        candidate.workflow_state === "idle" &&
        Number(candidate.live_weight) === 0 &&
        !candidate.has_live_voice
      );
    }
    if (candidate.has_live_voice) return false;
    if (!["idle", "offered", "handling"].includes(candidate.workflow_state)) return false;
    return Number(candidate.live_weight) + (candidate.channel_policy?.weight ?? profile.weight) <= Math.min(Number(candidate.capacity), 1) + 0.00001;
  });
}

async function filterOutboundBlending(db, candidates, work) {
  const campaignId=work.direction==='outbound' && work.attributes?.outbound_campaign_id;
  if(!campaignId)return candidates;
  const campaign=(await db.query('SELECT * FROM outbound_campaigns WHERE id=$1',[campaignId])).rows[0];
  if(!campaign || !['power','predictive'].includes(campaign.mode))return candidates;
  const budget=await outboundBlendingBudget(db,campaign);
  if(budget.free<1)return [];
  return candidates.filter(c=>!budget.protectedAgentIds.includes(c.agent_id));
}

function rejectionReason(candidate, profile) {
  if (candidate.channel_policy?.enabled === false) return "channel_disabled";
  if (candidate.channel_count >= (candidate.channel_policy?.maxConcurrent ?? profile.maxParallel ?? 1)) return "channel_limit_reached";
  if (candidate.workflow_state === "wrapup") return "agent_in_wrapup";
  if (candidate.workflow_state === "offered") return "agent_already_offered";
  if (candidate.workflow_state === "handling" && profile.exclusive) return "agent_handling_call";
  if (candidate.routability !== "routable") return "agent_not_routable";
  if (candidate.has_live_voice || Number(candidate.live_weight) > 0) return "no_free_capacity";
  if (profile.exclusive && candidate.workflow_state !== "idle") return "agent_not_idle";
  if (
    !profile.exclusive &&
    !["idle", "handling"].includes(candidate.workflow_state)
  ) {
    return "agent_not_idle";
  }
  if (Number(candidate.live_weight) + profile.weight > Number(candidate.capacity)) {
    return "no_free_capacity";
  }
  return "not_eligible";
}

function summarizeRejections(candidates, profile) {
  const counts = {};
  for (const candidate of candidates) {
    const reason = rejectionReason(candidate, profile);
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

// Manual statuses that keep otherwise-present agents out of the offer, split
// by whether the status is already effective or still waiting for the agent's
// current work to end. Supervisors see this in the queue's waiting reason.
function blockingStatuses(candidates) {
  const effective = new Set(), pending = new Set();
  for (const candidate of candidates) {
    const status = candidate.manual_status;
    if (!status || status === "Available") continue;
    (candidate.workflow_state === "idle" ? effective : pending).add(status);
  }
  return { blocked_by_status: [...effective].sort(), pending_statuses: [...pending].sort() };
}

// A polling worker re-evaluates a stuck work item every tick. Diagnostics are
// journaled once per distinct outcome so the event log does not grow by one row
// per second per waiting interaction.
async function appendDedupedDiagnostic(db, workItemId, type, payload, actor = 'router') {
  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const previous = await db.query(`SELECT payload->>'fingerprint' AS fingerprint FROM acd_events
    WHERE work_item_id=$1 AND type=$2 ORDER BY id DESC LIMIT 1`, [workItemId, type]);
  if (previous.rows[0]?.fingerprint === fingerprint) return false;
  await appendEvent(db, { workItemId, type, payload: { ...payload, fingerprint }, actor });
  return true;
}

async function loadQueueConfig(db, queueId) {
  const result = await db.query(
    `SELECT id, routing_strategy, agent_answer_timeout_secs, skill_requirements,
            skill_relaxation_enabled, skill_relaxation_after_seconds, skill_relaxation_strategy
       FROM cc_queues WHERE id = $1`,
    [queueId],
  );
  return result.rows[0] || null;
}

async function evaluateRouting(db, queue, candidates, workItem) {
  const policy = resolvePolicy(queue?.routing_strategy);
  if (policy.name !== 'skills') return { policy, ranked: policy.rank(candidates, workItem) };
  const catalog = (await db.query('SELECT id, name, is_active FROM skills')).rows;
  const now = (await db.query('SELECT now() AS now')).rows[0].now;
  return { policy, ...policy.evaluate(candidates, workItem, { queue, catalog, now }) };
}

async function recordEvaluation(db, workItem, evaluation, candidates, profile) {
  const { policy, ranked, requirements, assessments } = evaluation;
  const payload = {
    node_id: process.env.NODE_ID || null,
    policy: policy.name, queue_id: workItem.queue_id, work_priority: workItem.priority,
    ranking: ranked.map(c => c.agent_id),
    candidates: [...candidates].sort((a, b) => String(a.agent_id).localeCompare(String(b.agent_id))).map(c => ({
      agent_id: c.agent_id, queue_priority: c.queue_priority, last_released_at: c.last_released_at,
      workflow_state: c.workflow_state, capacity_rejection: filterByCapacity([c], profile).length ? null : rejectionReason(c, profile),
    })),
    ...(requirements ? { requirements, skills: assessments.map(({ candidate, ...a }) => a).sort((a, b) => String(a.agent_id).localeCompare(String(b.agent_id))) } : {}),
  };
  const stable = structuredClone(payload);
  delete stable.node_id;
  if (stable.requirements) delete stable.requirements.relaxation.wait_ms;
  const fingerprint = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  const previous = await db.query(`SELECT payload->>'fingerprint' AS fingerprint FROM acd_events
    WHERE work_item_id=$1 AND type='routing_evaluated' ORDER BY id DESC LIMIT 1`, [workItem.id]);
  // A polling worker must not generate a new event/notification on every tick.
  if (previous.rows[0]?.fingerprint !== fingerprint) await appendEvent(db, {
    workItemId: workItem.id, type: 'routing_evaluated', actor: 'router', payload: { ...payload, fingerprint },
  });
  return fingerprint;
}

/**
 * Route one queued work item: claim → candidates → rank → reserve loop.
 * Runs its own transaction on the provided pool client factory.
 *
 * Returns:
 *   { routed: true, agentId, offerId, reservationId, generation }
 *   { routed: false, reason: 'not_claimable'|'queue_missing'|'no_candidates'|'all_reservations_failed' }
 */
export async function routeOne(pool, workItemId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(741901,5)");

    const claim = await client.query(
      `SELECT * FROM acd_work_items
        WHERE id = $1 AND state = 'queued'
        FOR UPDATE SKIP LOCKED`,
      [workItemId],
    );
    const workItem = claim.rows[0];
    if (!workItem) {
      await client.query("ROLLBACK");
      return { routed: false, reason: "not_claimable" };
    }
    if (!RELEASED_CHANNELS.includes(workItem.channel)) {
      await client.query("ROLLBACK");
      return { routed: false, reason: "channel_unavailable" };
    }

    const queue = await loadQueueConfig(client, workItem.queue_id);
    if (!queue) {
      await client.query("ROLLBACK");
      return { routed: false, reason: "queue_missing" };
    }

    const profile = channelProfile(workItem.channel);
    const allCandidates = await candidatesForQueue(client, workItem.queue_id, workItem.channel);
    let eligible = await filterOutboundBlending(client, filterByCapacity(allCandidates, profile), workItem);
    if (usesNativeLifecycle(workItem.channel)) {
      const declined = (await client.query(`SELECT DISTINCT agent_id FROM acd_offers WHERE work_item_id=$1
        AND state IN ('rejected','no_answer') AND terminal_at>now()-interval '30 seconds'`, [workItemId])).rows;
      eligible = eligible.filter(candidate => !declined.some(row => row.agent_id === candidate.agent_id));
    }
    const evaluation = await evaluateRouting(client, queue, eligible, workItem);
    const fingerprint = await recordEvaluation(client, workItem, evaluation, allCandidates, profile);

    if (eligible.length === 0) {
      const candidateReasons = summarizeRejections(allCandidates, profile);
      const rejectionTypes = Object.keys(candidateReasons);
      const reason =
        allCandidates.length === 0
          ? "no_queue_members_online"
          : rejectionTypes.length === 1
            ? rejectionTypes[0]
            : "no_free_capacity";
      await appendDedupedDiagnostic(client, workItemId, "no_agent_reserved", {
        queue_id: workItem.queue_id,
        candidates_total: allCandidates.length,
        candidates_eligible: 0,
        reason,
        candidate_reasons: candidateReasons,
        ...blockingStatuses(allCandidates),
      });
      await client.query("COMMIT"); // keep the diagnostic event
      return { routed: false, reason: "no_candidates" };
    }

    const { policy, ranked } = evaluation;
    if (!ranked.length) {
      // Record the replacement reason. Without it the realtime projection keeps
      // reading the previous diagnostic and still blames agent status, long
      // after the agent became available and a skill mismatch became the blocker.
      await appendDedupedDiagnostic(client, workItemId, "no_agent_reserved", {
        queue_id: workItem.queue_id,
        candidates_total: allCandidates.length,
        candidates_eligible: eligible.length,
        reason: "no_skill_match",
        candidate_reasons: {},
      });
      await client.query('COMMIT'); // keep the diagnostic event
      return { routed: false, reason: 'no_skill_match' };
    }

    const lifecycle = await loadAgentLifecycleSettings(client);
    const answerTimeoutSecs =
      Number(queue.agent_answer_timeout_secs) > 0
        ? Number(queue.agent_answer_timeout_secs)
        : lifecycle.default_answer_timeout_seconds || DEFAULT_ANSWER_TIMEOUT_SECS;
    const offerDeadlineMs = answerTimeoutSecs * 1000 + OFFER_GRACE_MS;

    for (const candidate of ranked.slice(0, MAX_RESERVE_ATTEMPTS)) {
      const reserved = await tryOfferAndReserve(client, {
        workItemId,
        agentId: candidate.agent_id,
        channel: workItem.channel,
        weight: candidate.channel_policy.weight,
        offerDeadlineMs,
      });
      if (!reserved) {
        await appendEvent(client, {
          workItemId,
          agentId: candidate.agent_id,
          type: "reservation_race_lost",
          payload: { queue_id: workItem.queue_id, policy: policy.name },
          actor: "router",
        });
        continue;
      }

      const transition = await applyTransition(client, {
        workItemId,
        expectedVersion: workItem.version,
        to: "offered",
        eventType: "work_item_offered",
        payload: {
          agent_id: candidate.agent_id,
          offer_id: reserved.offerId,
          reservation_id: reserved.reservationId,
          generation: reserved.generation,
          policy: policy.name,
          routing_fingerprint: fingerprint,
        },
        actor: "router",
      });
      if (!transition.applied) {
        // Terminal race (customer abandoned between claim and here): the offer
        // and reservation must not survive the transaction.
        await client.query("ROLLBACK");
        return { routed: false, reason: `work_item_${transition.reason}` };
      }

      if (usesNativeLifecycle(workItem.channel)) {
        const { startTextOffer } = await import("./text-lifecycle.mjs");
        await startTextOffer(client, { workItemId, ...reserved, agentId: candidate.agent_id, offerDeadlineMs });
      }

      await client.query("COMMIT");
      return {
        routed: true,
        agentId: candidate.agent_id,
        offerId: reserved.offerId,
        reservationId: reserved.reservationId,
        generation: reserved.generation,
        answerTimeoutSecs,
      };
    }

    await appendDedupedDiagnostic(client, workItemId, "no_agent_reserved", {
      queue_id: workItem.queue_id,
      candidates_total: allCandidates.length,
      candidates_eligible: eligible.length,
      attempts: Math.min(ranked.length, MAX_RESERVE_ATTEMPTS),
      reason: "all_reservations_failed",
    });
    await client.query("COMMIT");
    return { routed: false, reason: "all_reservations_failed" };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection-level failure — nothing to roll back */
    }
    throw error;
  } finally {
    client.release();
  }
}
