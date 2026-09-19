import { channelDefinition } from "./channel-registry.mjs";
import { interactionCapabilities } from "./interaction-channels.mjs";
import { skillRequirements } from "./skills.mjs";

const STATE_MAP = Object.freeze({
  open: "open",
  queued: "queued",
  offered: "ringing",
  active: "connected",
});

function waitingReason(payload) {
  const pending = Array.isArray(payload?.pending_statuses) ? payload.pending_statuses : [];
  const effective = Array.isArray(payload?.blocked_by_status) ? payload.blocked_by_status : [];
  switch (payload?.reason) {
    case "agent_not_routable":
      return pending.length
        ? `Agent status blocks offers (${pending.join(", ")} pending)`
        : effective.length
          ? `Agent status blocks offers (${effective.join(", ")})`
          : "Agents not routable";
    case "channel_disabled":
      return "Channel disabled for agent";
    case "channel_limit_reached":
      return "Agent channel limit reached";
    case "not_eligible":
      return "Agent not eligible";
    case "no_queue_members_online":
      return "No agents online";
    case "no_free_capacity":
      return "No agent capacity";
    case "agent_in_wrapup":
      return "Agent in wrap-up";
    case "agent_already_offered":
      return "Agent handling another offer";
    case "agent_handling_call":
      return "Agent handling another interaction";
    case "agent_not_idle":
      return "Agent not ready";
    case "all_reservations_failed":
      return "Agent reservation unavailable";
    case "no_skill_match":
      return "No agent matches the required skills";
    default:
      return "No agents available";
  }
}

/** Non-terminal call rows for an ACD-owned queue's supervisor accordion. */
export function getAcdRealtimeQueueCalls(db, queueId, options = {}) {
  return readRealtimeInteractions(db, { ...options, queueId });
}

// One projection for queue, agent and global monitoring. A null limit is used
// by the global view so that no live interaction is silently truncated.
export async function readRealtimeInteractions(db, { queueId = null, agentId = null, channel = null, limit = 1000, includeWrapup = true } = {}) {
  const result = await db.query(
    `SELECT
       w.id,
       (SELECT jsonb_build_object('state',m.state,'at_risk',m.at_risk,'deadline_at',m.deadline_at,'served_at',m.served_at,'ended_at',m.ended_at,'excluded_reason',m.excluded_reason,'policy',m.policy) FROM acd_sla_status m WHERE m.work_item_id=w.id AND (m.segment_id IS NULL OR m.segment_id=(SELECT id FROM acd_segments WHERE work_item_id=w.id AND kind='queue_wait' ORDER BY seq DESC LIMIT 1)) ORDER BY m.started_at DESC LIMIT 1) AS sla,
       w.state, w.channel, w.direction, w.conversation_id, w.terminal_at, w.attributes,
       assignment.agent_id AS text_agent_id,assignment.state AS assignment_state,
       (SELECT customer_name FROM acd_conversations WHERE id=w.conversation_id) AS customer_name,
       (SELECT started_at FROM acd_segments WHERE work_item_id=w.id AND kind='queue_wait' ORDER BY seq DESC LIMIT 1) AS queue_entered_at,
       (SELECT ended_at FROM acd_segments WHERE work_item_id=w.id AND kind='queue_wait' ORDER BY seq DESC LIMIT 1) AS queue_left_at,
       w.customer_address,
       w.cc_address,
       w.queue_id,
       w.required_skills,
       w.priority,
       w.enqueued_at,
       w.created_at,
       customer_leg.provider_call_id AS customer_call_control_id,
       customer_leg.provider_session_id AS customer_call_session_id,
       agent_leg.provider_call_id AS agent_call_control_id,
       agent_segment.agent_id AS segment_agent_id,
       agent_segment.started_at AS answered_at,
       agent_segment.ended_at AS handling_ended_at,
       latest_offer.agent_id AS offered_agent_id,
       routing_event.payload AS routing_event_payload,
       u.id AS resolved_agent_id,
       u.username AS agent_username,
       u.first_name,
       u.last_name
     FROM acd_work_items w
     LEFT JOIN LATERAL (SELECT a.agent_id,a.state FROM acd_text_assignments a JOIN acd_segments s ON s.id=a.segment_id
       WHERE a.work_item_id=w.id AND ($2::text IS NULL OR a.agent_id=$2) AND a.state IN ('active','wrapup')
         AND s.outcome IS DISTINCT FROM 'transferred'
       ORDER BY (a.state='active') DESC,s.seq DESC LIMIT 1) assignment ON true
     LEFT JOIN LATERAL (
       SELECT l.provider_call_id, l.provider_session_id
         FROM acd_legs l
        WHERE l.work_item_id = w.id AND l.role = 'customer'
        ORDER BY (l.ended_at IS NULL) DESC, l.created_at DESC
        LIMIT 1
     ) customer_leg ON true
     LEFT JOIN LATERAL (
       SELECT l.provider_call_id
         FROM acd_legs l
        WHERE l.work_item_id = w.id
          AND l.role = 'agent_device' AND ($2::text IS NULL OR l.agent_id=$2)
          AND l.ended_at IS NULL
        ORDER BY l.created_at DESC
        LIMIT 1
     ) agent_leg ON true
     LEFT JOIN LATERAL (
       SELECT s.agent_id, COALESCE(s.answered_at,s.started_at) AS started_at,s.ended_at
         FROM acd_segments s
        WHERE s.work_item_id = w.id AND s.kind = 'agent' AND ($2::text IS NULL OR s.agent_id=$2) AND (s.ended_at IS NULL OR (assignment.state='wrapup' AND s.agent_id=assignment.agent_id))
        ORDER BY s.seq DESC
        LIMIT 1
     ) agent_segment ON true
     LEFT JOIN LATERAL (
       SELECT o.agent_id
         FROM acd_offers o
        WHERE o.work_item_id = w.id AND ($2::text IS NULL OR o.agent_id=$2) AND o.state IN ('created','ringing')
        ORDER BY o.generation DESC
        LIMIT 1
     ) latest_offer ON true
     LEFT JOIN LATERAL (
       SELECT r.agent_id FROM acd_reservations r
       WHERE r.work_item_id=w.id AND ($2::text IS NULL OR r.agent_id=$2)
         AND r.state<>'released'
         AND (r.state='active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at>now())
       ORDER BY r.created_at,r.id LIMIT 1
     ) reservation_owner ON true
     LEFT JOIN LATERAL (
       SELECT e.payload
         FROM acd_events e
        WHERE e.work_item_id = w.id AND e.type = 'no_agent_reserved'
        ORDER BY e.id DESC
        LIMIT 1
     ) routing_event ON true
     LEFT JOIN users u ON u.id = COALESCE($2::text, CASE
       WHEN assignment.state = 'wrapup' THEN assignment.agent_id
       WHEN w.state = 'active' THEN COALESCE(agent_segment.agent_id,assignment.agent_id,reservation_owner.agent_id)
       WHEN w.state = 'offered' THEN COALESCE(latest_offer.agent_id,reservation_owner.agent_id)
       ELSE reservation_owner.agent_id
     END)
    WHERE ($1::text IS NULL OR w.queue_id=$1)
      AND ($1::text IS NULL OR w.state<>'open')
      AND ($3::text IS NULL OR w.channel=$3)
      AND ($2::text IS NULL OR agent_segment.agent_id IS NOT NULL OR latest_offer.agent_id IS NOT NULL OR assignment.agent_id=$2
        OR EXISTS (SELECT 1 FROM acd_reservations r WHERE r.work_item_id=w.id AND r.agent_id=$2 AND r.state<>'released'
          AND (r.state='active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at>now())))
      AND ((w.terminal_at IS NULL AND w.state IN ('open', 'queued', 'offered', 'active')) OR ($5::boolean AND assignment.state='wrapup'))
    ORDER BY w.created_at ASC,w.id
    LIMIT $4`,
    [queueId, agentId, channel, limit === null ? null : Math.min(Math.max(Number(limit) || 1000, 1), 1000), includeWrapup],
  );

  return mapRealtimeRows(result.rows);
}

function mapRealtimeRows(rows) {
  const now = Date.now();
  return rows.map((row) => {
    const assigned = Boolean(row.resolved_agent_id);
    const agentId = row.resolved_agent_id || (row.assignment_state === "wrapup" ? row.text_agent_id : row.state === "offered" ? row.offered_agent_id : row.state === "active" ? row.segment_agent_id : null);
    const answeredAt = row.answered_at;
    const enqueuedAt = row.queue_entered_at || row.enqueued_at || (row.queue_id ? row.created_at : null);
    const waitEndedAt = row.queue_left_at || answeredAt || row.terminal_at;
    const waitEnd = waitEndedAt ? new Date(waitEndedAt).getTime() : now;
    const handlingEndedAt = row.handling_ended_at || row.terminal_at;
    const waitSeconds = enqueuedAt
      ? Math.max(0, Math.floor((waitEnd - new Date(enqueuedAt).getTime()) / 1000))
      : 0;
    const talkSeconds = answeredAt
      ? Math.max(0, Math.floor(((handlingEndedAt ? new Date(handlingEndedAt).getTime() : now) - new Date(answeredAt).getTime()) / 1000))
      : 0;

    return {
      id: String(row.id),
      sla: row.sla || (row.channel === "voice" && (!row.queue_id || row.direction !== "inbound")
        ? { state: "excluded", excluded_reason: "Queue-answer SLA applies to inbound queue visits" } : null),
      kind: row.attributes?.voice_occupancy_kind || (row.direction === "outbound" ? "outbound" : "inbound"),
      workItemId: String(row.id),
      channel: row.channel, conversationId: row.conversation_id, direction: row.direction, coreState: row.state,
      customerName: row.customer_name, customerAddress: row.customer_address,
      capabilities: interactionCapabilities({ channel: row.channel, conversationId: row.conversation_id, state: row.state, agentCallControlId: row.agent_call_control_id }),
      callControlId: row.customer_call_control_id,
      originalCallControlId: row.customer_call_control_id,
      agentCallControlId: assigned ? row.agent_call_control_id : null,
      supervisionCallControlId:
        (assigned ? row.agent_call_control_id : null) || row.customer_call_control_id,
      callSessionId: row.customer_call_session_id,
      fromNumber: row.direction === "outbound" ? row.cc_address : row.customer_address,
      toNumber: row.direction === "outbound" ? row.customer_address : row.cc_address,
      queueId: row.queue_id ? String(row.queue_id) : null,
      state: row.assignment_state === "wrapup" ? "wrapup" : channelDefinition(row.channel).family === "voice" ? STATE_MAP[row.state] || row.state : row.state,
      agentUsername: assigned ? row.agent_username : null,
      agentUserId: agentId,
      agentName:
        assigned && (row.first_name || row.last_name)
          ? `${row.first_name || ""} ${row.last_name || ""}`.trim()
          : assigned
            ? row.agent_username
            : null,
      enqueuedAt,
      waitEndedAt,
      handlingEndedAt,
      answeredAt,
      completedAt: row.terminal_at,
      abandonedAt: null,
      createdAt: row.created_at,
      updatedAt: row.created_at,
      waitSeconds: enqueuedAt ? waitSeconds : null,
      handlingSeconds: talkSeconds,
      talkSeconds: channelDefinition(row.channel).family === "voice" ? talkSeconds : null,
      requiredSkills: row.required_skills || {},
      priority: Number(row.priority) >= 1 && Number(row.priority) <= 5
        ? Number(row.priority)
        : null,
      routingMetadata: {
        acd: row.routing_event_payload || null,
      },
      waitingReason: row.state === "queued"
        ? waitingReason(row.routing_event_payload)
        : null,
    };
  });
}

/** Non-terminal calls assigned or offered to one agent, including queue-less calls. */
export function getAcdRealtimeAgentCalls(db, agentId, options = {}) {
  return readRealtimeInteractions(db, { ...options, agentId });
}

/**
 * Adds queue labels and the same derived skill-relaxation details to realtime
 * calls regardless of whether they are viewed from the queue or agent panel.
 */
export async function enrichAcdRealtimeCalls(db, calls, { queues = [] } = {}) {
  const queueById = new Map(
    queues
      .filter((queue) => queue?.id != null)
      .map((queue) => [String(queue.id), queue]),
  );
  const missingQueueIds = [
    ...new Set(
      calls
        .map((call) => call.queueId)
        .filter((queueId) => queueId && !queueById.has(String(queueId)))
        .map(String),
    ),
  ];

  if (missingQueueIds.length > 0) {
    const result = await db.query(
      `SELECT id, name, display_name, skill_requirements, skill_relaxation_enabled,
              skill_relaxation_after_seconds, skill_relaxation_strategy
         FROM cc_queues
        WHERE id = ANY($1::text[])`,
      [missingQueueIds],
    );
    for (const queue of result.rows) queueById.set(String(queue.id), queue);
  }

  const enriched = calls.map((call) => {
    const queue = call.queueId ? queueById.get(String(call.queueId)) || {} : {};
    const skills = skillRequirements(
      {
        required_skills: call.requiredSkills || {},
        enqueued_at: call.enqueuedAt,
        attributes: {},
      },
      { queue },
    );
    return {
      ...call,
      queueName: queue.display_name || queue.name || null,
      requiredSkills: skills.original,
      relaxedSkills: skills.relaxation.due ? skills.effective : null,
      isRelaxed:
        skills.relaxation.due &&
        JSON.stringify(skills.original) !== JSON.stringify(skills.effective),
    };
  });

  const skillKeys = [
    ...new Set(
      enriched.flatMap((call) => Object.keys(call.requiredSkills || {})),
    ),
  ];
  const skillNames = new Map();
  if (skillKeys.length > 0) {
    const result = await db.query(
      "SELECT id, name FROM skills WHERE id = ANY($1::text[])",
      [skillKeys],
    );
    for (const skill of result.rows) skillNames.set(skill.id, skill.name);
  }

  return enriched.map((call) => ({
    ...call,
    skillNames: Object.fromEntries(
      Object.keys(call.requiredSkills || {}).map((key) => [
        key,
        skillNames.get(key) || key,
      ]),
    ),
  }));
}
