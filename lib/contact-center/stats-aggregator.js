/**
 * Contact Center Statistics Aggregator
 * Calculates real-time and historical statistics for queues and agents
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  getRealtimeQueueMetrics,
  getRealtimeAgentMetrics,
  getRealtimeOverallMetrics,
} from "./state-manager.js";

/**
 * Calculate real-time queue statistics
 * @param {string} queueId - Queue ID (optional, if not provided returns all queues)
 * @returns {Promise<Object|Array>} Queue statistics
 */
export async function getQueueStatistics(queueId = null) {
  try {
    const pool = getPostgresPool();
    if (!pool) return queueId ? null : [];

    // Get all enabled queues from database
    let queues;
    if (queueId) {
      const queueResult = await pool.query(
        `SELECT id, name, display_name FROM cc_queues WHERE id = $1 AND enabled = true`,
        [queueId],
      );
      queues = queueResult.rows || [];
    } else {
      const queueResult = await pool.query(
        `SELECT id, name, display_name FROM cc_queues WHERE enabled = true ORDER BY priority DESC, name ASC`,
      );
      queues = queueResult.rows || [];
    }

    if (queues.length === 0) {
      return queueId ? null : [];
    }

    const stats = await Promise.all(
      queues.map(async (queue) => {
        const qId = queue.id;

        // Get real-time metrics from in-memory state
        const realtime = getRealtimeQueueMetrics(qId);

        // Get today's statistics
        const todayQuery = `
          SELECT 
            COUNT(*) FILTER (WHERE state IN ('completed', 'abandoned')) as total_calls,
            COUNT(*) FILTER (WHERE state = 'completed') as answered_calls,
            COUNT(*) FILTER (WHERE state = 'abandoned') as abandoned_calls,
            AVG(wait_time_seconds)::NUMERIC(10,2) as avg_wait_time_seconds,
            MAX(wait_time_seconds) as max_wait_time_seconds,
            AVG(handle_time_seconds)::NUMERIC(10,2) as avg_handle_time_seconds,
            AVG(talk_time_seconds)::NUMERIC(10,2) as avg_talk_time_seconds,
            COUNT(*) FILTER (WHERE wait_time_seconds <= 20 AND state = 'completed') as service_level_calls,
            COUNT(*) FILTER (WHERE state = 'completed') as service_level_total
          FROM cc_interactions
          WHERE queue_id = $1 
            AND DATE(created_at) = CURRENT_DATE
            AND state IN ('completed', 'abandoned')
        `;

        const todayResult = await pool.query(todayQuery, [qId]);
        const today = todayResult.rows[0] || {};

        // Calculate service level percentage (calls answered within threshold)
        const serviceLevelThreshold = 20; // 20 seconds default
        const serviceLevelCalls = parseInt(today.service_level_calls) || 0;
        const serviceLevelTotal = parseInt(today.service_level_total) || 0;
        const serviceLevelPercentage =
          serviceLevelTotal > 0
            ? ((serviceLevelCalls / serviceLevelTotal) * 100).toFixed(2)
            : 0;

        // Get agent statistics for this queue
        const agentQuery = `
          SELECT 
            COUNT(DISTINCT ast.user_id) FILTER (WHERE ast.agent_status = 'Available') as available_agents,
            COUNT(DISTINCT ast.user_id) FILTER (WHERE ast.agent_status = 'Busy') as busy_agents,
            COUNT(DISTINCT ast.user_id) FILTER (WHERE ast.agent_status IN ('Available', 'Busy')) as total_active_agents
          FROM cc_queue_user_assignments qa
          INNER JOIN cc_agent_state ast ON ast.user_id = qa.user_id
          WHERE qa.queue_id = $1 
            AND qa.enabled = true
            AND (qa.activated_at IS NOT NULL AND qa.deactivated_at IS NULL)
        `;

        const agentResult = await pool.query(agentQuery, [qId]);
        const agents = agentResult.rows[0] || {};

        return {
          queueId: qId,
          queueName: queue.display_name || queue.name || qId,
          realtime: {
            currentSize: realtime.waitingCalls || 0,
            waitingCalls: realtime.waitingCalls || 0,
            activeCalls: realtime.activeCalls || 0,
            queuedCalls: realtime.queuedCalls || 0,
            ringingCalls: realtime.ringingCalls || 0,
            longestWaitSeconds: realtime.longestWaitSeconds || 0,
            avgWaitSeconds: realtime.avgWaitSeconds || 0,
          },
          today: {
            totalCalls: parseInt(today.total_calls) || 0,
            answeredCalls: parseInt(today.answered_calls) || 0,
            abandonedCalls: parseInt(today.abandoned_calls) || 0,
            avgWaitTimeSeconds: parseFloat(today.avg_wait_time_seconds) || 0,
            maxWaitTimeSeconds: parseInt(today.max_wait_time_seconds) || 0,
            avgHandleTimeSeconds:
              parseFloat(today.avg_handle_time_seconds) || 0,
            avgTalkTimeSeconds: parseFloat(today.avg_talk_time_seconds) || 0,
            serviceLevelPercentage: parseFloat(serviceLevelPercentage),
            serviceLevelThresholdSeconds: serviceLevelThreshold,
          },
          agents: {
            available: parseInt(agents.available_agents) || 0,
            busy: parseInt(agents.busy_agents) || 0,
            totalActive: parseInt(agents.total_active_agents) || 0,
          },
          lastUpdated: new Date().toISOString(),
        };
      }),
    );

    return queueId ? stats[0] : stats;
  } catch (error) {
    console.error("[StatsAggregator] Error getting queue statistics:", error);
    return queueId ? null : [];
  }
}

/**
 * Calculate agent statistics
 * @param {string} userId - Agent user ID (optional, if not provided returns all agents)
 * @returns {Promise<Object|Array>} Agent statistics
 */
export async function getAgentStatistics(userId = null) {
  try {
    const pool = getPostgresPool();
    if (!pool) return userId ? null : [];

    // Get all active users - show all active users regardless of queue activation
    let agents;
    if (userId) {
      const agentResult = await pool.query(
        `SELECT u.id, u.username, u.first_name, u.last_name, ast.agent_status, u.max_concurrent_calls, u.available_for_routing
         FROM users u
         LEFT JOIN cc_agent_state ast ON ast.user_id = u.id
         WHERE u.id = $1 AND u.active = true`,
        [userId],
      );
      agents = agentResult.rows || [];
    } else {
      const agentResult = await pool.query(
        `SELECT u.id, u.username, u.first_name, u.last_name, ast.agent_status, u.max_concurrent_calls, u.available_for_routing
         FROM users u
         LEFT JOIN cc_agent_state ast ON ast.user_id = u.id
         WHERE u.active = true
         ORDER BY u.first_name ASC, u.last_name ASC, u.username ASC`,
      );
      agents = agentResult.rows || [];
    }

    if (agents.length === 0) {
      return userId ? null : [];
    }

    const stats = await Promise.all(
      agents.map(async (agent) => {
        const uId = agent.id;
        const username = agent.username;

        // Get today's call statistics
        const todayQuery = `
          SELECT 
            COUNT(*) as total_calls,
            COUNT(*) FILTER (WHERE state = 'completed') as completed_calls,
            COUNT(*) FILTER (WHERE state = 'abandoned') as abandoned_calls,
            AVG(wait_time_seconds)::NUMERIC(10,2) as avg_wait_time_seconds,
            AVG(handle_time_seconds)::NUMERIC(10,2) as avg_handle_time_seconds,
            AVG(talk_time_seconds)::NUMERIC(10,2) as avg_talk_time_seconds,
            SUM(talk_time_seconds) as total_talk_time_seconds,
            MIN(answered_at) FILTER (WHERE answered_at IS NOT NULL) as first_call_time,
            MAX(completed_at) FILTER (WHERE completed_at IS NOT NULL) as last_call_time
          FROM cc_interactions
          WHERE agent_username = $1
            AND DATE(created_at) = CURRENT_DATE
            AND state IN ('completed', 'abandoned')
        `;

        const todayResult = await pool.query(todayQuery, [username]);
        const today = todayResult.rows[0] || {};

        // Get current active calls from in-memory state
        const { activeCalls } = getRealtimeAgentMetrics(uId);

        // Get agent state to retrieve available_since for idle time calculation
        const agentStateQuery = `
          SELECT available_since, last_call_ended_at
          FROM cc_agent_state
          WHERE user_id = $1
        `;
        const agentStateResult = await pool.query(agentStateQuery, [uId]);
        let agentState = agentStateResult.rows[0] || {};

        // Initialize available_since ONLY if agent is Available, has no calls, and available_since is truly missing
        // This handles cases where server restarted and agent was already Available
        // IMPORTANT: Only initialize if the row exists but available_since is NULL
        // Don't initialize if the row doesn't exist (that means agent was just created and status update will handle it)
        if (
          agent.agent_status === "Available" &&
          activeCalls === 0 &&
          agentState &&
          !agentState.available_since
        ) {
          // Double-check: Only set if it's still NULL (avoid race conditions)
          // Use a conditional update that only sets if NULL to prevent overwriting existing values
          const updateResult = await pool.query(
            `UPDATE cc_agent_state 
             SET available_since = NOW() 
             WHERE user_id = $1 
               AND agent_status = 'Available'
               AND available_since IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM cc_interactions i 
                 WHERE i.agent_username = cc_agent_state.username 
                   AND i.state IN ('ringing', 'answered', 'connected', 'active')
                   AND i.completed_at IS NULL
                   AND i.abandoned_at IS NULL
               )`,
            [uId],
          );

          // Only re-fetch if we actually updated something
          if (updateResult.rowCount > 0) {
            const updatedResult = await pool.query(agentStateQuery, [uId]);
            agentState = updatedResult.rows[0] || agentState;
          }
        }

        // Calculate current idle time in seconds
        let currentIdleSeconds = 0;
        const availableSince = agentState.available_since;
        if (
          availableSince &&
          agent.agent_status === "Available" &&
          activeCalls === 0
        ) {
          const availableSinceTime = new Date(availableSince).getTime();
          const nowTime = Date.now();
          currentIdleSeconds = Math.max(
            0,
            Math.floor((nowTime - availableSinceTime) / 1000),
          );
        }

        // Get queue assignments
        const queueQuery = `
          SELECT COUNT(*) as assigned_queues
          FROM cc_queue_user_assignments
          WHERE user_id = $1 AND enabled = true
        `;

        const queueResult = await pool.query(queueQuery, [uId]);
        const assignedQueues =
          parseInt(queueResult.rows[0]?.assigned_queues) || 0;

        // Get active queue IDs
        const activeQueueResult = await pool.query(
          `SELECT queue_id FROM cc_queue_user_assignments
           WHERE user_id = $1 
             AND enabled = true 
             AND activated_at IS NOT NULL 
             AND deactivated_at IS NULL`,
          [uId],
        );
        const activeQueueIds = activeQueueResult.rows.map((r) => r.queue_id);

        let activeCampaignIds = [];
        try {
          const activeCampaignResult = await pool.query(
            `SELECT campaign_id
             FROM outbound_campaign_agent_assignments
             WHERE agent_username = $1 AND enabled = true`,
            [username],
          );
          activeCampaignIds = activeCampaignResult.rows.map((row) => row.campaign_id);
        } catch (error) {
          if (error?.code !== "42P01") console.error("[StatsAggregator] Error getting active campaigns:", error);
        }

        return {
          userId: uId,
          username: username,
          firstName: agent.first_name || null,
          lastName: agent.last_name || null,
          status: agent.agent_status || "Offline",
          currentCalls: activeCalls,
          maxConcurrentCalls: parseInt(agent.max_concurrent_calls) || 1,
          isAvailableForRouting: agent.available_for_routing !== false,
          activeQueues: activeQueueIds.length,
          activeQueueIds: activeQueueIds, // Include queue IDs for reference
          activeCampaigns: activeCampaignIds.length,
          activeCampaignIds,
          assignedQueues,
          currentIdleSeconds, // Current idle time in seconds (calculated, may be stale)
          availableSince: availableSince || null, // Timestamp when agent became available (always include, even if null)
          today: {
            totalCalls: parseInt(today.total_calls) || 0,
            completedCalls: parseInt(today.completed_calls) || 0,
            abandonedCalls: parseInt(today.abandoned_calls) || 0,
            avgWaitTimeSeconds: parseFloat(today.avg_wait_time_seconds) || 0,
            avgHandleTimeSeconds:
              parseFloat(today.avg_handle_time_seconds) || 0,
            avgTalkTimeSeconds: parseFloat(today.avg_talk_time_seconds) || 0,
            totalTalkTimeSeconds: parseInt(today.total_talk_time_seconds) || 0,
            firstCallTime: today.first_call_time,
            lastCallTime: today.last_call_time,
          },
          lastUpdated: new Date().toISOString(),
        };
      }),
    );

    return userId ? stats[0] : stats;
  } catch (error) {
    console.error("[StatsAggregator] Error getting agent statistics:", error);
    return userId ? null : [];
  }
}

/**
 * Get overall contact center statistics
 * @returns {Promise<Object>} Overall statistics
 */
export async function getOverallStatistics() {
  try {
    const pool = getPostgresPool();
    if (!pool) return null;

    // Get overall call statistics for today
    const callsQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE AND state IN ('completed', 'abandoned')) as total_calls,
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE AND state = 'completed') as answered_calls,
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE AND state = 'abandoned') as abandoned_calls,
        AVG(wait_time_seconds) FILTER (WHERE DATE(created_at) = CURRENT_DATE)::NUMERIC(10,2) as avg_wait_time_seconds,
        AVG(handle_time_seconds) FILTER (WHERE DATE(created_at) = CURRENT_DATE)::NUMERIC(10,2) as avg_handle_time_seconds,
        AVG(talk_time_seconds) FILTER (WHERE DATE(created_at) = CURRENT_DATE)::NUMERIC(10,2) as avg_talk_time_seconds
      FROM cc_interactions
      WHERE DATE(created_at) = CURRENT_DATE
    `;

    const callsResult = await pool.query(callsQuery);
    const calls = callsResult.rows[0] || {};

    // Get agent statistics - count agents with activated queues
    const agentsQuery = `
      SELECT 
        COUNT(DISTINCT u.id) FILTER (WHERE ast.agent_status = 'Available' AND EXISTS (
          SELECT 1 FROM cc_queue_user_assignments qa 
          WHERE qa.user_id = u.id 
            AND qa.enabled = true 
            AND qa.activated_at IS NOT NULL 
            AND qa.deactivated_at IS NULL
        )) as available_agents,
        COUNT(DISTINCT u.id) FILTER (WHERE ast.agent_status = 'Busy' AND EXISTS (
          SELECT 1 FROM cc_queue_user_assignments qa 
          WHERE qa.user_id = u.id 
            AND qa.enabled = true 
            AND qa.activated_at IS NOT NULL 
            AND qa.deactivated_at IS NULL
        )) as busy_agents,
        COUNT(DISTINCT u.id) FILTER (WHERE ast.agent_status IN ('Available', 'Busy') AND EXISTS (
          SELECT 1 FROM cc_queue_user_assignments qa 
          WHERE qa.user_id = u.id 
            AND qa.enabled = true 
            AND qa.activated_at IS NOT NULL 
            AND qa.deactivated_at IS NULL
        )) as total_active_agents,
        COUNT(DISTINCT u.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM cc_queue_user_assignments qa 
          WHERE qa.user_id = u.id 
            AND qa.enabled = true 
            AND qa.activated_at IS NOT NULL 
            AND qa.deactivated_at IS NULL
        )) as total_agents
      FROM users u
      LEFT JOIN cc_agent_state ast ON ast.user_id = u.id
    `;

    const agentsResult = await pool.query(agentsQuery);
    const agents = agentsResult.rows[0] || {};

    // Get queue statistics
    const queuesQuery = `
      SELECT 
        COUNT(*) as total_queues,
        COUNT(*) FILTER (WHERE enabled = true) as active_queues
      FROM cc_queues q
    `;

    const queuesResult = await pool.query(queuesQuery);
    const queues = queuesResult.rows[0] || {};

    const realtimeOverall = getRealtimeOverallMetrics();

    return {
      calls: {
        total: parseInt(calls.total_calls) || 0,
        answered: parseInt(calls.answered_calls) || 0,
        abandoned: parseInt(calls.abandoned_calls) || 0,
        active: realtimeOverall.activeCalls || 0,
        avgWaitTimeSeconds: parseFloat(calls.avg_wait_time_seconds) || 0,
        avgHandleTimeSeconds: parseFloat(calls.avg_handle_time_seconds) || 0,
        avgTalkTimeSeconds: parseFloat(calls.avg_talk_time_seconds) || 0,
      },
      agents: {
        available: parseInt(agents.available_agents) || 0,
        busy: parseInt(agents.busy_agents) || 0,
        totalActive: parseInt(agents.total_active_agents) || 0,
        total: parseInt(agents.total_agents) || 0,
      },
      queues: {
        total: parseInt(queues.total_queues) || 0,
        active: parseInt(queues.active_queues) || 0,
        totalWaitingCalls: realtimeOverall.waitingCalls || 0,
      },
      lastUpdated: new Date().toISOString(),
    };
  } catch (error) {
    console.error("[StatsAggregator] Error getting overall statistics:", error);
    return null;
  }
}

/**
 * Aggregate statistics for a time period (hourly aggregation)
 * @param {string} queueId - Queue ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Array>} Aggregated statistics by hour
 */
export async function getAggregatedStatistics(queueId, startDate, endDate) {
  try {
    const pool = getPostgresPool();
    if (!pool) return [];

    const query = `
      SELECT 
        stat_date,
        stat_hour,
        total_calls,
        answered_calls,
        abandoned_calls,
        avg_wait_time_seconds,
        max_wait_time_seconds,
        avg_handle_time_seconds,
        avg_talk_time_seconds,
        service_level_percentage,
        peak_queue_size
      FROM cc_queue_statistics
      WHERE queue_id = $1
        AND stat_date >= $2
        AND stat_date <= $3
      ORDER BY stat_date ASC, stat_hour ASC
    `;

    const result = await pool.query(query, [queueId, startDate, endDate]);
    return result.rows || [];
  } catch (error) {
    console.error(
      "[StatsAggregator] Error getting aggregated statistics:",
      error,
    );
    return [];
  }
}

/**
 * Update hourly statistics (should be called periodically)
 */
export async function updateHourlyStatistics() {
  try {
    const pool = getPostgresPool();
    if (!pool) return;

    const now = new Date();
    const currentHour = now.getHours();
    const currentDate = now.toISOString().split("T")[0];

    // Get all enabled queues
    const queuesResult = await pool.query(
      `SELECT id FROM cc_queues WHERE enabled = true`,
    );

    for (const queue of queuesResult.rows || []) {
      const queueId = queue.id;

      // Calculate statistics for the current hour
      const statsQuery = `
        SELECT 
          COUNT(*) FILTER (WHERE state IN ('completed', 'abandoned')) as total_calls,
          COUNT(*) FILTER (WHERE state = 'completed') as answered_calls,
          COUNT(*) FILTER (WHERE state = 'abandoned') as abandoned_calls,
          AVG(wait_time_seconds)::NUMERIC(10,2) as avg_wait_time_seconds,
          MAX(wait_time_seconds) as max_wait_time_seconds,
          AVG(handle_time_seconds)::NUMERIC(10,2) as avg_handle_time_seconds,
          AVG(talk_time_seconds)::NUMERIC(10,2) as avg_talk_time_seconds,
          COUNT(*) FILTER (WHERE wait_time_seconds <= 20 AND state = 'completed') as service_level_calls,
          COUNT(*) FILTER (WHERE state = 'completed') as service_level_total,
          MAX((SELECT COUNT(*) FROM cc_interactions WHERE queue_id = $1 AND state = 'queued' AND DATE_TRUNC('hour', created_at) = DATE_TRUNC('hour', NOW()))) as peak_queue_size
        FROM cc_interactions
        WHERE queue_id = $1
          AND DATE(created_at) = $2
          AND EXTRACT(HOUR FROM created_at) = $3
          AND state IN ('completed', 'abandoned')
      `;

      const statsResult = await pool.query(statsQuery, [
        queueId,
        currentDate,
        currentHour,
      ]);
      const stats = statsResult.rows[0] || {};

      const serviceLevelCalls = parseInt(stats.service_level_calls) || 0;
      const serviceLevelTotal = parseInt(stats.service_level_total) || 0;
      const serviceLevelPercentage =
        serviceLevelTotal > 0
          ? ((serviceLevelCalls / serviceLevelTotal) * 100).toFixed(2)
          : 0;

      // Insert or update statistics
      const { randomUUID } = await import("crypto");
      await pool.query(
        `INSERT INTO cc_queue_statistics (
          id, queue_id, stat_date, stat_hour,
          total_calls, answered_calls, abandoned_calls,
          avg_wait_time_seconds, max_wait_time_seconds,
          avg_handle_time_seconds, avg_talk_time_seconds,
          service_level_percentage, service_level_threshold_seconds,
          peak_queue_size
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (queue_id, stat_date, stat_hour) DO UPDATE SET
          total_calls = EXCLUDED.total_calls,
          answered_calls = EXCLUDED.answered_calls,
          abandoned_calls = EXCLUDED.abandoned_calls,
          avg_wait_time_seconds = EXCLUDED.avg_wait_time_seconds,
          max_wait_time_seconds = EXCLUDED.max_wait_time_seconds,
          avg_handle_time_seconds = EXCLUDED.avg_handle_time_seconds,
          avg_talk_time_seconds = EXCLUDED.avg_talk_time_seconds,
          service_level_percentage = EXCLUDED.service_level_percentage,
          peak_queue_size = EXCLUDED.peak_queue_size,
          updated_at = NOW()`,
        [
          randomUUID(),
          queueId,
          currentDate,
          currentHour,
          parseInt(stats.total_calls) || 0,
          parseInt(stats.answered_calls) || 0,
          parseInt(stats.abandoned_calls) || 0,
          parseFloat(stats.avg_wait_time_seconds) || 0,
          parseInt(stats.max_wait_time_seconds) || 0,
          parseFloat(stats.avg_handle_time_seconds) || 0,
          parseFloat(stats.avg_talk_time_seconds) || 0,
          parseFloat(serviceLevelPercentage),
          20, // Service level threshold
          parseInt(stats.peak_queue_size) || 0,
        ],
      );
    }

    console.log(
      `[StatsAggregator] Updated hourly statistics for ${queuesResult.rows.length} queues`,
    );
  } catch (error) {
    console.error("[StatsAggregator] Error updating hourly statistics:", error);
  }
}
