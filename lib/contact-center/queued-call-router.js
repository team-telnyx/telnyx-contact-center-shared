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
import { normalizeLanguageCode } from "@/lib/language-code-utils";

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
      u.language,
      u.skills
     FROM users u
     WHERE u.id = $1`,
    [userId],
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
    language: normalizeLanguageCode(agent.language, { fallback: "en" }),
    currentCallsCount: activeCalls || 0,
    skills: safeParse(agent.skills) || {},
  };
}

function agentHasCapacity(agent) {
  if (!agent) return false;
  if (agent.agentStatus !== "Available") return false;
  return agent.currentCallsCount < agent.maxConcurrentCalls;
}

async function assignQueuedInteractionToAgent(
  interactionId,
  agent,
  routingAlgorithm = "manual",
) {
  const pool = getPostgresPool();
  if (!pool) {
    return { success: false, reason: "database_unavailable" };
  }

  const client = await pool.connect();
  let interaction = null;
  let assignedAt = null;
  let assignedMetadata = null;

  try {
    await client.query("BEGIN");

    const lockResult = await client.query(
      `SELECT * FROM cc_interactions WHERE id = $1 FOR UPDATE`,
      [interactionId],
    );
    interaction = lockResult.rows?.[0] || null;

    if (!interaction) {
      await client.query("ROLLBACK");
      return { success: false, reason: "interaction_not_found" };
    }

    if (interaction.state !== "queued") {
      await client.query("ROLLBACK");
      return { success: false, reason: "interaction_not_queued" };
    }

    assignedAt = new Date().toISOString();
    const waitTimeSeconds = interaction.enqueued_at
      ? Math.floor(
          (new Date(assignedAt) - new Date(interaction.enqueued_at)) / 1000,
        )
      : 0;

    const safeParse = (value) => {
      if (!value) return null;
      if (typeof value === "object") return value;
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return null;
    };

    const routingMetadataWithAlerting = addTimelineEvent(
      safeParse(interaction.routing_metadata) || {},
      TimelineEventTypes.ALERTING,
      {
        timestamp: assignedAt,
        agentUsername: agent.username,
        agentId: agent.id,
        routingAlgorithm: routingAlgorithm,
      },
    );

    const agentDisplayName = [agent.firstName, agent.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();

    // Clear timeout_re_enqueued flag when re-assigning (call is being offered again)
    const currentMetadata = safeParse(interaction.metadata) || {};
    const agentLanguage = normalizeLanguageCode(agent.language, { fallback: currentMetadata.agent_language || "en" });
    const updatedMetadata = { ...currentMetadata, agent_language: agentLanguage };
    if (updatedMetadata.timeout_re_enqueued) {
      delete updatedMetadata.timeout_re_enqueued;
      delete updatedMetadata.timeout_re_enqueued_at;
      delete updatedMetadata.previous_agent;
    }
    assignedMetadata = updatedMetadata;

    await client.query(
      `UPDATE cc_interactions
       SET agent_username = $1,
           state = 'ringing',
           to_name = $2,
           assigned_at = $3,
           routing_metadata = $4::jsonb,
           wait_time_seconds = $5,
           metadata = $6::jsonb,
           updated_at = NOW()
       WHERE id = $7 AND state = 'queued'`,
      [
        agent.username,
        agentDisplayName || agent.username,
        assignedAt,
        JSON.stringify(routingMetadataWithAlerting),
        waitTimeSeconds,
        JSON.stringify(updatedMetadata),
        interactionId,
      ],
    );

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    return { success: false, reason: "assign_transaction_failed" };
  } finally {
    client.release();
  }

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
      interaction.from_name,
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
        metadata: assignedMetadata || interaction.metadata || {},
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
    `SELECT 
      qa.queue_id, 
      q.id, 
      q.name, 
      q.priority, 
      q.routing_strategy,
      q.skill_relaxation_enabled,
      q.skill_relaxation_after_seconds,
      q.skill_relaxation_strategy
     FROM cc_queue_user_assignments qa
     JOIN cc_queues q ON q.id = qa.queue_id
     WHERE qa.user_id = $1
       AND qa.enabled = true
       AND q.enabled = true
       AND qa.activated_at IS NOT NULL
       AND qa.deactivated_at IS NULL
       ${queueFilter}
     ORDER BY q.priority DESC, q.name ASC`,
    values,
  );

  const activeQueueIds = queueResult.rows.map((row) => row.queue_id);
  const queueConfigs = new Map(
    queueResult.rows.map((row) => {
      const config = {
        id: row.id,
        name: row.name,
        routingStrategy: row.routing_strategy,
        skillRelaxationEnabled: Boolean(row.skill_relaxation_enabled),
        skillRelaxationAfterSeconds: row.skill_relaxation_after_seconds || 60,
        skillRelaxationStrategy: row.skill_relaxation_strategy || "progressive",
      };
      return [row.queue_id, config];
    }),
  );

  if (activeQueueIds.length === 0) {
    return { success: true, routed: false, reason: "no_active_queues" };
  }

  // Get agent state to access queue call counts and last queue
  const agentStateResult = await pool.query(
    `SELECT queue_call_counts, last_call_from_queue_id FROM cc_agent_state WHERE user_id = $1`,
    [userId],
  );
  const agentState = agentStateResult.rows[0] || {
    queue_call_counts: {},
    last_call_from_queue_id: null,
  };

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

  // Sort queued interactions by priority DESC (1-5 stars), then enqueued_at ASC (FIFO)
  const sortedInteractions = await Promise.all(
    queuedInteractions.map(async (interaction) => {
      const fullInteraction = await PgDb.findInteractionById(
        interaction.interactionId,
      );
      return fullInteraction;
    }),
  );

  const validInteractions = sortedInteractions.filter(
    (i) => i && i.state === "queued",
  );

  validInteractions.sort((a, b) => {
    // High priority first (5 stars before 1 star)
    const priorityA = a.priority || 3;
    const priorityB = b.priority || 3;
    const priorityDiff = priorityB - priorityA;
    if (priorityDiff !== 0) return priorityDiff;

    // Then oldest first (FIFO)
    const aTime = a.enqueued_at ? new Date(a.enqueued_at).getTime() : 0;
    const bTime = b.enqueued_at ? new Date(b.enqueued_at).getTime() : 0;
    return aTime - bTime;
  });

  // Multi-queue fairness algorithm: select queue using weighted scoring
  const queueScores = activeQueueIds
    .map((queueId) => {
      const queueConfig = queueConfigs.get(queueId);
      if (!queueConfig) return null;

      // Check if there are any queued calls in this queue
      const hasQueuedCalls = validInteractions.some(
        (i) => i.queue_id === queueId,
      );
      if (!hasQueuedCalls) return null;

      const queueCounts = safeParse(agentState.queue_call_counts) || {};
      const callCount = queueCounts[queueId] || 0;
      const lastQueuePenalty =
        agentState.last_call_from_queue_id === queueId ? 50 : 0;

      // Get queue priority from database
      const queuePriority = queueConfig.priority || 0;

      // Score = queue priority - (calls taken * 10) - last queue penalty
      const score = queuePriority - callCount * 10 - lastQueuePenalty;

      return { queueId, queueConfig, score, callCount };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score); // Highest score wins

  const targetQueue = queueScores[0];
  if (!targetQueue) {
    return { success: true, routed: false, reason: "no_matching_calls" };
  }

  // Find first suitable call from target queue (already sorted by priority + FIFO)
  for (const interaction of validInteractions) {
    try {
      if (!interaction || interaction.state !== "queued") {
        continue;
      }

      // Only process calls from the target queue (fairness algorithm)
      if (interaction.queue_id !== targetQueue.queueId) {
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
        if (requiredSkills && Object.keys(requiredSkills).length > 0) {
          // Apply skill relaxation if enabled
          let skillsToCheck = requiredSkills;
          if (interaction.enqueued_at && queueConfig.skillRelaxationEnabled) {
            const now = new Date().getTime();
            const enqueuedAt = new Date(interaction.enqueued_at).getTime();
            const waitTimeSeconds = Math.floor((now - enqueuedAt) / 1000);

            const { getAdjustedSkillRequirements } =
              await import("./routing-engine.js");
            skillsToCheck = getAdjustedSkillRequirements(
              requiredSkills,
              waitTimeSeconds,
              {
                skill_relaxation_enabled: queueConfig.skillRelaxationEnabled,
                skill_relaxation_after_seconds:
                  queueConfig.skillRelaxationAfterSeconds,
                skill_relaxation_strategy: queueConfig.skillRelaxationStrategy,
              },
            );
          }

          if (
            !(await agentMatchesRequiredSkills(agent.skills, skillsToCheck))
          ) {
            // Agent doesn't match required skills (after relaxation), skip this interaction
            continue;
          }
        }
      }

      // Agent can handle this interaction, assign it
      const algorithm =
        routingStrategy === "Skill-based" ? "skills_based" : "fifo";
      const result = await assignQueuedInteractionToAgent(
        interaction.id,
        agent,
        algorithm,
      );

      // Update queue call counts and last queue
      if (result.success) {
        const queueCounts = safeParse(agentState.queue_call_counts) || {};
        queueCounts[targetQueue.queueId] =
          (queueCounts[targetQueue.queueId] || 0) + 1;

        await pool.query(
          `UPDATE cc_agent_state 
           SET queue_call_counts = $1, last_call_from_queue_id = $2 
           WHERE user_id = $3`,
          [JSON.stringify(queueCounts), targetQueue.queueId, userId],
        );
      }

      return result;
    } catch (error) {
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
