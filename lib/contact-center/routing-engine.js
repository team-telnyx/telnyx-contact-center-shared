/**
 * Contact Center Routing Engine
 * Implements FIFO, Skills-based, and Priority-based routing algorithms
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import {
  getInteractionsForAgent,
  getRealtimeAgentMetrics,
} from "./state-manager.js";
import { reserveAgent } from "./reservation-manager.js";

/**
 * Get skill UUID to name mapping
 * @returns {Promise<Map<string, string>>} Map of skill UUID to skill name
 */
let skillsCache = null;
let skillsCacheTime = null;
const SKILLS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getSkillsMapping() {
  const now = Date.now();
  // Return cached mapping if still valid
  if (
    skillsCache &&
    skillsCacheTime &&
    now - skillsCacheTime < SKILLS_CACHE_TTL
  ) {
    return skillsCache;
  }

  const pool = getPostgresPool();
  if (!pool) {
    return new Map();
  }

  try {
    const result = await pool.query(
      `SELECT id, name FROM skills WHERE is_active = true`,
    );

    const mapping = new Map();
    result.rows.forEach((row) => {
      mapping.set(row.id, row.name);
    });

    skillsCache = mapping;
    skillsCacheTime = now;
    return mapping;
  } catch (error) {
    console.error("[RoutingEngine] Error loading skills mapping:", error);
    return new Map();
  }
}

/**
 * Convert agent skills from UUID keys to name keys
 * @param {Object} agentSkills - Agent skills object with UUID keys
 * @param {Map<string, string>} skillsMapping - Map of UUID to name
 * @returns {Object} Agent skills object with name keys
 */
function convertAgentSkillsToNames(agentSkills, skillsMapping) {
  if (!agentSkills || typeof agentSkills !== "object") {
    return {};
  }

  const converted = {};
  for (const [skillId, proficiency] of Object.entries(agentSkills)) {
    const skillName = skillsMapping.get(skillId);
    if (skillName) {
      converted[skillName] = proficiency;
    }
  }
  return converted;
}

/**
 * Get available agents for a queue
 * @param {string} queueId - Queue ID
 * @returns {Promise<Array>} Array of available agents
 */
async function getAvailableAgentsForQueue(queueId) {
  const pool = getPostgresPool();
  if (!pool) return [];

  // Get agents assigned to this queue and currently active
  // Current call counts are computed from in-memory interactions
  const query = `
    SELECT 
      u.id,
      u.username,
      u.first_name,
      u.last_name,
      u.agent_status,
      u.skills,
      u.max_concurrent_calls,
      u.available_for_routing,
      COALESCE(ast.is_available_for_routing, true) as is_available_for_routing,
      qa.priority as queue_priority,
      qa.enabled as assignment_enabled,
      qa.activated_at,
      qa.deactivated_at,
      ast.available_since,
      ast.last_call_ended_at,
      ast.total_idle_seconds,
      ast.total_handle_seconds,
      ast.calls_handled_today
    FROM users u
    INNER JOIN cc_queue_user_assignments qa ON u.id = qa.user_id
    LEFT JOIN cc_agent_state ast ON u.id = ast.user_id
    WHERE qa.queue_id = $1
      AND qa.enabled = true
      AND (qa.activated_at IS NOT NULL AND qa.deactivated_at IS NULL)
    GROUP BY u.id, u.username, u.first_name, u.last_name, u.agent_status, u.skills, u.max_concurrent_calls, 
             u.available_for_routing, ast.is_available_for_routing, qa.priority, 
             qa.enabled, qa.activated_at, qa.deactivated_at, ast.available_since,
             ast.last_call_ended_at, ast.total_idle_seconds, ast.total_handle_seconds,
             ast.calls_handled_today
    ORDER BY qa.priority DESC, u.agent_status ASC
  `;

  const result = await pool.query(query, [queueId]);
  const agentsWithCounts = result.rows.map((agent) => {
    const { activeCalls } = getRealtimeAgentMetrics(agent.id);
    return {
      ...agent,
      current_calls_count: activeCalls || 0,
    };
  });

  const availableAgents = agentsWithCounts.filter((agent) => {
    if (agent.agent_status !== "Available") return false;
    if (!agent.available_for_routing) return false;
    if (agent.is_available_for_routing === false) return false;
    return agent.current_calls_count < agent.max_concurrent_calls;
  });

  availableAgents.sort((a, b) => {
    const priorityDiff = (b.queue_priority || 0) - (a.queue_priority || 0);
    if (priorityDiff !== 0) return priorityDiff;
    const statusDiff = String(a.agent_status).localeCompare(
      String(b.agent_status),
    );
    if (statusDiff !== 0) return statusDiff;
    return (a.current_calls_count || 0) - (b.current_calls_count || 0);
  });

  return availableAgents || [];
}

/**
 * FIFO Routing - First In, First Out (Longest Available Agent - LAA)
 * Routes to the agent who has been available the longest
 * @param {Object} queue - Queue configuration
 * @param {Object} callData - Call/interaction data
 * @returns {Promise<Object|null>} Selected agent or null
 */
async function routeFIFO(queue, callData) {
  const agents = await getAvailableAgentsForQueue(queue.id);

  if (agents.length === 0) {
    return null;
  }

  // Filter to only truly available agents (not at capacity, and not in "Agent Not Answering" status)
  const availableAgents = agents.filter(
    (agent) =>
      agent.agent_status === "Available" &&
      agent.current_calls_count < agent.max_concurrent_calls &&
      agent.agent_status !== "Agent Not Answering", // Don't route to agents who didn't answer
  );

  if (availableAgents.length === 0) {
    return null;
  }

  // For FIFO with LAA, sort by available_since (oldest first), then queue priority, then call count
  availableAgents.sort((a, b) => {
    // Longest available first (oldest available_since timestamp)
    const aTime = a.available_since ? new Date(a.available_since).getTime() : 0;
    const bTime = b.available_since ? new Date(b.available_since).getTime() : 0;
    if (aTime !== bTime && aTime > 0 && bTime > 0) {
      return aTime - bTime; // Older = higher priority
    }
    // Fallback to queue priority
    const priorityDiff = (b.queue_priority || 0) - (a.queue_priority || 0);
    if (priorityDiff !== 0) return priorityDiff;
    // Then by current call count
    return a.current_calls_count - b.current_calls_count;
  });

  return availableAgents[0];
}

/**
 * Calculate adjusted required skills based on wait time (skill relaxation)
 * Skills proficiency uses 1-5 star scale
 * @param {Object} requiredSkills - Original required skills
 * @param {number} waitTimeSeconds - How long the call has been waiting
 * @param {Object} queue - Queue configuration with relaxation settings
 * @returns {Object} Adjusted required skills
 */
export function getAdjustedSkillRequirements(
  requiredSkills,
  waitTimeSeconds,
  queue,
) {
  console.log(`[RoutingEngine] getAdjustedSkillRequirements called:`, {
    requiredSkills,
    waitTimeSeconds,
    queueConfig: {
      skill_relaxation_enabled: queue.skill_relaxation_enabled,
      skill_relaxation_after_seconds: queue.skill_relaxation_after_seconds,
      skill_relaxation_strategy: queue.skill_relaxation_strategy,
    },
  });

  if (!queue.skill_relaxation_enabled) {
    console.log(
      `[RoutingEngine] Skill relaxation disabled, returning original skills`,
    );
    return requiredSkills;
  }

  if (waitTimeSeconds < queue.skill_relaxation_after_seconds) {
    console.log(
      `[RoutingEngine] Wait time ${waitTimeSeconds}s < threshold ${queue.skill_relaxation_after_seconds}s, no relaxation yet`,
    );
    return requiredSkills; // No relaxation yet
  }

  const strategy = queue.skill_relaxation_strategy || "progressive";
  const adjusted = {};

  if (strategy === "fallback") {
    // Fallback strategy: Drop skills above 3 stars to 3 stars (intermediate level) immediately after threshold
    // Skills at or below 3 stars remain unchanged (never increase requirements)
    for (const [skill, level] of Object.entries(requiredSkills)) {
      adjusted[skill] = level > 3 ? 3 : level; // Only reduce if above 3 stars, otherwise keep original
    }
    console.log(`[RoutingEngine] Fallback strategy applied:`, {
      original: requiredSkills,
      adjusted,
    });
  } else {
    // Progressive strategy: Reduce by 1 star every 30 seconds
    const relaxationAmount = Math.floor(
      (waitTimeSeconds - queue.skill_relaxation_after_seconds) / 30,
    ); // Reduce by 1 star every 30 seconds

    console.log(`[RoutingEngine] Progressive strategy calculation:`, {
      waitTimeSeconds,
      threshold: queue.skill_relaxation_after_seconds,
      elapsedAfterThreshold:
        waitTimeSeconds - queue.skill_relaxation_after_seconds,
      relaxationAmount,
    });

    for (const [skill, level] of Object.entries(requiredSkills)) {
      adjusted[skill] = Math.max(1, level - relaxationAmount); // Min level = 1 star
    }

    console.log(`[RoutingEngine] Progressive strategy applied:`, {
      original: requiredSkills,
      adjusted,
      relaxationAmount,
    });
  }

  return adjusted;
}

/**
 * Skills-based Routing with relaxation support
 * Routes to the agent with the best matching skills
 * @param {Object} queue - Queue configuration
 * @param {Object} callData - Call/interaction data with required_skills
 * @returns {Promise<Object|null>} Selected agent or null
 */
async function routeSkillsBased(queue, callData) {
  const agents = await getAvailableAgentsForQueue(queue.id);

  if (agents.length === 0) {
    return null;
  }

  // Get required skills from call data or queue configuration
  let requiredSkills =
    callData.required_skills || queue.skill_requirements || {};

  if (!requiredSkills || Object.keys(requiredSkills).length === 0) {
    // No skills required, fall back to FIFO
    return routeFIFO(queue, callData);
  }

  // Apply skill relaxation if call has been waiting
  if (callData.enqueued_at) {
    const now = new Date().getTime();
    const enqueuedAt = new Date(callData.enqueued_at).getTime();
    const waitTimeSeconds = Math.floor((now - enqueuedAt) / 1000);

    console.log(`[RoutingEngine] routeSkillsBased - applying relaxation:`, {
      queueId: queue.id,
      queueName: queue.name,
      enqueuedAt: callData.enqueued_at,
      now: new Date(now).toISOString(),
      waitTimeSeconds,
      queueRelaxationConfig: {
        skill_relaxation_enabled: queue.skill_relaxation_enabled,
        skill_relaxation_after_seconds: queue.skill_relaxation_after_seconds,
        skill_relaxation_strategy: queue.skill_relaxation_strategy,
      },
      originalRequiredSkills: requiredSkills,
    });

    requiredSkills = getAdjustedSkillRequirements(
      requiredSkills,
      waitTimeSeconds,
      queue,
    );

    console.log(`[RoutingEngine] routeSkillsBased - after relaxation:`, {
      relaxedRequiredSkills: requiredSkills,
    });
  } else {
    console.log(
      `[RoutingEngine] routeSkillsBased - no enqueued_at, skipping relaxation`,
    );
  }

  // Load skills mapping (UUID to name)
  const skillsMapping = await getSkillsMapping();

  // Score each agent based on skill match
  // Track all agents' skill matches to provide detailed info when no match is found
  const allAgentsAnalysis = agents.map((agent) => {
    // Convert agent skills from UUID keys to name keys for comparison
    const agentSkillsRaw = agent.skills || {};
    const agentSkills = convertAgentSkillsToNames(
      agentSkillsRaw,
      skillsMapping,
    );
    let skillScore = 0;
    let matchedSkills = 0;
    let totalRequired = 0;
    const skillDetails = [];

    // Calculate skill match score
    for (const [skillName, requiredLevel] of Object.entries(requiredSkills)) {
      totalRequired++;
      const agentLevel = agentSkills[skillName] || 0;
      const hasSkill = agentLevel >= requiredLevel;

      if (hasSkill) {
        matchedSkills++;
        // Bonus for exceeding required level
        skillScore += agentLevel + (agentLevel - requiredLevel) * 0.5;
      } else {
        // Penalty for not meeting requirement
        skillScore -= (requiredLevel - agentLevel) * 2;
      }

      skillDetails.push({
        skillName,
        requiredLevel,
        agentLevel,
        hasSkill,
      });
    }

    // Calculate final score
    const matchRatio = matchedSkills / totalRequired;

    // Calculate utilization score (lower utilization = higher priority)
    const utilizationScore =
      agent.calls_handled_today > 0 &&
      agent.total_idle_seconds + agent.total_handle_seconds > 0
        ? -(
            agent.calls_handled_today /
            (agent.total_idle_seconds + agent.total_handle_seconds + 1)
          ) * 5
        : 0;

    const finalScore =
      matchRatio * 1000 + // Base score for matching
      skillScore * 10 + // Skill proficiency bonus (1-5 star scale)
      (agent.agent_status === "Available" ? 100 : 0) + // Prefer available over busy
      (agent.max_concurrent_calls - agent.current_calls_count) * 10 + // Capacity bonus
      utilizationScore; // Utilization balancing

    return {
      ...agent,
      skillScore: finalScore,
      matchedSkills,
      totalRequired,
      matchRatio,
      skillDetails,
    };
  });

  // Filter to only agents that match ALL required skills (matchRatio === 1)
  const scoredAgents = allAgentsAnalysis
    .filter((agent) => agent.matchRatio === 1) // Must match ALL required skills
    .map((agent) => {
      // Calculate current idle time in seconds (for tie-breaking)
      let currentIdleSeconds = 0;
      if (agent.available_since) {
        const availableSinceTime = new Date(agent.available_since).getTime();
        const nowTime = Date.now();
        currentIdleSeconds = Math.max(
          0,
          Math.floor((nowTime - availableSinceTime) / 1000),
        );
      }
      return {
        ...agent,
        currentIdleSeconds,
      };
    })
    .sort((a, b) => {
      // Sort by: skill score, then idle time (longest idle first), then availability, then current calls
      if (a.skillScore !== b.skillScore) {
        return b.skillScore - a.skillScore;
      }
      // If skill scores are equal, prefer agent with longer idle time (LAA - Longest Available Agent)
      if (a.currentIdleSeconds !== b.currentIdleSeconds) {
        return b.currentIdleSeconds - a.currentIdleSeconds; // Longer idle = higher priority
      }
      if (a.agent_status !== b.agent_status) {
        return a.agent_status === "Available" ? -1 : 1;
      }
      return a.current_calls_count - b.current_calls_count;
    });

  if (scoredAgents.length === 0) {
    // No agent matches all required skills
    // Return null but include skill match analysis in the return value
    // This will be handled by the caller to store in routingMetadata
    return {
      agent: null,
      skillMatchAnalysis: {
        matchedSkills: 0,
        totalRequired: Object.keys(requiredSkills).length,
        matchRatio: 0,
        agentsAnalyzed: allAgentsAnalysis.length,
        // Include summary of what skills are missing across all agents
        missingSkillsSummary: Object.keys(requiredSkills).map((skillName) => {
          const requiredLevel = requiredSkills[skillName];
          const agentsWithSkill = allAgentsAnalysis.filter((a) =>
            a.skillDetails.find((s) => s.skillName === skillName && s.hasSkill),
          ).length;
          return {
            skillName,
            requiredLevel,
            agentsWithSkill,
            agentsWithoutSkill: allAgentsAnalysis.length - agentsWithSkill,
          };
        }),
      },
    };
  }

  return scoredAgents[0];
}

/**
 * Priority-based Routing with call-level priority (1-5 star scale)
 * Routes based on call priority and agent priority
 * @param {Object} queue - Queue configuration
 * @param {Object} callData - Call/interaction data with priority (1-5 stars)
 * @returns {Promise<Object|null>} Selected agent or null
 */
async function routePriorityBased(queue, callData) {
  const agents = await getAvailableAgentsForQueue(queue.id);

  if (agents.length === 0) {
    return null;
  }

  // Get call priority from callData (1-5 star scale) or default to queue's default_call_priority
  const callPriority = callData.priority || queue.default_call_priority || 3;

  // Get priority rules from queue configuration
  const priorityRules = queue.priority_rules || [];

  // Score agents based on priority rules
  const scoredAgents = agents
    .map((agent) => {
      let priorityScore = 0;

      // Base score from agent's queue priority
      priorityScore += (agent.queue_priority || 0) * 10;

      // Apply priority rules
      for (const rule of priorityRules) {
        if (rule.type === "agent_skill_level") {
          const agentSkills = agent.skills || {};
          const skillLevel = agentSkills[rule.skill] || 0;
          if (skillLevel >= rule.min_level) {
            priorityScore += rule.points || 0;
          }
        } else if (rule.type === "agent_status") {
          if (agent.agent_status === rule.status) {
            priorityScore += rule.points || 0;
          }
        } else if (rule.type === "call_priority") {
          if (callPriority >= rule.min_priority) {
            priorityScore += rule.points || 0;
          }
        }
      }

      // Availability bonus
      if (agent.agent_status === "Available") {
        priorityScore += 50;
      }

      // Capacity bonus (more available capacity = higher priority)
      const availableCapacity =
        agent.max_concurrent_calls - agent.current_calls_count;
      priorityScore += availableCapacity * 20;

      // Calculate current idle time in seconds (for tie-breaking)
      let currentIdleSeconds = 0;
      if (agent.available_since) {
        const availableSinceTime = new Date(agent.available_since).getTime();
        const nowTime = Date.now();
        currentIdleSeconds = Math.max(
          0,
          Math.floor((nowTime - availableSinceTime) / 1000),
        );
      }

      return {
        ...agent,
        priorityScore,
        currentIdleSeconds,
      };
    })
    .sort((a, b) => {
      // Sort by priority score, then by idle time (longest idle first), then by availability, then by current calls
      if (a.priorityScore !== b.priorityScore) {
        return b.priorityScore - a.priorityScore;
      }
      // If priority scores are equal, prefer agent with longer idle time (LAA - Longest Available Agent)
      if (a.currentIdleSeconds !== b.currentIdleSeconds) {
        return b.currentIdleSeconds - a.currentIdleSeconds; // Longer idle = higher priority
      }
      if (a.agent_status !== b.agent_status) {
        return a.agent_status === "Available" ? -1 : 1;
      }
      return a.current_calls_count - b.current_calls_count;
    });

  return scoredAgents[0];
}

/**
 * Main routing function
 * Routes a call to the best available agent based on queue routing strategy
 * @param {string} queueId - Queue ID
 * @param {Object} callData - Call/interaction data
 * @returns {Promise<Object|null>} Routing result with agent and metadata
 */
export async function routeCall(queueId, callData = {}) {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      throw new Error("Database not available");
    }

    // Get queue configuration
    const queueResult = await pool.query(
      `SELECT * FROM cc_queues WHERE id = $1 AND enabled = true`,
      [queueId],
    );

    if (!queueResult.rows || queueResult.rows.length === 0) {
      throw new Error(`Queue ${queueId} not found or disabled`);
    }

    const queue = queueResult.rows[0];
    const routingStrategy = queue.routing_strategy || "FIFO";

    let selectedAgent = null;
    let routingMetadata = {
      strategy: routingStrategy,
      timestamp: new Date().toISOString(),
    };

    // Route based on strategy
    switch (routingStrategy) {
      case "FIFO":
        selectedAgent = await routeFIFO(queue, callData);
        routingMetadata.algorithm = "first_in_first_out";
        break;

      case "Skill-based":
        const skillsRoutingResult = await routeSkillsBased(queue, callData);
        routingMetadata.algorithm = "skills_based";

        // Check if result is an agent or a no-match result with analysis
        if (skillsRoutingResult && skillsRoutingResult.agent === null) {
          // No agent matched all required skills - include skill match analysis
          selectedAgent = null;
          routingMetadata.skillMatch = skillsRoutingResult.skillMatchAnalysis;
        } else if (skillsRoutingResult) {
          // Agent found that matches all required skills
          selectedAgent = skillsRoutingResult;
          routingMetadata.skillMatch = {
            matchedSkills: selectedAgent.matchedSkills,
            totalRequired: selectedAgent.totalRequired,
            matchRatio: selectedAgent.matchRatio,
            skillScore: selectedAgent.skillScore,
          };
        } else {
          // No agents available at all
          selectedAgent = null;
        }
        break;

      case "Priority-based":
        selectedAgent = await routePriorityBased(queue, callData);
        routingMetadata.algorithm = "priority_based";
        if (selectedAgent) {
          routingMetadata.priorityScore = selectedAgent.priorityScore;
        }
        break;

      default:
        // Default to FIFO
        selectedAgent = await routeFIFO(queue, callData);
        routingMetadata.algorithm = "first_in_first_out";
    }

    if (!selectedAgent) {
      // Determine the reason for no agent match
      let reason = "no_available_agents";
      if (routingStrategy === "Skill-based" && routingMetadata.skillMatch) {
        // Skills-based routing with skill match analysis means agents exist but don't match
        reason = "no_skills_matching";
      }

      return {
        success: false,
        agent: null,
        reason,
        queueId,
        routingMetadata,
      };
    }

    const shouldReserve = callData.reserve !== false;
    let reservationId = null;

    if (shouldReserve) {
      reservationId = await reserveAgent(selectedAgent.id, {
        pool,
        channel: "inbound",
        interactionId: callData.interactionId || null,
        queueId,
      });

      if (!reservationId) {
        return {
          success: false,
          agent: null,
          reason: "agent_reservation_failed",
          queueId,
          routingMetadata,
        };
      }

      routingMetadata.reservationId = reservationId;
    }

    return {
      success: true,
      agent: {
        id: selectedAgent.id,
        username: selectedAgent.username,
        agent_status: selectedAgent.agent_status,
        current_calls_count: selectedAgent.current_calls_count,
        max_concurrent_calls: selectedAgent.max_concurrent_calls,
      },
      reservationId,
      queueId,
      routingMetadata,
    };
  } catch (error) {
    return {
      success: false,
      agent: null,
      reason: "routing_error",
      error: error.message,
    };
  }
}

/**
 * Check if an agent can accept a new call
 * @param {string} agentId - Agent user ID
 * @returns {Promise<boolean>} True if agent can accept calls
 */
export async function canAgentAcceptCall(agentId) {
  try {
    const pool = getPostgresPool();
    if (!pool) return false;

    const query = `
      SELECT 
        u.id,
        u.agent_status,
        u.max_concurrent_calls,
        u.available_for_routing,
        COALESCE(ast.current_calls_count, 0) as current_calls_count,
        COALESCE(ast.is_available_for_routing, true) as is_available_for_routing
      FROM users u
      LEFT JOIN cc_agent_state ast ON u.id = ast.user_id
      WHERE u.id = $1
    `;

    const result = await pool.query(query, [agentId]);
    if (!result.rows || result.rows.length === 0) {
      return false;
    }

    const agent = result.rows[0];
    return (
      agent.agent_status !== "Offline" &&
      agent.available_for_routing &&
      agent.is_available_for_routing &&
      agent.current_calls_count < agent.max_concurrent_calls
    );
  } catch (error) {
    return false;
  }
}

/**
 * Calculate expected wait time for a queue
 * @param {string} queueId - Queue ID
 * @returns {Promise<number|null>} Expected wait time in seconds, or null if no agents available
 */
export async function calculateExpectedWaitTime(queueId) {
  try {
    const pool = getPostgresPool();
    if (!pool) return null;

    // Get queue configuration
    const queueResult = await pool.query(
      `SELECT * FROM cc_queues WHERE id = $1 AND enabled = true`,
      [queueId],
    );

    if (!queueResult.rows || queueResult.rows.length === 0) {
      return null;
    }

    const queue = queueResult.rows[0];
    const { getRealtimeQueueMetrics } = await import("./state-manager.js");
    const queueState = getRealtimeQueueMetrics(queueId);

    // Get available agents for this queue
    const agents = await getAvailableAgentsForQueue(queueId);
    const availableAgents = agents.filter(
      (agent) =>
        agent.agent_status === "Available" &&
        agent.current_calls_count < agent.max_concurrent_calls,
    );

    if (availableAgents.length === 0) {
      return null; // No agents available
    }

    // Calculate average handle time from queue config or use default
    const avgHandleTime = queue.avg_handle_time_seconds || 180;

    // Calculate available agent capacity
    const availableCapacity = availableAgents.reduce(
      (sum, agent) =>
        sum + (agent.max_concurrent_calls - agent.current_calls_count),
      0,
    );

    // EWT = (calls in queue / available capacity) * average handle time
    const ewt = Math.ceil(
      (queueState.queuedCalls / Math.max(1, availableCapacity)) * avgHandleTime,
    );

    return ewt;
  } catch (error) {
    console.error(
      "[RoutingEngine] Error calculating expected wait time:",
      error,
    );
    return null;
  }
}
