/**
 * Workflow Engine
 * 
 * Manages workflow session lifecycle, state transitions, and provides
 * helper functions for workflow operations.
 */

import { getPostgresPool } from "@/lib/postgres.mjs";

/**
 * Get complete workflow session state
 * @param {string} sessionId - Workflow session ID
 * @returns {Promise<Object|null>} Session state or null
 */
export async function getWorkflowSessionState(sessionId) {
  const pool = getPostgresPool();
  if (!pool) return null;

  // Get session with workflow info
  const { rows: [session] } = await pool.query(
    `SELECT s.*, w.name as workflow_name, w.category as workflow_category
     FROM aa_workflow_sessions s
     JOIN aa_workflows w ON s.workflow_id = w.id
     WHERE s.id = $1`,
    [sessionId]
  );

  if (!session) return null;

  // Get stages
  const { rows: stages } = await pool.query(
    `SELECT * FROM aa_workflow_stages 
     WHERE workflow_id = $1 
     ORDER BY order_index`,
    [session.workflow_id]
  );

  // Get all items
  const stageIds = stages.map((s) => s.id);
  let items = [];
  if (stageIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT * FROM aa_workflow_items WHERE stage_id = ANY($1) ORDER BY stage_id, order_index`,
      [stageIds]
    );
    items = rows;
  }

  // Get item statuses
  const { rows: itemStatuses } = await pool.query(
    `SELECT * FROM aa_workflow_item_status WHERE session_id = $1`,
    [sessionId]
  );

  // Create status map
  const statusMap = itemStatuses.reduce((acc, status) => {
    acc[status.item_id] = status;
    return acc;
  }, {});

  // Attach items to stages
  const itemsByStage = items.reduce((acc, item) => {
    if (!acc[item.stage_id]) acc[item.stage_id] = [];
    acc[item.stage_id].push({
      ...item,
      status: statusMap[item.id] || { status: "pending" },
    });
    return acc;
  }, {});

  stages.forEach((stage) => {
    stage.items = itemsByStage[stage.id] || [];
  });

  // Calculate stats
  const currentStageIndex = stages.findIndex((s) => s.id === session.current_stage_id);
  const totalItems = items.length;
  const completedItems = itemStatuses.filter((s) => s.status === "completed").length;
  const skippedItems = itemStatuses.filter((s) => s.status === "skipped").length;
  const pendingItems = totalItems - completedItems - skippedItems;
  const completionPercentage = totalItems > 0
    ? Math.round((completedItems / totalItems) * 100)
    : 0;

  return {
    ...session,
    stages,
    currentStageIndex: currentStageIndex >= 0 ? currentStageIndex : 0,
    totalItems,
    completedItems,
    skippedItems,
    pendingItems,
    completionPercentage,
  };
}

/**
 * Find workflow session by interaction ID
 * @param {string} interactionId - Interaction ID
 * @returns {Promise<Object|null>} Session or null
 */
export async function findWorkflowSessionByInteraction(interactionId) {
  const pool = getPostgresPool();
  if (!pool) return null;

  const { rows: [session] } = await pool.query(
    `SELECT * FROM aa_workflow_sessions WHERE interaction_id = $1`,
    [interactionId]
  );

  return session || null;
}

/**
 * Advance to next stage
 * @param {string} sessionId - Session ID
 * @returns {Promise<Object>} Updated session state
 */
export async function advanceToNextStage(sessionId) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Database not configured");

  const sessionState = await getWorkflowSessionState(sessionId);
  if (!sessionState) throw new Error("Session not found");

  const currentIndex = sessionState.currentStageIndex;
  const nextIndex = currentIndex + 1;

  if (nextIndex >= sessionState.stages.length) {
    throw new Error("Already at last stage");
  }

  const nextStage = sessionState.stages[nextIndex];

  await pool.query(
    `UPDATE aa_workflow_sessions 
     SET current_stage_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [nextStage.id, sessionId]
  );

  return getWorkflowSessionState(sessionId);
}

/**
 * Go to previous stage
 * @param {string} sessionId - Session ID
 * @returns {Promise<Object>} Updated session state
 */
export async function goToPreviousStage(sessionId) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Database not configured");

  const sessionState = await getWorkflowSessionState(sessionId);
  if (!sessionState) throw new Error("Session not found");

  const currentIndex = sessionState.currentStageIndex;
  const prevIndex = currentIndex - 1;

  if (prevIndex < 0) {
    throw new Error("Already at first stage");
  }

  const prevStage = sessionState.stages[prevIndex];

  await pool.query(
    `UPDATE aa_workflow_sessions 
     SET current_stage_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [prevStage.id, sessionId]
  );

  return getWorkflowSessionState(sessionId);
}

/**
 * Go to specific stage by index
 * @param {string} sessionId - Session ID
 * @param {number} stageIndex - Stage index (0-based)
 * @returns {Promise<Object>} Updated session state
 */
export async function goToStage(sessionId, stageIndex) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Database not configured");

  const sessionState = await getWorkflowSessionState(sessionId);
  if (!sessionState) throw new Error("Session not found");

  if (stageIndex < 0 || stageIndex >= sessionState.stages.length) {
    throw new Error("Invalid stage index");
  }

  const targetStage = sessionState.stages[stageIndex];

  await pool.query(
    `UPDATE aa_workflow_sessions 
     SET current_stage_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [targetStage.id, sessionId]
  );

  return getWorkflowSessionState(sessionId);
}

/**
 * Complete workflow session
 * @param {string} sessionId - Session ID
 * @returns {Promise<Object>} Updated session
 */
export async function completeWorkflowSession(sessionId) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Database not configured");

  const { rows: [session] } = await pool.query(
    `UPDATE aa_workflow_sessions 
     SET status = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [sessionId]
  );

  return session;
}

/**
 * Abandon workflow session
 * @param {string} sessionId - Session ID
 * @returns {Promise<Object>} Updated session
 */
export async function abandonWorkflowSession(sessionId) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Database not configured");

  const { rows: [session] } = await pool.query(
    `UPDATE aa_workflow_sessions 
     SET status = 'abandoned', completed_at = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [sessionId]
  );

  return session;
}

/**
 * Get pending items for a session
 * @param {string} sessionId - Session ID
 * @param {boolean} currentStageOnly - Only get items from current stage
 * @returns {Promise<Array>} Array of pending items
 */
export async function getPendingItems(sessionId, currentStageOnly = false) {
  const pool = getPostgresPool();
  if (!pool) return [];

  const { rows: [session] } = await pool.query(
    `SELECT * FROM aa_workflow_sessions WHERE id = $1`,
    [sessionId]
  );

  if (!session) return [];

  let query = `
    SELECT 
      i.id as item_id,
      i.type,
      i.label,
      i.prompt_hint,
      i.slot_name,
      i.slot_type,
      i.slot_validation,
      s.id as stage_id,
      s.name as stage_name,
      s.order_index as stage_order,
      ist.status as current_status
    FROM aa_workflow_items i
    JOIN aa_workflow_stages s ON i.stage_id = s.id
    JOIN aa_workflow_item_status ist ON ist.item_id = i.id AND ist.session_id = $1
    WHERE s.workflow_id = $2 
      AND ist.status = 'pending'
  `;

  const params = [sessionId, session.workflow_id];

  if (currentStageOnly && session.current_stage_id) {
    query += ` AND s.id = $3`;
    params.push(session.current_stage_id);
  }

  query += ` ORDER BY s.order_index, i.order_index`;

  const { rows } = await pool.query(query, params);
  return rows;
}

/**
 * Check if workflow should auto-start for a queue
 * @param {string} queueId - Queue ID
 * @returns {Promise<Object|null>} Workflow or null
 */
export async function getQueueWorkflow(queueId) {
  const pool = getPostgresPool();
  if (!pool) return null;

  const { rows: [queue] } = await pool.query(
    `SELECT q.workflow_id, w.id, w.name, w.is_active
     FROM cc_queues q
     LEFT JOIN aa_workflows w ON q.workflow_id = w.id
     WHERE q.id = $1`,
    [queueId]
  );

  if (!queue?.workflow_id || !queue.is_active) {
    return null;
  }

  return {
    id: queue.id,
    name: queue.name,
    is_active: queue.is_active,
  };
}
