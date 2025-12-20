/**
 * Contact Center Routing Engine
 * Implements FIFO, Skills-based, and Priority-based routing algorithms
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";

/**
 * Get available agents for a queue
 * @param {string} queueId - Queue ID
 * @returns {Promise<Array>} Array of available agents
 */
async function getAvailableAgentsForQueue(queueId) {
  const pool = getPostgresPool();
  if (!pool) return [];

  // Get agents assigned to this queue and currently active
  const query = `
    SELECT 
      u.id,
      u.username,
      u.agent_status,
      u.skills,
      u.max_concurrent_calls,
      u.available_for_routing,
      COALESCE(ast.current_calls_count, 0) as current_calls_count,
      COALESCE(ast.is_available_for_routing, true) as is_available_for_routing,
      qa.priority as queue_priority
    FROM users u
    INNER JOIN cc_queue_user_assignments qa ON u.id = qa.user_id
    LEFT JOIN cc_agent_state ast ON u.id = ast.user_id
    WHERE qa.queue_id = $1
      AND qa.enabled = true
      AND (qa.activated_at IS NOT NULL AND qa.deactivated_at IS NULL)
      AND u.agent_status IN ('Available', 'Busy')
      AND u.available_for_routing = true
      AND (ast.is_available_for_routing IS NULL OR ast.is_available_for_routing = true)
      AND (ast.current_calls_count IS NULL OR ast.current_calls_count < u.max_concurrent_calls)
    ORDER BY qa.priority DESC, u.agent_status ASC, ast.current_calls_count ASC
  `;

  const result = await pool.query(query, [queueId]);
  return result.rows || [];
}

/**
 * FIFO Routing - First In, First Out
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

  // Filter to only truly available agents (not at capacity)
  const availableAgents = agents.filter(
    (agent) =>
      agent.agent_status === "Available" &&
      agent.current_calls_count < agent.max_concurrent_calls
  );

  if (availableAgents.length === 0) {
    // No fully available agents, but some might be busy but under capacity
    const busyAgents = agents.filter(
      (agent) => agent.current_calls_count < agent.max_concurrent_calls
    );
    if (busyAgents.length > 0) {
      // Return agent with lowest current call count
      return busyAgents.sort(
        (a, b) => a.current_calls_count - b.current_calls_count
      )[0];
    }
    return null;
  }

  // For FIFO, we want the agent who has been available longest
  // Since we don't track exact availability time, we use:
  // 1. Agents with no current calls (most available)
  // 2. Then by queue priority
  // 3. Then by current call count (fewer calls = available longer)
  availableAgents.sort((a, b) => {
    if (a.current_calls_count !== b.current_calls_count) {
      return a.current_calls_count - b.current_calls_count;
    }
    return (b.queue_priority || 0) - (a.queue_priority || 0);
  });

  return availableAgents[0];
}

/**
 * Skills-based Routing
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
  const requiredSkills =
    callData.required_skills || queue.skill_requirements || {};

  if (!requiredSkills || Object.keys(requiredSkills).length === 0) {
    // No skills required, fall back to FIFO
    return routeFIFO(queue, callData);
  }

  // Score each agent based on skill match
  const scoredAgents = agents
    .map((agent) => {
      const agentSkills = agent.skills || {};
      let skillScore = 0;
      let matchedSkills = 0;
      let totalRequired = 0;

      // Calculate skill match score
      for (const [skillName, requiredLevel] of Object.entries(requiredSkills)) {
        totalRequired++;
        const agentLevel = agentSkills[skillName] || 0;
        if (agentLevel >= requiredLevel) {
          matchedSkills++;
          // Bonus for exceeding required level
          skillScore += agentLevel + (agentLevel - requiredLevel) * 0.5;
        } else {
          // Penalty for not meeting requirement
          skillScore -= (requiredLevel - agentLevel) * 2;
        }
      }

      // Calculate final score
      const matchRatio = matchedSkills / totalRequired;
      const finalScore =
        matchRatio * 1000 + // Base score for matching
        skillScore * 10 + // Skill proficiency bonus
        (agent.agent_status === "Available" ? 100 : 0) + // Prefer available over busy
        (agent.max_concurrent_calls - agent.current_calls_count) * 10; // Capacity bonus

      return {
        ...agent,
        skillScore: finalScore,
        matchedSkills,
        totalRequired,
        matchRatio,
      };
    })
    .filter((agent) => agent.matchRatio > 0) // Must match at least one skill
    .sort((a, b) => {
      // Sort by: match ratio, then skill score, then availability
      if (a.matchRatio !== b.matchRatio) {
        return b.matchRatio - a.matchRatio;
      }
      if (a.skillScore !== b.skillScore) {
        return b.skillScore - a.skillScore;
      }
      if (a.agent_status !== b.agent_status) {
        return a.agent_status === "Available" ? -1 : 1;
      }
      return a.current_calls_count - b.current_calls_count;
    });

  if (scoredAgents.length === 0) {
    return null;
  }

  return scoredAgents[0];
}

/**
 * Priority-based Routing
 * Routes based on call priority and agent priority
 * @param {Object} queue - Queue configuration
 * @param {Object} callData - Call/interaction data with priority
 * @returns {Promise<Object|null>} Selected agent or null
 */
async function routePriorityBased(queue, callData) {
  const agents = await getAvailableAgentsForQueue(queue.id);

  if (agents.length === 0) {
    return null;
  }

  // Get call priority from callData or default to queue priority
  const callPriority = callData.priority || queue.priority || 0;

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

      return {
        ...agent,
        priorityScore,
      };
    })
    .sort((a, b) => {
      // Sort by priority score, then by availability, then by current calls
      if (a.priorityScore !== b.priorityScore) {
        return b.priorityScore - a.priorityScore;
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
      [queueId]
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
        selectedAgent = await routeSkillsBased(queue, callData);
        routingMetadata.algorithm = "skills_based";
        if (selectedAgent) {
          routingMetadata.skillMatch = {
            matchedSkills: selectedAgent.matchedSkills,
            totalRequired: selectedAgent.totalRequired,
            matchRatio: selectedAgent.matchRatio,
            skillScore: selectedAgent.skillScore,
          };
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
      return {
        success: false,
        agent: null,
        reason: "no_available_agents",
        queueId,
        routingMetadata,
      };
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
      queueId,
      routingMetadata,
    };
  } catch (error) {
    console.error("[RoutingEngine] Error routing call:", error);
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
    console.error("[RoutingEngine] Error checking agent capacity:", error);
    return false;
  }
}
