import { parseChannel } from "./interaction-channels.mjs";
import { enrichAcdRealtimeCalls, readRealtimeInteractions } from "./realtime-queue-calls.mjs";
import { readLiveInboundFlows } from "./live-inbound-flows.mjs";

/** Live Core work plus logical consultation/transfer legs; transport pairs count once. */
export async function readLiveInteractions(db, { channel: requestedChannel = "all" } = {}) {
  const channel = parseChannel(requestedChannel);
  const interactions = await readRealtimeInteractions(db, { channel, limit: null, includeWrapup: false });
  const inboundFlows = !channel || channel === "voice" ? await readLiveInboundFlows(db, interactions) : [];
  const legs = channel && channel !== "voice" ? { rows: [] } : await db.query(`
    SELECT DISTINCT ON (l.work_item_id,COALESCE(l.owner_saga_id,l.id),split_part(l.role,'_',1))
      l.*,s.data->>'target' AS target,s.data->>'targetLabel' AS target_label,
      COALESCE(l.agent_id,s.data->>'targetAgentId') AS target_agent_id,
      u.username,u.first_name,u.last_name
    FROM acd_legs l JOIN acd_work_items w ON w.id=l.work_item_id
    LEFT JOIN acd_sagas s ON s.id=l.owner_saga_id
    LEFT JOIN users u ON u.id=COALESCE(l.agent_id,s.data->>'targetAgentId')
    WHERE w.terminal_at IS NULL AND l.ended_at IS NULL AND l.state<>'ended'
      AND l.role IN ('consult_target','consult_transport','transfer_target','transfer_transport','supervisor')
    ORDER BY l.work_item_id,COALESCE(l.owner_saga_id,l.id),split_part(l.role,'_',1),
      CASE WHEN l.role LIKE '%_transport' THEN 1 ELSE 0 END,l.created_at,l.id`);
  const parents = new Map(interactions.map(row => [row.workItemId, row]));
  for (const leg of legs.rows) {
    const parent = parents.get(leg.work_item_id);
    if (!parent) continue;
    interactions.push({
      ...parent,
      id: `leg:${leg.id}`,
      legId: leg.id,
      kind: leg.role.startsWith("consult") ? "consultation" : leg.role.startsWith("transfer") ? "transfer" : "supervision",
      parentInteractionId: parent.workItemId,
      state: leg.state,
      coreState: leg.state,
      customerName: null,
      fromNumber: parent.agentName || parent.agentUsername || parent.fromNumber,
      toNumber: leg.target_label || leg.target || leg.username || "—",
      agentUserId: leg.target_agent_id,
      agentUsername: leg.username,
      agentName: [leg.first_name, leg.last_name].filter(Boolean).join(" ") || leg.username,
      createdAt: leg.created_at,
      answeredAt: leg.answered_at,
      enqueuedAt: null,
      waitSeconds: null,
      waitEndedAt: null,
      handlingEndedAt: null,
      waitingReason: null,
      requiredSkills: {},
      priority: null,
      callControlId: leg.provider_call_id,
      callSessionId: leg.provider_session_id,
      agentCallControlId: null,
      supervisionCallControlId: null,
      // The call supervision endpoint targets the parent bridge. Never send a
      // consultation there: its eye opens read-only details of this exact leg.
      capabilities: { conversation: false, supervision: false },
      sla: { state: "excluded", excluded_reason: "Consultation, transfer and supervision legs do not start a customer SLA measurement" },
    });
  }
  const legCount = interactions.length - parents.size;
  const rows = await enrichAcdRealtimeCalls(db, [...interactions, ...inboundFlows]);
  rows.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  return {
    interactions: rows,
    totals: { interactions: parents.size + inboundFlows.length, legs: legCount, rows: rows.length },
    timestamp: new Date().toISOString(),
  };
}
