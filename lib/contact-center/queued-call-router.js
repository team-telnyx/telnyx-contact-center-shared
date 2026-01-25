import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import {
  assignCallToAgent,
  getQueuedInteractionsForQueues,
  getRealtimeAgentMetrics,
} from "@/lib/contact-center/state-manager";
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
      u.first_name,
      u.last_name,
      u.agent_status,
      u.max_concurrent_calls
     FROM users u
     WHERE u.id = $1`,
    [userId]
  );

  const agent = result.rows?.[0];
  if (!agent) return null;

  const { activeCalls } = getRealtimeAgentMetrics(agent.id);

  return {
    id: agent.id,
    username: agent.username,
    firstName: agent.first_name || null,
    lastName: agent.last_name || null,
    agentStatus: agent.agent_status,
    maxConcurrentCalls: Number(agent.max_concurrent_calls) || 1,
    currentCallsCount: activeCalls || 0,
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

  const routingMetadataWithAlerting = addTimelineEvent(
    interaction.routing_metadata || {},
    TimelineEventTypes.ALERTING,
    {
      timestamp: assignedAt,
      agentUsername: agent.username,
      agentId: agent.id,
      routingAlgorithm: "manual",
    }
  );

  const agentDisplayName = [agent.firstName, agent.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  await PgDb.updateInteractionById(interactionId, {
    agentUsername: agent.username,
    state: "ringing",
    toName: agentDisplayName || agent.username,
    assignedAt,
    routingMetadata: routingMetadataWithAlerting,
    waitTimeSeconds,
  });

  assignCallToAgent(interaction.queue_id, interactionId, agent.id, assignedAt);

  // Stop queue audio before transferring to agent
  try {
    const { stopQueueAudio } = await import("./queue-audio-service.js");
    await stopQueueAudio(interaction.call_control_id);
  } catch (audioError) {
    console.error(
      `[QueuedCallRouter] Failed to stop queue audio for call ${interactionId}:`,
      audioError
    );
    // Continue with transfer even if audio stop fails
  }

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
        aiCallControlId: interaction.metadata?.ai_call_control_id || null,
        metadata: interaction.metadata || {},
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

  const queuedInteractions = getQueuedInteractionsForQueues(activeQueueIds);
  if (queuedInteractions.length === 0) {
    console.log("[QueuedCallRouter] No queued calls found for agent:", {
      userId,
      queueIds: activeQueueIds,
      queueNames: activeQueues.map((queue) => queue.name),
    });
    return { success: true, routed: false, reason: "no_queued_calls" };
  }

  console.log("[QueuedCallRouter] Found queued call to offer:", {
    userId,
    interactionId: queuedInteractions[0].interactionId,
  });
  return assignQueuedInteractionToAgent(
    queuedInteractions[0].interactionId,
    agent
  );
}
