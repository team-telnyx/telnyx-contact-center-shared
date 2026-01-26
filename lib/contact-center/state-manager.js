/**
 * Contact Center State Manager
 * Manages real-time state for calls, queues, and agents
 * Uses in-memory cache with periodic database sync for scalability
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { randomUUID } from "crypto";

// In-memory state cache for fast access
const stateCache = {
  queues: new Map(), // queueId -> queue state
  agents: new Map(), // userId -> agent state
  interactions: new Map(), // interactionId -> interaction state
  lastSync: new Date(),
};

// Sync interval (milliseconds)
const SYNC_INTERVAL = 5000; // 5 seconds
let syncInterval = null;

/**
 * Initialize state manager and start sync process
 */
export function initializeStateManager() {
  if (syncInterval) {
    return; // Already initialized
  }

  // Pure in-memory mode: do not hydrate from DB to avoid stale "ghost" calls
  stateCache.queues.clear();
  stateCache.agents.clear();
  stateCache.interactions.clear();

  // Start periodic sync
  syncInterval = setInterval(() => {
    syncStateToDatabase();
  }, SYNC_INTERVAL);
}

/**
 * Stop state manager
 */
export function stopStateManager() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  // Final sync before shutdown
  syncStateToDatabase();
}

/**
 * Load state from database into memory
 */
async function loadStateFromDatabase() {
  try {
    const pool = getPostgresPool();
    if (!pool) return;

    // Load queue states
    const queueStates = await pool.query(`
      SELECT 
        qs.*,
        COUNT(DISTINCT i.id) FILTER (WHERE i.state IN ('queued', 'ringing', 'answered', 'connected', 'active')) as current_size,
        MIN(i.enqueued_at) FILTER (WHERE i.state IN ('queued', 'ringing')) as oldest_call_enqueued_at
      FROM cc_queue_state qs
      INNER JOIN cc_queues q ON qs.queue_id = q.id
      LEFT JOIN cc_interactions i ON i.queue_id = qs.queue_id AND i.state IN ('queued', 'ringing', 'answered', 'connected', 'active')
      WHERE q.enabled = true
      GROUP BY qs.queue_id, qs.queue_name
    `);

    for (const row of queueStates.rows || []) {
      stateCache.queues.set(row.queue_id, {
        queueId: row.queue_id,
        queueName: row.queue_name,
        currentSize: parseInt(row.current_size) || 0,
        longestWaitSeconds: parseInt(row.longest_wait_seconds) || 0,
        oldestCallEnqueuedAt: row.oldest_call_enqueued_at,
        activeAgentsCount: parseInt(row.active_agents_count) || 0,
        availableAgentsCount: parseInt(row.available_agents_count) || 0,
        busyAgentsCount: parseInt(row.busy_agents_count) || 0,
        lastUpdated: row.last_updated,
      });
    }

    // Load agent states
    const agentStates = await pool.query(`
      SELECT 
        ast.*,
        COUNT(DISTINCT i.id) FILTER (WHERE i.state IN ('ringing', 'answered', 'connected', 'active')) as current_calls_count
      FROM cc_agent_state ast
      INNER JOIN users u ON ast.user_id = u.id
      LEFT JOIN cc_interactions i ON i.agent_username = ast.username AND i.state IN ('ringing', 'answered', 'connected', 'active')
      WHERE u.agent_status != 'Offline'
      GROUP BY ast.user_id, ast.username, ast.agent_status, ast.max_concurrent_calls, ast.is_available_for_routing, ast.active_queue_ids, ast.last_status_change, ast.last_activity
    `);

    for (const row of agentStates.rows || []) {
      stateCache.agents.set(row.user_id, {
        userId: row.user_id,
        username: row.username,
        agentStatus: row.agent_status,
        currentCallsCount: parseInt(row.current_calls_count) || 0,
        maxConcurrentCalls: parseInt(row.max_concurrent_calls) || 1,
        isAvailableForRouting: row.is_available_for_routing,
        activeQueueIds: row.active_queue_ids || [],
        lastStatusChange: row.last_status_change,
        lastActivity: row.last_activity,
      });
    }

  } catch (error) {
    // Error loading state from database
  }
}

/**
 * Sync state to database
 * Uses retry logic for deadlocks and proper transaction handling
 */
async function syncStateToDatabase() {
  const pool = getPostgresPool();
  if (!pool) return;

  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Update queue states
      for (const [queueId, queueState] of stateCache.queues.entries()) {
        await client.query(
          `INSERT INTO cc_queue_state (
            queue_id, queue_name, current_size, longest_wait_seconds,
            oldest_call_enqueued_at, active_agents_count, available_agents_count,
            busy_agents_count, last_updated
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (queue_id) DO UPDATE SET
            current_size = EXCLUDED.current_size,
            longest_wait_seconds = EXCLUDED.longest_wait_seconds,
            oldest_call_enqueued_at = EXCLUDED.oldest_call_enqueued_at,
            active_agents_count = EXCLUDED.active_agents_count,
            available_agents_count = EXCLUDED.available_agents_count,
            busy_agents_count = EXCLUDED.busy_agents_count,
            last_updated = NOW()`,
          [
            queueState.queueId,
            queueState.queueName,
            queueState.currentSize,
            queueState.longestWaitSeconds,
            queueState.oldestCallEnqueuedAt,
            queueState.activeAgentsCount,
            queueState.availableAgentsCount,
            queueState.busyAgentsCount,
          ]
        );
      }

      // Update agent states - batch updates to reduce deadlock risk
      const agentUpdates = Array.from(stateCache.agents.entries());
      // Sort by user_id to ensure consistent lock ordering and reduce deadlocks
      agentUpdates.sort((a, b) => a[0].localeCompare(b[0]));

      for (const [userId, agentState] of agentUpdates) {
        await client.query(
          `INSERT INTO cc_agent_state (
            user_id, username, agent_status, current_calls_count,
            max_concurrent_calls, is_available_for_routing, active_queue_ids,
            last_status_change, last_activity
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (user_id) DO UPDATE SET
            agent_status = EXCLUDED.agent_status,
            current_calls_count = EXCLUDED.current_calls_count,
            max_concurrent_calls = EXCLUDED.max_concurrent_calls,
            is_available_for_routing = EXCLUDED.is_available_for_routing,
            active_queue_ids = EXCLUDED.active_queue_ids,
            last_status_change = EXCLUDED.last_status_change,
            last_activity = NOW()`,
          [
            agentState.userId,
            agentState.username,
            agentState.agentStatus,
            agentState.currentCallsCount,
            agentState.maxConcurrentCalls,
            agentState.isAvailableForRouting,
            agentState.activeQueueIds,
            agentState.lastStatusChange,
          ]
        );
      }

      await client.query("COMMIT");
      stateCache.lastSync = new Date();
      return; // Success, exit retry loop
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // Ignore rollback errors
      });

      // Check if it's a deadlock error (code 40P01)
      if (error.code === "40P01" && retryCount < maxRetries - 1) {
        retryCount++;
        const delay = Math.random() * 100 * retryCount; // Exponential backoff with jitter
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue; // Retry
      }

      // For other errors or max retries reached, exit
      if (error.code === "23514") {
        // Check constraint violation
      }
      return; // Exit on non-retryable errors or max retries
    } finally {
      client.release();
    }
  }
}

/**
 * Update queue state when a call is enqueued
 */
export function enqueueCall(queueId, interactionId, enqueuedAt, queueName = null) {
  const queueState = stateCache.queues.get(queueId);
  if (!queueState) {
    // Initialize queue state
    stateCache.queues.set(queueId, {
      queueId,
      queueName: queueName || queueId,
      currentSize: 1,
      longestWaitSeconds: 0,
      oldestCallEnqueuedAt: enqueuedAt,
      activeAgentsCount: 0,
      availableAgentsCount: 0,
      busyAgentsCount: 0,
      lastUpdated: new Date(),
    });
  } else {
    queueState.currentSize += 1;
    if (
      !queueState.oldestCallEnqueuedAt ||
      new Date(enqueuedAt) < new Date(queueState.oldestCallEnqueuedAt)
    ) {
      queueState.oldestCallEnqueuedAt = enqueuedAt;
    }
    queueState.lastUpdated = new Date();
  }

  // Store interaction in cache
  stateCache.interactions.set(interactionId, {
    interactionId,
    queueId,
    queueName,
    state: "queued",
    enqueuedAt,
  });
}

/**
 * Update queue state when a call is assigned to an agent
 */
export function assignCallToAgent(queueId, interactionId, agentId, assignedAt) {
  const queueState = stateCache.queues.get(queueId);
  if (queueState) {
    queueState.currentSize = Math.max(0, queueState.currentSize - 1);
    queueState.lastUpdated = new Date();
  }

  const agentState = stateCache.agents.get(agentId);
  if (agentState) {
    agentState.currentCallsCount += 1;
    if (agentState.agentStatus === "Available") {
      agentState.agentStatus = "Busy";
      agentState.lastStatusChange = new Date();
    }
    agentState.lastActivity = new Date();
  }

  const interaction = stateCache.interactions.get(interactionId);
  if (interaction) {
    interaction.state = "ringing";
    interaction.assignedAt = assignedAt;
    interaction.agentId = agentId;
  }
}

/**
 * Update state when a call is answered
 */
export function answerCall(interactionId, answeredAt) {
  const interaction = stateCache.interactions.get(interactionId);
  if (interaction) {
    interaction.state = "answered";
    interaction.answeredAt = answeredAt;
    if (interaction.enqueuedAt) {
      interaction.waitTimeSeconds = Math.floor(
        (new Date(answeredAt) - new Date(interaction.enqueuedAt)) / 1000
      );
    }
  }
}

/**
 * Update state when a call is completed or abandoned
 */
export function completeCall(interactionId, completedAt, wasAbandoned = false) {
  const interaction = stateCache.interactions.get(interactionId);
  if (!interaction) return;

  interaction.state = wasAbandoned ? "abandoned" : "completed";
  interaction.completedAt = completedAt;

  // Update queue state
  if (interaction.queueId) {
    const queueState = stateCache.queues.get(interaction.queueId);
    if (queueState && interaction.state === "queued") {
      queueState.currentSize = Math.max(0, queueState.currentSize - 1);
      queueState.lastUpdated = new Date();
    }
  }

  // Update agent state
  if (interaction.agentId) {
    const agentState = stateCache.agents.get(interaction.agentId);
    if (agentState) {
      agentState.currentCallsCount = Math.max(
        0,
        agentState.currentCallsCount - 1
      );
      if (
        agentState.currentCallsCount === 0 &&
        agentState.agentStatus === "Busy"
      ) {
        agentState.agentStatus = "Available";
        agentState.lastStatusChange = new Date();
      }
      agentState.lastActivity = new Date();
    }
  }

  // Remove from cache after a delay (keep for a bit for stats)
  setTimeout(() => {
    stateCache.interactions.delete(interactionId);
  }, 60000); // Keep for 1 minute
}

/**
 * Update agent status
 */
export function updateAgentStatus(userId, status, username) {
  let agentState = stateCache.agents.get(userId);
  if (!agentState) {
    agentState = {
      userId,
      username: username || userId,
      agentStatus: status,
      currentCallsCount: 0,
      maxConcurrentCalls: 1,
      isAvailableForRouting: true,
      activeQueueIds: [],
      lastStatusChange: new Date(),
      lastActivity: new Date(),
    };
    stateCache.agents.set(userId, agentState);
  } else {
    agentState.agentStatus = status;
    agentState.lastStatusChange = new Date();
    agentState.lastActivity = new Date();
    if (username) {
      agentState.username = username;
    }
  }
}

/**
 * Update agent queue activation
 */
export function updateAgentQueues(userId, queueIds, isActive) {
  const agentState = stateCache.agents.get(userId);
  if (agentState) {
    if (isActive) {
      // Add queues
      for (const queueId of queueIds) {
        if (!agentState.activeQueueIds.includes(queueId)) {
          agentState.activeQueueIds.push(queueId);
        }
      }
    } else {
      // Remove queues
      agentState.activeQueueIds = agentState.activeQueueIds.filter(
        (id) => !queueIds.includes(id)
      );
    }
    agentState.lastActivity = new Date();
  }
}

/**
 * Get current queue state
 */
export function getQueueState(queueId) {
  return stateCache.queues.get(queueId) || null;
}

/**
 * Get current agent state
 */
export function getAgentState(userId) {
  return stateCache.agents.get(userId) || null;
}

/**
 * Get all queue states
 */
export function getAllQueueStates() {
  return Array.from(stateCache.queues.values());
}

/**
 * Get all agent states
 */
export function getAllAgentStates() {
  return Array.from(stateCache.agents.values());
}

/**
 * Get interaction state from in-memory cache
 */
export function getInteractionState(interactionId) {
  return stateCache.interactions.get(interactionId) || null;
}

/**
 * Get queued interactions for the provided queues (oldest first)
 */
export function getQueuedInteractionsForQueues(queueIds) {
  const targetIds = Array.isArray(queueIds) ? new Set(queueIds) : null;
  const interactions = [];

  for (const interaction of stateCache.interactions.values()) {
    if (interaction.state !== "queued") continue;
    if (targetIds && !targetIds.has(interaction.queueId)) continue;
    interactions.push(interaction);
  }

  interactions.sort((a, b) => {
    const aTime = a.enqueuedAt ? new Date(a.enqueuedAt).getTime() : 0;
    const bTime = b.enqueuedAt ? new Date(b.enqueuedAt).getTime() : 0;
    return aTime - bTime;
  });

  return interactions;
}

/**
 * Get interactions assigned to a specific agent
 */
export function getInteractionsForAgent(userId) {
  const interactions = [];
  for (const interaction of stateCache.interactions.values()) {
    if (interaction.agentId === userId) {
      interactions.push(interaction);
    }
  }
  return interactions;
}

/**
 * Get real-time queue metrics from in-memory interactions
 */
export function getRealtimeQueueMetrics(queueId) {
  const metrics = {
    waitingCalls: 0,
    activeCalls: 0,
    queuedCalls: 0,
    ringingCalls: 0,
    longestWaitSeconds: 0,
    avgWaitSeconds: 0,
  };

  let waitSumSeconds = 0;
  let waitCount = 0;
  const nowMs = Date.now();

  for (const interaction of stateCache.interactions.values()) {
    if (queueId && interaction.queueId !== queueId) continue;

    const state = interaction.state;
    if (state === "queued") {
      metrics.queuedCalls += 1;
      metrics.waitingCalls += 1;
    } else if (state === "ringing") {
      metrics.ringingCalls += 1;
      metrics.waitingCalls += 1;
    } else if (["answered", "connected", "active"].includes(state)) {
      metrics.activeCalls += 1;
    }

    if (["queued", "ringing"].includes(state) && interaction.enqueuedAt) {
      const enqueuedAtMs = new Date(interaction.enqueuedAt).getTime();
      const waitSeconds = Math.max(
        0,
        Math.floor((nowMs - enqueuedAtMs) / 1000)
      );
      metrics.longestWaitSeconds = Math.max(
        metrics.longestWaitSeconds,
        waitSeconds
      );
      waitSumSeconds += waitSeconds;
      waitCount += 1;
    }
  }

  metrics.avgWaitSeconds =
    waitCount > 0 ? parseFloat((waitSumSeconds / waitCount).toFixed(2)) : 0;

  return metrics;
}

/**
 * Get real-time agent metrics from in-memory interactions
 */
export function getRealtimeAgentMetrics(userId) {
  let activeCalls = 0;

  for (const interaction of stateCache.interactions.values()) {
    if (interaction.agentId !== userId) continue;
    if (["ringing", "answered", "connected", "active"].includes(interaction.state)) {
      activeCalls += 1;
    }
  }

  return { activeCalls };
}

/**
 * Get overall real-time call metrics from in-memory interactions
 */
export function getRealtimeOverallMetrics() {
  let activeCalls = 0;
  let waitingCalls = 0;

  for (const interaction of stateCache.interactions.values()) {
    if (
      ["queued", "ringing", "answered", "connected", "active"].includes(
        interaction.state
      )
    ) {
      activeCalls += 1;
    }
    if (["queued", "ringing"].includes(interaction.state)) {
      waitingCalls += 1;
    }
  }

  return { activeCalls, waitingCalls };
}

/**
 * Refresh queue state from database
 */
export async function refreshQueueState(queueId) {
  try {
    const pool = getPostgresPool();
    if (!pool) return;

    const result = await pool.query(
      `SELECT 
        qs.*,
        COUNT(DISTINCT i.id) FILTER (WHERE i.state IN ('queued', 'ringing', 'answered', 'connected', 'active')) as current_size,
        MIN(i.enqueued_at) FILTER (WHERE i.state IN ('queued', 'ringing')) as oldest_call_enqueued_at,
        COUNT(DISTINCT CASE WHEN ast.agent_status = 'Available' THEN ast.user_id END) as available_agents_count,
        COUNT(DISTINCT CASE WHEN ast.agent_status = 'Busy' THEN ast.user_id END) as busy_agents_count
      FROM cc_queue_state qs
      INNER JOIN cc_queues q ON qs.queue_id = q.id
      LEFT JOIN cc_interactions i ON i.queue_id = qs.queue_id AND i.state IN ('queued', 'ringing', 'answered', 'connected', 'active')
      LEFT JOIN cc_queue_user_assignments qa ON qa.queue_id = qs.queue_id AND qa.enabled = true
      LEFT JOIN cc_agent_state ast ON ast.user_id = qa.user_id
      WHERE qs.queue_id = $1
      GROUP BY qs.queue_id, qs.queue_name`,
      [queueId]
    );

    if (result.rows && result.rows.length > 0) {
      const row = result.rows[0];
      stateCache.queues.set(queueId, {
        queueId: row.queue_id,
        queueName: row.queue_name,
        currentSize: parseInt(row.current_size) || 0,
        longestWaitSeconds: parseInt(row.longest_wait_seconds) || 0,
        oldestCallEnqueuedAt: row.oldest_call_enqueued_at,
        activeAgentsCount:
          parseInt(row.available_agents_count) +
            parseInt(row.busy_agents_count) || 0,
        availableAgentsCount: parseInt(row.available_agents_count) || 0,
        busyAgentsCount: parseInt(row.busy_agents_count) || 0,
        lastUpdated: row.last_updated,
      });
    }
  } catch (error) {
    // Error refreshing queue state
  }
}

// Initialize state manager when module is imported (server-side only)
if (typeof window === "undefined") {
  // Initialize on first import
  initializeStateManager();
}
