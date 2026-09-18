function normalizeMetrics(row) {
  return {
    queuedCalls: Number(row?.queued_calls || 0),
    ringingCalls: Number(row?.ringing_calls || 0),
    waitingCalls: Number(row?.waiting_calls || 0),
    activeCalls: Number(row?.active_calls || 0),
    longestWaitSeconds: Number(row?.longest_wait_seconds || 0),
    avgWaitSeconds: Number(row?.avg_wait_seconds || 0),
  };
}

function normalizeAgentMetrics(row) {
  return {
    availableAgents: Number(row?.available_agents || 0),
    busyAgents: Number(row?.busy_agents || 0),
    totalActiveAgents: Number(row?.total_active_agents || 0),
  };
}

async function getAcdQueueMetrics(db, queueId) {
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE w.state = 'queued')::int AS queued_calls,
       COUNT(*) FILTER (WHERE w.state = 'offered')::int AS ringing_calls,
       COUNT(*) FILTER (WHERE w.state IN ('queued', 'offered'))::int AS waiting_calls,
       COUNT(*) FILTER (WHERE w.state = 'active')::int AS active_calls,
       COALESCE(MAX(EXTRACT(EPOCH FROM (
         now() - COALESCE(wait_segment.started_at, w.enqueued_at, w.created_at)
       ))) FILTER (WHERE w.state IN ('queued', 'offered')), 0)::int AS longest_wait_seconds,
       COALESCE(AVG(EXTRACT(EPOCH FROM (
         now() - COALESCE(wait_segment.started_at, w.enqueued_at, w.created_at)
       ))) FILTER (WHERE w.state IN ('queued', 'offered')), 0)::numeric(10,2) AS avg_wait_seconds
     FROM acd_work_items w
     LEFT JOIN LATERAL (
       SELECT s.started_at
         FROM acd_segments s
        WHERE s.work_item_id = w.id
          AND s.kind = 'queue_wait'
          AND s.queue_id = $1
          AND s.ended_at IS NULL
        ORDER BY s.seq DESC
        LIMIT 1
     ) wait_segment ON true
    WHERE w.queue_id = $1
      AND w.terminal_at IS NULL
      AND w.state IN ('queued', 'offered', 'active')`,
    [queueId],
  );
  return normalizeMetrics(result.rows[0]);
}

/** Realtime queue metrics come only from active Core work items. */
export async function getDurableQueueMetrics(db, queueId) {
  return getAcdQueueMetrics(db, queueId);
}

async function getAcdQueueAgentMetrics(db, queueId) {
  const result = await db.query(
    `SELECT
       COUNT(DISTINCT ast.agent_id) FILTER (
         WHERE ast.presence = 'online'
           AND ast.routability = 'routable'
           AND ast.workflow_state = 'idle'
           AND NOT EXISTS (
             SELECT 1
               FROM acd_reservations r
              WHERE r.agent_id = ast.agent_id
                AND r.state <> 'released'
                AND (r.state = 'active' OR r.lease_expires_at > now())
           )
       )::int AS available_agents,
       COUNT(DISTINCT ast.agent_id) FILTER (
         WHERE ast.presence = 'online'
           AND (
             ast.workflow_state IN ('offered', 'handling')
             OR EXISTS (
               SELECT 1
                 FROM acd_reservations r
                WHERE r.agent_id = ast.agent_id
                  AND r.state <> 'released'
                  AND (r.state = 'active' OR r.lease_expires_at > now())
             )
           )
       )::int AS busy_agents,
       COUNT(DISTINCT ast.agent_id) FILTER (
         WHERE ast.presence = 'online'
       )::int AS total_active_agents
     FROM cc_queue_user_assignments qa
     JOIN acd_agent_state ast ON ast.agent_id = qa.user_id
    WHERE qa.queue_id = $1
      AND qa.enabled = true
      AND qa.activated_at IS NOT NULL
      AND qa.deactivated_at IS NULL`,
    [queueId],
  );
  return normalizeAgentMetrics(result.rows[0]);
}

/** Agent supply measured with the same Core capacity semantics as routing. */
export async function getDurableQueueAgentMetrics(db, queueId) {
  return getAcdQueueAgentMetrics(db, queueId);
}

/** Core agent totals without counting one agent once per assigned queue. */
export async function getDurableOverallAgentMetrics(db) {
  const result = await db.query(`
    SELECT
      COUNT(DISTINCT u.id) FILTER (WHERE EXISTS (
        SELECT 1
          FROM cc_queue_user_assignments qa
          JOIN cc_queues q ON q.id = qa.queue_id AND q.enabled = true
         WHERE qa.user_id = u.id
           AND qa.enabled = true
           AND qa.activated_at IS NOT NULL
           AND qa.deactivated_at IS NULL
           AND core.presence = 'online'
               AND core.routability = 'routable'
               AND core.workflow_state = 'idle'
               AND NOT EXISTS (
                 SELECT 1 FROM acd_reservations r
                  WHERE r.agent_id = u.id
                    AND r.state <> 'released'
                    AND (r.state = 'active' OR r.lease_expires_at > now())
               )
      ))::int AS available_agents,
      COUNT(DISTINCT u.id) FILTER (WHERE EXISTS (
        SELECT 1
          FROM cc_queue_user_assignments qa
          JOIN cc_queues q ON q.id = qa.queue_id AND q.enabled = true
         WHERE qa.user_id = u.id
           AND qa.enabled = true
           AND qa.activated_at IS NOT NULL
           AND qa.deactivated_at IS NULL
           AND core.presence = 'online'
               AND (core.workflow_state IN ('offered', 'handling') OR EXISTS (
                 SELECT 1 FROM acd_reservations r
                  WHERE r.agent_id = u.id
                    AND r.state <> 'released'
                    AND (r.state = 'active' OR r.lease_expires_at > now())
               ))
      ))::int AS busy_agents,
      COUNT(DISTINCT u.id) FILTER (WHERE EXISTS (
        SELECT 1
          FROM cc_queue_user_assignments qa
          JOIN cc_queues q ON q.id = qa.queue_id AND q.enabled = true
         WHERE qa.user_id = u.id
           AND qa.enabled = true
           AND qa.activated_at IS NOT NULL
           AND qa.deactivated_at IS NULL
           AND core.presence = 'online'
      ))::int AS total_active_agents,
      COUNT(DISTINCT u.id) FILTER (WHERE EXISTS (
        SELECT 1 FROM cc_queue_user_assignments qa
         WHERE qa.user_id = u.id
           AND qa.enabled = true
           AND qa.activated_at IS NOT NULL
           AND qa.deactivated_at IS NULL
      ))::int AS total_agents
    FROM users u
    LEFT JOIN acd_agent_state core ON core.agent_id = u.id
  `);
  const row = result.rows[0] || {};
  return {
    ...normalizeAgentMetrics(row),
    totalAgents: Number(row.total_agents || 0),
  };
}

/** Core totals for the supervisor overview cards. */
export async function getDurableOverallQueueMetrics(db) {
  const result = await db.query(
    `SELECT
         COUNT(*) FILTER (WHERE w.state IN ('queued', 'offered'))::int AS waiting_calls,
         COUNT(*) FILTER (WHERE w.state = 'active')::int AS active_calls
       FROM acd_work_items w
       JOIN cc_queues q ON q.id = w.queue_id
      WHERE q.enabled = true
        AND w.terminal_at IS NULL
        AND w.state IN ('queued', 'offered', 'active')`,
  );
  return {
    waitingCalls: Number(result.rows[0]?.waiting_calls || 0),
    activeCalls: Number(result.rows[0]?.active_calls || 0),
  };
}
