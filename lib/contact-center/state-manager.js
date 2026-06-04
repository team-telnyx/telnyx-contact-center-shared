/**
 * Contact Center State Manager
 * Manages real-time state for calls, queues, and agents
 * Uses in-memory cache with periodic database sync for scalability
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { randomUUID } from "crypto";
import { runWithCoordinatorLease } from "./coordinator-lease.js";

// Cache for status types to avoid repeated database queries
let statusTypeCache = new Map();
let statusTypeCacheTime = null;
const STATUS_TYPE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get status type from database (with caching)
 * @param {string} statusName - Status name
 * @returns {Promise<string|null>} Status type ('active' or 'break') or null if not found
 */
async function getStatusType(statusName) {
  if (!statusName) return null;

  // Check cache first
  const now = Date.now();
  if (
    statusTypeCache.has(statusName) &&
    statusTypeCacheTime &&
    now - statusTypeCacheTime < STATUS_TYPE_CACHE_TTL
  ) {
    return statusTypeCache.get(statusName);
  }

  // Query database
  try {
    const pool = getPostgresPool();
    if (!pool) return null;

    const result = await pool.query(
      `SELECT type FROM cc_user_statuses WHERE name = $1 AND is_active = true`,
      [statusName],
    );

    const statusType = result.rows[0]?.type || null;

    // Update cache
    statusTypeCache.set(statusName, statusType);
    statusTypeCacheTime = now;

    return statusType;
  } catch (error) {
    console.error(
      `[StateManager] Error getting status type for ${statusName}:`,
      error,
    );
    return null;
  }
}

/**
 * Check if a status is a break type or should preserve idle time
 * @param {string} statusName - Status name
 * @returns {Promise<boolean>} True if status type is 'break' or should preserve idle time
 */
async function isBreakStatus(statusName) {
  if (!statusName) return false;
  // "Agent Not Answering" and "Offline" are always treated as break-like (preserve idle time)
  if (statusName === "Agent Not Answering" || statusName === "Offline")
    return true;
  const statusType = await getStatusType(statusName);
  return statusType === "break";
}

/**
 * Clear the status type cache (useful when statuses are updated)
 */
export function clearStatusTypeCache() {
  statusTypeCache.clear();
  statusTypeCacheTime = null;
}

// Keep state and interval handles on globalThis so Next.js dev/HMR does not
// split mutators and surviving background intervals across different module
// instances. Duplicate intervals can create many concurrent Postgres queries,
// while a module-local cache would stop being synced after a reload.
function createStateCache() {
  return {
    queues: new Map(), // queueId -> queue state
    agents: new Map(), // userId -> agent state
    interactions: new Map(), // interactionId -> interaction state
    lastSync: new Date(),
  };
}

const stateManagerRuntime = (globalThis.__cc_state_manager_runtime ||= {
  stateCache: createStateCache(),
  syncInterval: null,
  routingReEvalInterval: null,
  agentAnswerTimeoutInterval: null,
  isCheckingTimeouts: false,
});

// Backfill runtime objects created by older module versions before stateCache
// was moved onto globalThis. Next.js dev/HMR preserves that object and `||=`
// will not re-run the initializer.
stateManagerRuntime.stateCache ||= createStateCache();
stateManagerRuntime.isCheckingTimeouts ||= false;

// In-memory state cache for fast access. Shared across HMR reloads.
const stateCache = stateManagerRuntime.stateCache;

// Sync interval (milliseconds)
const SYNC_INTERVAL = 5000; // 5 seconds
let syncInterval = stateManagerRuntime.syncInterval;

// Routing re-evaluation interval (milliseconds)
// Re-evaluates routing for available agents to catch skill relaxation
const ROUTING_RE_EVAL_INTERVAL = 10000; // 10 seconds
const ROUTING_RE_EVAL_LEASE_TTL = ROUTING_RE_EVAL_INTERVAL * 2;
const AGENT_ANSWER_TIMEOUT_INTERVAL = 5000; // 5 seconds
const AGENT_ANSWER_TIMEOUT_LEASE_TTL = AGENT_ANSWER_TIMEOUT_INTERVAL * 2;
let routingReEvalInterval = stateManagerRuntime.routingReEvalInterval;
let agentAnswerTimeoutInterval = stateManagerRuntime.agentAnswerTimeoutInterval;

/**
 * Periodically re-evaluate routing for all available agents
 * This ensures that calls with relaxed skills are routed when agents become eligible
 */
async function reEvaluateRoutingForAvailableAgents() {
  try {
    const pool = getPostgresPool();
    if (!pool) return;

    // Get all available agents who are activated in at least one queue
    const agentsResult = await pool.query(
      `SELECT DISTINCT ast.user_id
       FROM cc_agent_state ast
       INNER JOIN cc_queue_user_assignments qa ON ast.user_id = qa.user_id
       INNER JOIN cc_queues q ON qa.queue_id = q.id
       WHERE ast.agent_status = 'Available'
         AND ast.is_available_for_routing = true
         AND qa.enabled = true
         AND q.enabled = true
         AND qa.activated_at IS NOT NULL
         AND qa.deactivated_at IS NULL`,
    );

    if (!agentsResult.rows || agentsResult.rows.length === 0) {
      return; // No available agents
    }

    // Import offerQueuedCallForAgent dynamically to avoid circular dependencies
    const { offerQueuedCallForAgent } = await import("./queued-call-router.js");

    // Re-evaluate routing for each available agent
    // Use Promise.allSettled to avoid one failure blocking others
    const reEvalPromises = agentsResult.rows.map((row) =>
      offerQueuedCallForAgent({ userId: String(row.user_id) }).catch(
        (error) => {
          // Log but don't throw - we want to continue with other agents
          console.error(
            `[StateManager] Error re-evaluating routing for agent ${row.user_id}:`,
            error,
          );
          return { success: false, error: error.message };
        },
      ),
    );

    await Promise.allSettled(reEvalPromises);
  } catch (error) {
    // Log error but don't throw - this is a background process
    console.error(
      "[StateManager] Error in periodic routing re-evaluation:",
      error,
    );
  }
}

/**
 * Initialize available_since for agents who are already Available when server starts
 */
async function initializeAvailableAgents() {
  try {
    const pool = getPostgresPool();
    if (!pool) return;

    // Get all agents who are Available and have no active calls
    const result = await pool.query(`
      SELECT 
        ast.user_id,
        ast.agent_status,
        ast.available_since,
        COUNT(DISTINCT i.id) FILTER (WHERE i.state IN ('ringing', 'answered', 'connected', 'active')) as current_calls_count
      FROM cc_agent_state ast
      INNER JOIN users u ON ast.user_id = u.id
      LEFT JOIN cc_interactions i ON i.agent_username = ast.username AND i.state IN ('ringing', 'answered', 'connected', 'active')
      WHERE u.agent_status = 'Available'
        AND u.agent_status != 'Offline'
      GROUP BY ast.user_id, ast.agent_status, ast.available_since
      HAVING COUNT(DISTINCT i.id) FILTER (WHERE i.state IN ('ringing', 'answered', 'connected', 'active')) = 0
    `);

    for (const row of result.rows || []) {
      const userId = row.user_id;
      let agentState = stateCache.agents.get(userId);

      if (!agentState) {
        // Initialize agent state if not already in cache
        const userResult = await pool.query(
          `SELECT id, username, agent_status, max_concurrent_calls, available_for_routing 
           FROM users WHERE id = $1`,
          [userId],
        );
        const user = userResult.rows[0];
        if (!user) continue;

        agentState = {
          userId,
          username: user.username || userId,
          agentStatus: user.agent_status || "Available",
          currentCallsCount: 0,
          maxConcurrentCalls: parseInt(user.max_concurrent_calls) || 1,
          isAvailableForRouting: user.available_for_routing !== false,
          activeQueueIds: [],
          lastStatusChange: new Date(),
          lastActivity: new Date(),
          availableSince: null,
          lastCallEndedAt: null,
          queueCallCounts: {},
          totalIdleSeconds: 0,
          totalHandleSeconds: 0,
          callsHandledToday: 0,
        };
        stateCache.agents.set(userId, agentState);
      }

      // Set available_since if agent is Available and has no calls
      // Use existing available_since from DB if it exists, otherwise set to now
      if (
        agentState.agentStatus === "Available" &&
        agentState.currentCallsCount === 0
      ) {
        if (row.available_since) {
          // Preserve existing available_since from database
          agentState.availableSince = new Date(row.available_since);
        } else {
          // Set to now if not already set
          agentState.availableSince = new Date();
          // Also update in database
          await pool.query(
            `UPDATE cc_agent_state 
             SET available_since = NOW() 
             WHERE user_id = $1 AND available_since IS NULL`,
            [userId],
          );
        }
      }
    }
  } catch (error) {
    console.error("[StateManager] Error initializing available agents:", error);
  }
}

/**
 * Initialize state manager and start sync process
 */
export function initializeStateManager() {
  if (
    stateManagerRuntime.syncInterval ||
    stateManagerRuntime.routingReEvalInterval ||
    stateManagerRuntime.agentAnswerTimeoutInterval
  ) {
    syncInterval = stateManagerRuntime.syncInterval;
    routingReEvalInterval = stateManagerRuntime.routingReEvalInterval;
    agentAnswerTimeoutInterval = stateManagerRuntime.agentAnswerTimeoutInterval;
    return; // Already initialized, including across Next.js dev/HMR reloads
  }

  // Pure in-memory mode: do not hydrate from DB to avoid stale "ghost" calls
  stateCache.queues.clear();
  stateCache.agents.clear();
  stateCache.interactions.clear();

  // Initialize available_since for agents who are already Available
  initializeAvailableAgents().catch((error) => {
    console.error(
      "[StateManager] Failed to initialize available agents:",
      error,
    );
  });

  // Start periodic sync
  syncInterval = setInterval(() => {
    syncStateToDatabase();
  }, SYNC_INTERVAL);
  stateManagerRuntime.syncInterval = syncInterval;

  // Start periodic routing re-evaluation for skill relaxation.
  // Each app node may run the timer, but only the node holding the DB lease does the work.
  routingReEvalInterval = setInterval(async () => {
    try {
      await runWithCoordinatorLease(
        "cc-routing-re-eval",
        ROUTING_RE_EVAL_LEASE_TTL,
        () => reEvaluateRoutingForAvailableAgents(),
      );
    } catch (error) {
      console.error(
        "[StateManager] Error in routing re-evaluation interval:",
        error,
      );
    }
  }, ROUTING_RE_EVAL_INTERVAL);
  stateManagerRuntime.routingReEvalInterval = routingReEvalInterval;

  // Start periodic agent answer timeout checking.
  // Lease-gated so multi-node deployments do not process the same timeout twice.
  agentAnswerTimeoutInterval = setInterval(async () => {
    // Skip if previous check is still running on this node
    if (stateManagerRuntime.isCheckingTimeouts) {
      return;
    }

    stateManagerRuntime.isCheckingTimeouts = true;
    try {
      await runWithCoordinatorLease(
        "cc-agent-answer-timeouts",
        AGENT_ANSWER_TIMEOUT_LEASE_TTL,
        async () => {
          const { checkAndHandleAgentAnswerTimeouts } =
            await import("./agent-answer-timeout.js");
          await checkAndHandleAgentAnswerTimeouts();
        },
      );
    } catch (error) {
      console.error(
        "[StateManager] Error in agent answer timeout check:",
        error,
      );
    } finally {
      stateManagerRuntime.isCheckingTimeouts = false;
    }
  }, AGENT_ANSWER_TIMEOUT_INTERVAL);
  stateManagerRuntime.agentAnswerTimeoutInterval = agentAnswerTimeoutInterval;
}

/**
 * Stop state manager
 */
export function stopStateManager() {
  if (syncInterval || stateManagerRuntime.syncInterval) {
    clearInterval(syncInterval || stateManagerRuntime.syncInterval);
    syncInterval = null;
    stateManagerRuntime.syncInterval = null;
  }
  if (routingReEvalInterval || stateManagerRuntime.routingReEvalInterval) {
    clearInterval(routingReEvalInterval || stateManagerRuntime.routingReEvalInterval);
    routingReEvalInterval = null;
    stateManagerRuntime.routingReEvalInterval = null;
  }
  if (agentAnswerTimeoutInterval || stateManagerRuntime.agentAnswerTimeoutInterval) {
    clearInterval(agentAnswerTimeoutInterval || stateManagerRuntime.agentAnswerTimeoutInterval);
    agentAnswerTimeoutInterval = null;
    stateManagerRuntime.agentAnswerTimeoutInterval = null;
  }
  stateManagerRuntime.isCheckingTimeouts = false;
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
    // Exclude consult calls from call count
    const agentStates = await pool.query(`
      SELECT 
        ast.*,
        COUNT(DISTINCT i.id) FILTER (WHERE i.state IN ('ringing', 'answered', 'connected', 'active') AND COALESCE(i.metadata->>'is_consult_call', 'false') <> 'true') as current_calls_count
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

    // Load active interactions into cache (for all queue types, regardless of routing strategy)
    // Exclude consult calls from monitoring
    const interactions = await pool.query(`
      SELECT 
        i.id,
        i.queue_id,
        i.queue_name,
        i.state,
        i.agent_username,
        i.enqueued_at,
        i.assigned_at,
        i.answered_at,
        u.id as agent_id
      FROM cc_interactions i
      LEFT JOIN users u ON i.agent_username = u.username
      WHERE i.completed_at IS NULL
        AND i.abandoned_at IS NULL
        AND i.state IN ('queued', 'ringing', 'answered', 'connected', 'active')
        AND COALESCE(i.metadata->>'is_consult_call', 'false') <> 'true'
    `);

    // Clear existing interactions cache before reloading
    stateCache.interactions.clear();

    for (const row of interactions.rows || []) {
      stateCache.interactions.set(row.id, {
        interactionId: row.id,
        queueId: row.queue_id,
        queueName: row.queue_name,
        state: row.state,
        enqueuedAt: row.enqueued_at,
        assignedAt: row.assigned_at,
        answeredAt: row.answered_at,
        agentId: row.agent_id || null,
      });
    }
  } catch (error) {
    console.error("[StateManager] Error loading state from database:", error);
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
          ],
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
            last_status_change, last_activity, available_since, last_call_ended_at,
            queue_call_counts, total_idle_seconds, total_handle_seconds, calls_handled_today
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10, $11, $12, $13, $14)
          ON CONFLICT (user_id) DO UPDATE SET
            agent_status = EXCLUDED.agent_status,
            current_calls_count = EXCLUDED.current_calls_count,
            max_concurrent_calls = EXCLUDED.max_concurrent_calls,
            is_available_for_routing = EXCLUDED.is_available_for_routing,
            active_queue_ids = EXCLUDED.active_queue_ids,
            last_status_change = EXCLUDED.last_status_change,
            last_activity = NOW(),
            available_since = EXCLUDED.available_since,
            last_call_ended_at = EXCLUDED.last_call_ended_at,
            queue_call_counts = EXCLUDED.queue_call_counts,
            total_idle_seconds = EXCLUDED.total_idle_seconds,
            total_handle_seconds = EXCLUDED.total_handle_seconds,
            calls_handled_today = EXCLUDED.calls_handled_today`,
          [
            agentState.userId,
            agentState.username,
            agentState.agentStatus,
            agentState.currentCallsCount,
            agentState.maxConcurrentCalls,
            agentState.isAvailableForRouting,
            agentState.activeQueueIds,
            agentState.lastStatusChange,
            agentState.availableSince || null,
            agentState.lastCallEndedAt || null,
            agentState.queueCallCounts
              ? JSON.stringify(agentState.queueCallCounts)
              : null,
            agentState.totalIdleSeconds || 0,
            agentState.totalHandleSeconds || 0,
            agentState.callsHandledToday || 0,
          ],
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
export function enqueueCall(
  queueId,
  interactionId,
  enqueuedAt,
  queueName = null,
) {
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
    // Track last queue this call came from
    agentState.lastCallFromQueueId = queueId;
    // Update queue call counts
    if (!agentState.queueCallCounts) {
      agentState.queueCallCounts = {};
    }
    agentState.queueCallCounts[queueId] =
      (agentState.queueCallCounts[queueId] || 0) + 1;
  }

  const interaction = stateCache.interactions.get(interactionId);
  if (interaction) {
    interaction.state = "ringing";
    interaction.assignedAt = assignedAt;
    interaction.agentId = agentId;
  }
}

/**
 * Remove call assignment from agent (for re-enqueue scenarios)
 */
export function removeCallFromAgent(queueId, interactionId, agentId) {
  const agentState = stateCache.agents.get(agentId);
  if (agentState) {
    agentState.currentCallsCount = Math.max(
      0,
      agentState.currentCallsCount - 1,
    );
    agentState.lastActivity = new Date();
    // Update queue call counts if tracking
    if (agentState.queueCallCounts && agentState.queueCallCounts[queueId]) {
      agentState.queueCallCounts[queueId] = Math.max(
        0,
        agentState.queueCallCounts[queueId] - 1,
      );
    }
    // If agent has no calls and was Busy, set back to Available
    if (
      agentState.currentCallsCount === 0 &&
      agentState.agentStatus === "Busy"
    ) {
      agentState.agentStatus = "Available";
      agentState.lastStatusChange = new Date();
      agentState.availableSince = new Date();
    }
  }

  const interaction = stateCache.interactions.get(interactionId);
  if (interaction) {
    interaction.agentId = null;
    interaction.assignedAt = null;
    // If interaction was in "ringing" state and is being removed from agent,
    // it's likely being re-enqueued, so update state to "queued"
    if (interaction.state === "ringing") {
      interaction.state = "queued";
    }
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
        (new Date(answeredAt) - new Date(interaction.enqueuedAt)) / 1000,
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
        agentState.currentCallsCount - 1,
      );

      // Calculate idle time if agent was available
      if (agentState.availableSince) {
        const idleTime = Math.floor(
          (new Date(completedAt).getTime() -
            new Date(agentState.availableSince).getTime()) /
            1000,
        );
        agentState.totalIdleSeconds =
          (agentState.totalIdleSeconds || 0) + Math.max(0, idleTime);
      }

      // Calculate handle time if call was answered
      if (interaction.answeredAt && !wasAbandoned) {
        const handleTime = Math.floor(
          (new Date(completedAt).getTime() -
            new Date(interaction.answeredAt).getTime()) /
            1000,
        );
        agentState.totalHandleSeconds =
          (agentState.totalHandleSeconds || 0) + Math.max(0, handleTime);
        agentState.callsHandledToday = (agentState.callsHandledToday || 0) + 1;
      }

      // Set last call ended timestamp
      agentState.lastCallEndedAt = completedAt;

      if (
        agentState.currentCallsCount === 0 &&
        agentState.agentStatus === "Busy"
      ) {
        if (!wasAbandoned && interaction.answeredAt) {
          agentState.agentStatus = "Wrapup";
          agentState.availableSince = null;
        } else {
          agentState.agentStatus = "Available";
          // Set available_since when agent becomes fully available
          agentState.availableSince = new Date();
        }
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
export async function updateAgentStatus(userId, status, username) {
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
      availableSince: status === "Available" ? new Date() : null,
      lastCallEndedAt: null,
      queueCallCounts: {},
      totalIdleSeconds: 0,
      totalHandleSeconds: 0,
      callsHandledToday: 0,
    };
    stateCache.agents.set(userId, agentState);
  } else {
    const previousStatus = agentState.agentStatus;
    agentState.agentStatus = status;
    agentState.lastStatusChange = new Date();
    agentState.lastActivity = new Date();
    if (username) {
      agentState.username = username;
    }

    // Check if current status is a break type (preserve idle time)
    const currentIsBreak = await isBreakStatus(status);
    const previousIsBreak = await isBreakStatus(previousStatus);

    // Clear available_since when agent leaves "Available" status
    // EXCEPT for break statuses - preserve idle time
    // Break statuses don't reset idle time since agent is just taking a break, not handling calls
    if (
      previousStatus === "Available" &&
      status !== "Available" &&
      !currentIsBreak
    ) {
      agentState.availableSince = null;
    }

    // Set available_since when status changes to "Available"
    // Rules:
    // 1. Reset ONLY when transitioning from "Wrapup" to "Available" (after handling a call)
    // 2. Preserve when transitioning from break statuses to "Available"
    // 3. For all other transitions to "Available", preserve existing available_since or set if null
    if (status === "Available") {
      if (previousStatus === "Available") {
        // Agent was already Available - ensure available_since is set if not already set
        // This handles cases where server restarted and agent was already Available
        if (!agentState.availableSince && agentState.currentCallsCount === 0) {
          agentState.availableSince = new Date();
        }
      } else if (previousStatus !== "Available") {
        // Status changed TO Available from another status
        if (previousStatus === "Wrapup") {
          // Reset available_since ONLY when transitioning from Wrapup to Available (after handling a call)
          agentState.availableSince = new Date();
        } else if (previousIsBreak && agentState.availableSince) {
          // Preserve existing available_since when coming from break statuses
          // Agent's idle time should continue (agent was just on break, not handling calls)
        } else {
          // For all other transitions to Available, preserve existing available_since or set if null
          if (
            !agentState.availableSince &&
            agentState.currentCallsCount === 0
          ) {
            agentState.availableSince = new Date();
          }
        }
      }
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
        (id) => !queueIds.includes(id),
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
 * Initializes available_since if agent is Available and it's missing
 */
export function getAgentState(userId) {
  const agentState = stateCache.agents.get(userId);

  // If agent is Available but doesn't have available_since set, initialize it
  if (
    agentState &&
    agentState.agentStatus === "Available" &&
    agentState.currentCallsCount === 0 &&
    !agentState.availableSince
  ) {
    agentState.availableSince = new Date();
    // Also update in database asynchronously
    const pool = getPostgresPool();
    if (pool) {
      pool
        .query(
          `UPDATE cc_agent_state 
         SET available_since = NOW() 
         WHERE user_id = $1 AND available_since IS NULL`,
          [userId],
        )
        .catch(() => {
          // Ignore errors
        });
    }
  }

  return agentState || null;
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
        Math.floor((nowMs - enqueuedAtMs) / 1000),
      );
      metrics.longestWaitSeconds = Math.max(
        metrics.longestWaitSeconds,
        waitSeconds,
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
    if (
      ["ringing", "answered", "connected", "active"].includes(interaction.state)
    ) {
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
        interaction.state,
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
      [queueId],
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
