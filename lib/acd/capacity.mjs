import { randomUUID } from "node:crypto";
import { channelProfile } from "./channels.mjs";
import { appendEvent } from "./events.mjs";
import { ensureAgentState, setWorkflowState } from "./agent-state.mjs";
import { readEffectiveChannelPolicy } from "./utilization.mjs";
import { RELEASED_CHANNELS } from "./channel-policy.mjs";

// Every assignment path takes the same agent row lock before testing capacity.
// Caller owns the transaction; direct and consult claims need no queue offer.
export async function tryReserveCapacity(db, {
  id = randomUUID(), agentId, workItemId = null, attemptId = null,
  channel = "voice", weight = null, leaseMs = 30000, purpose = "queue", actor = "router",
}) {
  if (!RELEASED_CHANNELS.includes(channel)) return null;
  const profile = channelProfile(channel);
  let amount = Number(weight ?? profile.weight);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Invalid reservation size or lease");
  await ensureAgentState(db, agentId);
  await db.query(`UPDATE acd_agent_state a
    SET capacity = COALESCE(p.budget, GREATEST(COALESCE(u.max_concurrent_calls, 1), 1))
    FROM users u LEFT JOIN cc_agent_utilization p ON p.agent_id=u.id
    WHERE u.id = $1 AND a.agent_id = u.id
      AND a.capacity IS DISTINCT FROM COALESCE(p.budget, GREATEST(COALESCE(u.max_concurrent_calls, 1), 1))`, [agentId]);
  const agent = (await db.query(`SELECT * FROM acd_agent_state WHERE agent_id = $1 FOR UPDATE`, [agentId])).rows[0];
  const previous = (await db.query(`SELECT * FROM acd_reservations WHERE id = $1`, [id])).rows[0];
  if (previous) return previous.agent_id === agentId && previous.work_item_id === workItemId
    && previous.channel === channel && previous.state !== "released" ? previous.id : null;
  const queueId = workItemId ? (await db.query("SELECT queue_id FROM acd_work_items WHERE id=$1", [workItemId])).rows[0]?.queue_id : null;
  const policy = await readEffectiveChannelPolicy(db, { agentId, queueId: purpose === "queue" ? queueId : null, channel });
  // Manual dialing and supervision do not consume routing admission budget.
  // They still own a normal voice reservation under the same agent row lock.
  const manualVoice = channel === "voice" && ["direct", "manual_outbound", "supervision"].includes(purpose);
  if (!policy.enabled && !manualVoice) return null;
  amount = weight == null ? policy.weight : Math.max(amount, policy.weight);
  // Self-initiated dialing is independent of queue availability (e.g. Away).
  // Manual voice bypasses messaging occupancy, but never another live voice/video call.
  const selfInitiated = ["direct", "direct_inbound", "manual_outbound", "supervision"].includes(purpose);
  if (!agent || agent.presence !== "online" || (!selfInitiated &&
    (profile.exclusive ? agent.routability !== "routable" : agent.manual_status !== "Available"))) return null;
  // A revoked direct intent that still produced a call is occupancy the
  // provider may not have torn down yet. It has no reservation by design, so
  // it must be read directly or the agent becomes offerable the moment their
  // browser reconnects.
  const rogueOrigination = await db.query(`SELECT 1 FROM acd_direct_intents
    WHERE agent_id = $1 AND state = 'revoked' AND provider_call_id IS NOT NULL AND ended_at IS NULL LIMIT 1`, [agentId]);
  if (rogueOrigination.rowCount) return null;
  const live = (await db.query(`SELECT COALESCE(SUM(weight), 0)::numeric AS weight, COUNT(*)::int AS count,
    COUNT(*) FILTER (WHERE channel = $2)::int AS channel_count, BOOL_OR(channel = 'voice') AS voice, BOOL_OR(channel IN ('voice', 'video')) AS media
    FROM acd_reservations WHERE agent_id = $1 AND state <> 'released' AND (state = 'active' OR owner_saga_id IS NOT NULL OR lease_expires_at > now())`, [agentId, channel])).rows[0];
  if (manualVoice) {
    if (live.media) return null;
    // Retain exclusion for provider media even if its reservation is missing.
    const media = await db.query(`SELECT 1 FROM acd_legs l
      JOIN acd_work_items w ON w.id = l.work_item_id AND w.channel IN ('voice', 'video')
      WHERE l.agent_id = $1 AND l.ended_at IS NULL LIMIT 1`, [agentId]);
    if (media.rowCount) return null;
  } else if (profile.exclusive ? live.count > 0 || agent.workflow_state !== "idle" : live.voice || !["idle", "offered", "handling"].includes(agent.workflow_state)) return null;
  const budget = profile.exclusive ? Number(agent.capacity) : Math.min(Number(agent.capacity), 1);
  if (!manualVoice && (Number(live.weight) + amount > budget + 0.00001 || live.channel_count >= policy.maxConcurrent)) return null;
  const capable = await db.query(`SELECT 1 FROM acd_agent_sessions WHERE agent_id = $1 AND state = 'online'
    AND expires_at > now() AND capabilities->>$2 = 'true' LIMIT 1`, [agentId, channel]);
  if (!capable.rowCount) return null;
  const inserted = await db.query(`INSERT INTO acd_reservations
    (id, agent_id, work_item_id, attempt_id, channel, weight, state, lease_expires_at, purpose)
    VALUES ($1, $2, $3, $4, $5, $6, 'reserved', now() + ($7::text || ' milliseconds')::interval, $8)
    ON CONFLICT DO NOTHING RETURNING id`,
    [id, agentId, workItemId, attemptId, channel, amount, String(leaseMs), purpose]);
  if (!inserted.rowCount) return null;
  if (profile.exclusive) await setWorkflowState(db, agentId, "offered", { workItemId, actor, reason: purpose });
  await appendEvent(db, { workItemId, agentId, type: "capacity_reserved", actor, payload: { reservation_id: id, channel, weight: amount, purpose, attempt_id: attemptId } });
  return id;
}
