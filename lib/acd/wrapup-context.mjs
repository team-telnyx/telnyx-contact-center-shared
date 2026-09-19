export function getAcdWorkItemId(interaction) {
  return interaction?.work_item_id || interaction?.id || null;
}

export async function findPendingAcdWrapupSegment(
  db,
  { workItemId, agentId, segmentId = null, forUpdate = false } = {},
) {
  if (!db || !workItemId || !agentId) return null;
  const result = await db.query(
    `SELECT s.*, w.state AS work_item_state, w.terminal_at, q.name AS queue_name
       FROM acd_segments s
       JOIN acd_work_items w ON w.id = s.work_item_id
       LEFT JOIN cc_queues q ON q.id = s.queue_id
      WHERE s.work_item_id = $1
        AND s.agent_id = $2
        AND ($3::text IS NULL OR s.id::text = $3)
        AND s.kind = 'agent'
        AND s.ended_at IS NOT NULL
        AND s.wrapup_ended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM acd_text_assignments a
          WHERE a.segment_id=s.id AND a.state<>'wrapup')
        AND s.outcome IN ('transferred', 'completed', 'failed')
      ORDER BY s.seq
      LIMIT 1
      ${forUpdate ? "FOR UPDATE OF s" : ""}`,
    [workItemId, agentId, segmentId],
  );
  return result.rows[0] || null;
}

export async function findPendingAcdWrapupForAgent(
  db,
  { agentId, interactionId = null, forUpdate = false } = {},
) {
  if (!db || !agentId) return null;
  const result = await db.query(
    `SELECT s.*, w.state AS work_item_state, w.terminal_at,
            w.id::text AS interaction_id,
            q.name AS queue_name, w.outbound_attempt_id, w.customer_address,
            ol.campaign_id AS outbound_campaign_id, ol.released_at AS outbound_released_at
       FROM acd_segments s
       JOIN acd_work_items w ON w.id = s.work_item_id
       JOIN acd_agent_state ast ON ast.agent_id = s.agent_id
       LEFT JOIN cc_queues q ON q.id = s.queue_id
       LEFT JOIN acd_outbound_lines ol ON ol.attempt_id = w.outbound_attempt_id
      WHERE s.agent_id = $1
        AND ($2::text IS NULL AND ast.workflow_state = 'wrapup' OR $2::text = w.id::text)
        AND ($2::text IS NOT NULL OR ast.workflow_work_item_id IS NULL OR ast.workflow_work_item_id=w.id)
        AND s.kind = 'agent'
        AND s.ended_at IS NOT NULL
        AND s.wrapup_ended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM acd_text_assignments a
          WHERE a.segment_id=s.id AND a.state<>'wrapup')
        AND s.outcome IN ('transferred', 'completed', 'failed')
      ORDER BY s.ended_at DESC, s.seq DESC
      LIMIT 1
      ${forUpdate ? "FOR UPDATE OF s" : ""}`,
    [String(agentId), interactionId],
  );
  return result.rows[0] || null;
}
