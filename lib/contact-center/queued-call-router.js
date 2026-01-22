import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { assignCallToAgent } from "@/lib/contact-center/state-manager";
import {
  addTimelineEvent,
  TimelineEventTypes,
} from "@/lib/contact-center/call-timeline-tracker";

async function getAgentAvailability(userId) {
  const pool = getPostgresPool();
  if (!pool) return null;

  const result = await pool.query(
    `SELECT 
      u.id,
      u.username,
      u.agent_status,
      u.max_concurrent_calls,
      COALESCE(COUNT(DISTINCT i.id) FILTER (WHERE i.state IN ('ringing', 'answered', 'connected', 'active')), 0) as current_calls_count
     FROM users u
     LEFT JOIN cc_interactions i ON i.agent_username = u.username
       AND i.state IN ('ringing', 'answered', 'connected', 'active')
       AND i.completed_at IS NULL
       AND i.abandoned_at IS NULL
     WHERE u.id = $1
     GROUP BY u.id, u.username, u.agent_status, u.max_concurrent_calls`,
    [userId]
  );

  const agent = result.rows?.[0];
  if (!agent) return null;

  return {
    id: agent.id,
    username: agent.username,
    agentStatus: agent.agent_status,
    maxConcurrentCalls: Number(agent.max_concurrent_calls) || 1,
    currentCallsCount: Number(agent.current_calls_count) || 0,
  };
}

function agentHasCapacity(agent) {
  if (!agent) return false;
  if (!["Available", "Busy"].includes(agent.agentStatus)) return false;
  return agent.currentCallsCount < agent.maxConcurrentCalls;
}

async function assignQueuedInteractionToAgent(interactionId, agent) {
  const pool = getPostgresPool();
  if (!pool) {
    return { success: false, reason: "database_unavailable" };
  }

  const interaction = await PgDb.findInteractionById(interactionId);
  if (!interaction) {
    return { success: false, reason: "interaction_not_found" };
  }

  if (interaction.state !== "queued") {
    return { success: false, reason: "interaction_not_queued" };
  }

  const assignedAt = new Date().toISOString();
  const waitTimeSeconds = interaction.enqueued_at
    ? Math.floor(
        (new Date(assignedAt) - new Date(interaction.enqueued_at)) / 1000
      )
    : 0;

  const routingMetadataWithOffer = addTimelineEvent(
    interaction.routing_metadata || {},
    TimelineEventTypes.OFFERED,
    {
      agentUsername: agent.username,
      agentId: agent.id,
      routingAlgorithm: "manual",
    }
  );

  await PgDb.updateInteractionById(interactionId, {
    agentUsername: agent.username,
    state: "ringing",
    assignedAt,
    routingMetadata: routingMetadataWithOffer,
    waitTimeSeconds,
  });

  assignCallToAgent(interaction.queue_id, interactionId, agent.id, assignedAt);

  // Automatically transfer call to agent's WebRTC client
  try {
    const { bridgeCallToAgent } = await import("./webrtc-bridge.js");
    await bridgeCallToAgent(
      interaction.call_session_id,
      interaction.call_control_id,
      agent.username,
      interaction.from_number,
      interaction.from_name
    );
  } catch (error) {
    console.error(
      `[QueuedCallRouter] Failed to transfer queued call ${interactionId} to agent ${agent.username}:`,
      error
    );
  }

  // Notify agent via SSE
  try {
    const { broadcastToKey } = await import("@/lib/sse");
    await broadcastToKey(`contact-center:agent:${agent.username}`, {
      type: "new_interaction",
      interaction: {
        id: interactionId,
        queueName: interaction.queue_name,
        fromNumber: interaction.from_number,
        toNumber: interaction.to_number,
        fromName: interaction.from_name,
        state: "ringing",
        callControlId: interaction.call_control_id,
        callSessionId: interaction.call_session_id,
        callerName: interaction.from_name,
        callerNumber: interaction.from_number,
        queueId: interaction.queue_id,
        queuedAt: interaction.enqueued_at,
        assignedAt,
      },
    });
  } catch (error) {
    console.error(
      `[QueuedCallRouter] Failed to broadcast queued call ${interactionId}:`,
      error
    );
  }

  return { success: true, interactionId, agent };
}

export async function offerQueuedCallForAgent({
  userId,
  queueIds = null,
} = {}) {
  if (!userId) {
    return { success: false, reason: "missing_user_id" };
  }

  const pool = getPostgresPool();
  if (!pool) {
    return { success: false, reason: "database_unavailable" };
  }

  const agent = await getAgentAvailability(userId);
  console.log("[QueuedCallRouter] Agent availability check:", {
    userId,
    agentStatus: agent?.agentStatus,
    currentCallsCount: agent?.currentCallsCount,
    maxConcurrentCalls: agent?.maxConcurrentCalls,
  });
  if (!agentHasCapacity(agent)) {
    console.log("[QueuedCallRouter] Agent not eligible for queued call:", {
      userId,
      reason: "agent_unavailable",
      agentStatus: agent?.agentStatus,
      currentCallsCount: agent?.currentCallsCount,
      maxConcurrentCalls: agent?.maxConcurrentCalls,
    });
    return { success: true, routed: false, reason: "agent_unavailable" };
  }

  const values = [userId];
  const queueFilter =
    Array.isArray(queueIds) && queueIds.length > 0
      ? "AND qa.queue_id = ANY($2::text[])"
      : "";

  if (queueFilter) {
    values.push(queueIds);
  }

  const queueResult = await pool.query(
    `SELECT qa.queue_id, q.name, q.priority
     FROM cc_queue_user_assignments qa
     JOIN cc_queues q ON q.id = qa.queue_id
     WHERE qa.user_id = $1
       AND qa.enabled = true
       AND q.enabled = true
       AND qa.activated_at IS NOT NULL
       AND qa.deactivated_at IS NULL
       ${queueFilter}
     ORDER BY q.priority DESC, q.name ASC`,
    values
  );

  const activeQueueIds = queueResult.rows.map((row) => row.queue_id);
  const activeQueues = queueResult.rows.map((row) => ({
    id: row.queue_id,
    name: row.name,
  }));
  console.log("[QueuedCallRouter] Active queues for agent:", {
    userId,
    queueIds: activeQueueIds,
    queueNames: activeQueues.map((queue) => queue.name),
  });
  if (activeQueueIds.length === 0) {
    console.log("[QueuedCallRouter] No active queues for agent:", { userId });
    return { success: true, routed: false, reason: "no_active_queues" };
  }

  const activeQueueNames = activeQueues.map((queue) => queue.name);
  const queuedResult = await pool.query(
    `SELECT id
     FROM cc_interactions
     WHERE (queue_id = ANY($1::text[]) OR queue_name = ANY($2::text[]))
       AND state = 'queued'
       AND completed_at IS NULL
       AND abandoned_at IS NULL
     ORDER BY enqueued_at ASC NULLS LAST, created_at ASC
     LIMIT 1`,
    [activeQueueIds, activeQueueNames]
  );

  if (!queuedResult.rows || queuedResult.rows.length === 0) {
    console.log("[QueuedCallRouter] No queued calls found for agent:", {
      userId,
      queueIds: activeQueueIds,
      queueNames: activeQueueNames,
    });
    return { success: true, routed: false, reason: "no_queued_calls" };
  }

  console.log("[QueuedCallRouter] Found queued call to offer:", {
    userId,
    interactionId: queuedResult.rows[0].id,
  });
  return assignQueuedInteractionToAgent(queuedResult.rows[0].id, agent);
}
