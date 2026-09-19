/**
 * Voice flows own inbound calls before enqueue. Read their existing execution
 * ledger rather than creating a second routing work item at call.initiated.
 */
export async function readLiveInboundFlows(db, coreRows) {
  const present = (await db.query("SELECT to_regclass('public.voice_flow_executions') AS present")).rows[0]?.present;
  if (!present) return [];
  const calls = coreRows.filter(row => row.channel === "voice");
  const callIds = calls.flatMap(row => [row.callControlId, row.agentCallControlId]).filter(Boolean);
  const sessions = calls.map(row => row.callSessionId).filter(Boolean);
  const result = await db.query(`
    SELECT DISTINCT ON (e.call_control_id) e.id,e.flow_id,e.call_control_id,e.started_at,e.status,e.completed_at,
      e.variables->>'call_session_id' AS call_session_id,
      COALESCE(e.variables->>'from',e.variables#>>'{payload,from}') AS from_address,
      COALESCE(e.variables->>'to',e.variables#>>'{payload,to}') AS to_address,
      e.variables->>'event_type' AS event_type,
      core.id AS core_id,core.terminal_at AS core_terminal_at
    FROM voice_flow_executions e
    LEFT JOIN LATERAL (
      SELECT w.id,w.terminal_at FROM acd_work_items w
      WHERE w.channel='voice' AND (
        w.provider_session_id=e.variables->>'call_session_id'
        OR EXISTS (SELECT 1 FROM acd_legs l WHERE l.work_item_id=w.id AND
          (l.provider_call_id=e.call_control_id OR l.provider_session_id=e.variables->>'call_session_id')))
      ORDER BY (w.terminal_at IS NULL) DESC,w.created_at DESC LIMIT 1
    ) core ON true
    WHERE COALESCE(e.variables->>'direction',e.variables#>>'{payload,direction}') IN ('incoming','inbound')
      AND ((e.status='active' AND e.completed_at IS NULL)
        OR e.call_control_id=ANY($1::text[]) OR e.variables->>'call_session_id'=ANY($2::text[]))
    ORDER BY e.call_control_id,e.started_at,e.id`, [callIds, sessions]);
  const added = [];
  for (const flow of result.rows) {
    const parent = calls.find(row => row.workItemId === flow.core_id || row.callControlId === flow.call_control_id || (flow.call_session_id && row.callSessionId === flow.call_session_id));
    if (parent) {
      // Queue arrival must not reset the age or duplicate an incoming call.
      if (Date.parse(flow.started_at) < Date.parse(parent.createdAt)) parent.createdAt = flow.started_at;
      parent.flowId = flow.flow_id;
      continue;
    }
    // A stale flow execution cannot resurrect a terminal Core interaction.
    if (flow.core_id || flow.completed_at || flow.status !== "active") continue;
    added.push({
      id: `flow:${flow.id}`, workItemId: null, flowId: flow.flow_id,
      channel: "voice", direction: "inbound", kind: "inbound_flow",
      state: flow.event_type === "call.initiated" ? "initiated" : "in_flow",
      createdAt: flow.started_at, callControlId: flow.call_control_id, callSessionId: flow.call_session_id,
      fromNumber: flow.from_address, toNumber: flow.to_address,
      queueId: null, enqueuedAt: null, answeredAt: null, waitSeconds: null, handlingSeconds: null,
      capabilities: { conversation: false, supervision: false }, requiredSkills: {}, priority: null,
      sla: { state: "excluded", excluded_reason: "Voice queue-answer SLA starts when the call enters a queue" },
    });
  }
  return added;
}
