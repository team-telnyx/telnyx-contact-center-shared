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

/**
 * Check if an agent matches the required skills for a call
 * @param {Object} agentSkills - Agent skills object (UUID keys)
 * @param {Object} requiredSkills - Required skills object (name keys)
 * @returns {Promise<boolean>} True if agent matches all required skills
 */
async function agentMatchesRequiredSkills(agentSkills, requiredSkills) {
  if (!requiredSkills || Object.keys(requiredSkills).length === 0) {
    // No skills required, agent matches
    return true;
  }

  if (!agentSkills || Object.keys(agentSkills).length === 0) {
    // Agent has no skills but skills are required
    return false;
  }

  // Get skills mapping (UUID to name)
  const { getSkillsMapping } = await import("./routing-engine.js");
  const skillsMapping = await getSkillsMapping();

  // Convert agent skills from UUID keys to name keys for comparison
  const agentSkillsByName = {};
  for (const [skillId, proficiency] of Object.entries(agentSkills)) {
    const skillName = skillsMapping.get(skillId);
    if (skillName) {
      agentSkillsByName[skillName] = proficiency;
    }
  }

  // Check if agent matches all required skills
  for (const [skillName, requiredLevel] of Object.entries(requiredSkills)) {
    const agentLevel = agentSkillsByName[skillName] || 0;
    if (agentLevel < requiredLevel) {
      // Agent doesn't meet the required level for this skill
      return false;
    }
  }

  // Agent matches all required skills
  return true;
}

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
      u.max_concurrent_calls,
      u.skills
     FROM users u
     WHERE u.id = $1`,
    [userId]
  );

  const agent = result.rows?.[0];
  if (!agent) return null;

  const { activeCalls } = getRealtimeAgentMetrics(agent.id);

  // Helper to safely parse JSONB
  const safeParse = (value) => {
    if (!value) return null;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return value;
  };

  return {
    id: agent.id,
    username: agent.username,
    firstName: agent.first_name || null,
    lastName: agent.last_name || null,
    agentStatus: agent.agent_status,
    maxConcurrentCalls: Number(agent.max_concurrent_calls) || 1,
    currentCallsCount: activeCalls || 0,
    skills: safeParse(agent.skills) || {},
  };
}

function agentHasCapacity(agent) {
  if (!agent) return false;
  if (!["Available", "Busy"].includes(agent.agentStatus)) return false;
  return agent.currentCallsCount < agent.maxConcurrentCalls;
}

async function assignQueuedInteractionToAgent(
  interactionId,
  agent,
  routingAlgorithm = "manual"
) {
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
      routingAlgorithm: routingAlgorithm,
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
    // Failed to transfer queued call
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
    // Failed to broadcast queued call
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
  if (!agentHasCapacity(agent)) {
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
    `SELECT qa.queue_id, q.id, q.name, q.priority, q.routing_strategy
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
  const queueConfigs = new Map(
    queueResult.rows.map((row) => [
      row.queue_id,
      {
        id: row.id,
        name: row.name,
        routingStrategy: row.routing_strategy,
      },
    ])
  );

  if (activeQueueIds.length === 0) {
    return { success: true, routed: false, reason: "no_active_queues" };
  }

  const queuedInteractions = getQueuedInteractionsForQueues(activeQueueIds);
  if (queuedInteractions.length === 0) {
    return { success: true, routed: false, reason: "no_queued_calls" };
  }

  // Helper to safely parse JSONB
  const safeParse = (value) => {
    if (!value) return null;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return value;
  };

  // Find the first interaction that the agent can handle
  // For skill-based routing, check if agent matches required skills
  for (const queuedInteraction of queuedInteractions) {
    try {
      const interaction = await PgDb.findInteractionById(
        queuedInteraction.interactionId
      );
      if (!interaction || interaction.state !== "queued") {
        continue;
      }

      const queueConfig = queueConfigs.get(interaction.queue_id);
      if (!queueConfig) {
        continue;
      }

      const requiredSkills = safeParse(interaction.required_skills) || {};
      const routingStrategy = queueConfig.routingStrategy || "FIFO";

      // If it's skill-based routing and has required skills, check if agent matches
      if (routingStrategy === "Skill-based") {
        if (
          requiredSkills &&
          Object.keys(requiredSkills).length > 0 &&
          !(await agentMatchesRequiredSkills(agent.skills, requiredSkills))
        ) {
          // Agent doesn't match required skills, skip this interaction
          continue;
        }
      }

      // Agent can handle this interaction, assign it
      const algorithm =
        routingStrategy === "Skill-based" ? "skills_based" : "fifo";
      return assignQueuedInteractionToAgent(
        queuedInteraction.interactionId,
        agent,
        algorithm
      );
    } catch (error) {
      console.error(
        `[QueuedCallRouter] Error checking interaction ${queuedInteraction.interactionId}:`,
        error
      );
      // Continue to next interaction
      continue;
    }
  }

  // No suitable interaction found for this agent
  return {
    success: true,
    routed: false,
    reason: "no_matching_calls",
  };
}
