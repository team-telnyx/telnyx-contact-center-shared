import { slaSummary } from "./sla-report-summary.mjs";
export { slaSummary } from "./sla-report-summary.mjs";
import { RELEASED_CHANNELS, channelDefinition } from "./channel-registry.mjs";
import { readSupervisorReportDetails } from "./supervisor-report-details.mjs";
import { interactionScopeSql } from "../authz/scope.mjs";
const number = (value) => (value == null ? null : Number(value));
/** Channels a report covers: the requested one (or all released) within the caller's scope. */
export function reportChannels(scope) {
  return scope.channels || (scope.channel ? [scope.channel] : RELEASED_CHANNELS);
}
/** `AND ...` narrowing work items (alias `w`) to the caller's data scope; empty when unrestricted. */
export function workItemRestrictionSql(scope, alias = "w") {
  return interactionScopeSql(scope.restriction, { queue: `${alias}.queue_id`, workItem: `${alias}.id`, channel: `${alias}.channel` }, null)
    .map((condition) => ` AND ${condition}`).join("");
}
export async function readInteractionReport(db, scope, report = "overview") {
  const persistedChannels = RELEASED_CHANNELS.filter(
    (id) => channelDefinition(id).serviceEvent === "human_message_persisted",
  )
    .map((id) => `'${id}'`)
    .join(",");
  const channels = reportChannels(scope);
  const args = [
    scope.from,
    scope.to,
    channels,
    scope.queueId,
    scope.agentId,
    scope.timezone,
    scope.bucket,
  ];
  // Queue and agent attribution use participation, never the last-agent display projection.
  // The caller's data scope (Phase 3a) is appended as literals: the report queries share fixed $1..$7 positions.
  const filter = `w.channel=ANY($3::text[]) AND ($4::text IS NULL OR ($4='none' AND w.queue_id IS NULL) OR EXISTS (
    SELECT 1 FROM acd_segments qs WHERE qs.work_item_id=w.id AND qs.queue_id=$4) OR w.queue_id=$4)
    AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM acd_segments own WHERE own.work_item_id=w.id AND own.agent_id=$5))${workItemRestrictionSql(scope)}`;
  const base = `WITH scoped AS (SELECT w.* FROM acd_work_items w WHERE ${filter}), closed AS (
    SELECT w.*,q.name AS queue_name,q.display_name AS queue_display_name,
      duration.handling_seconds,duration.talk_seconds,duration.wait_seconds,duration.transfers,
      EXTRACT(EPOCH FROM w.terminal_at-w.created_at) AS resolution_seconds,
      EXTRACT(EPOCH FROM service.served_at-w.created_at) AS response_seconds, own_response.seconds AS agent_response_seconds
    FROM scoped w LEFT JOIN cc_queues q ON q.id=w.queue_id
    LEFT JOIN LATERAL (SELECT SUM(EXTRACT(EPOCH FROM COALESCE(s.ended_at,w.terminal_at)-s.started_at)
        +CASE WHEN s.wrapup_ended_at IS NOT NULL THEN EXTRACT(EPOCH FROM s.wrapup_ended_at-s.ended_at) ELSE 0 END) FILTER(WHERE s.kind='agent' AND ($5::text IS NULL OR s.agent_id=$5) AND ($4::text IS NULL OR s.queue_id=$4 OR ($4='none' AND s.queue_id IS NULL))) AS handling_seconds,
      SUM(EXTRACT(EPOCH FROM COALESCE(s.ended_at,w.terminal_at)-s.answered_at)) FILTER(WHERE s.kind='agent' AND s.answered_at IS NOT NULL AND ($5::text IS NULL OR s.agent_id=$5) AND ($4::text IS NULL OR s.queue_id=$4 OR ($4='none' AND s.queue_id IS NULL))) AS talk_seconds,
      SUM(EXTRACT(EPOCH FROM COALESCE(s.ended_at,w.terminal_at)-s.started_at)) FILTER(WHERE s.kind='queue_wait' AND ($4::text IS NULL OR s.queue_id=$4 OR ($4='none' AND s.queue_id IS NULL))) AS wait_seconds,
      COUNT(*) FILTER(WHERE s.kind='agent' AND s.outcome='transferred' AND ($5::text IS NULL OR s.agent_id=$5) AND ($4::text IS NULL OR s.queue_id=$4 OR ($4='none' AND s.queue_id IS NULL))) AS transfers
      FROM acd_segments s WHERE s.work_item_id=w.id) duration ON true
    LEFT JOIN LATERAL (SELECT MIN(served_at) AS served_at FROM acd_sla_measurements m WHERE m.work_item_id=w.id) service ON true
    LEFT JOIN LATERAL (SELECT AVG(EXTRACT(EPOCH FROM reply.at-s.started_at)) AS seconds
      FROM acd_segments s CROSS JOIN LATERAL (
        SELECT MIN(CASE WHEN e.type='text_message_created' THEN m.created_at ELSE e.occurred_at END) AS at
        FROM acd_messages m JOIN acd_events e ON e.work_item_id=w.id AND e.payload->>'message_id'=m.id::text
        WHERE m.work_item_id=w.id AND m.sender_role='agent' AND m.sender_id=s.agent_id
          AND m.created_at>=s.started_at AND (s.ended_at IS NULL OR m.created_at<=s.ended_at)
          AND ((e.type='text_message_created' AND w.channel=ANY(ARRAY[${persistedChannels}]::text[]))
            OR (e.type IN ('email_send_updated','message_send_updated') AND e.payload->>'status'='accepted'))
      ) reply WHERE s.work_item_id=w.id AND s.kind='agent' AND $5::text IS NOT NULL AND s.agent_id=$5
        AND ($4::text IS NULL OR s.queue_id=$4 OR ($4='none' AND s.queue_id IS NULL))) own_response ON true
    WHERE w.terminal_at>=$1 AND w.terminal_at<$2)`;
  const results = await Promise.all([
    db.query(
      `${base} SELECT channel,COUNT(*)::int AS closed,COUNT(*) FILTER(WHERE state='completed')::int AS completed,
      COUNT(*) FILTER(WHERE state='abandoned')::int AS abandoned,COUNT(*) FILTER(WHERE state='failed')::int AS failed,
      AVG(wait_seconds) AS avg_wait_seconds,AVG(handling_seconds) AS avg_handling_seconds,AVG(talk_seconds) AS avg_talk_seconds,
      AVG(agent_response_seconds) AS avg_agent_response_seconds,COUNT(agent_response_seconds)::int AS agent_response_coverage,AVG(response_seconds) AS avg_response_seconds,COUNT(response_seconds)::int AS response_coverage,AVG(resolution_seconds) AS avg_resolution_seconds,SUM(transfers)::int AS transfers
      FROM closed GROUP BY channel`,
      args.slice(0, 5),
    ),
    db.query(
      `SELECT w.channel,COUNT(*) FILTER(WHERE w.created_at>=$1 AND w.created_at<$2)::int AS received,
      COUNT(*) FILTER(WHERE w.terminal_at IS NULL AND w.state IN ('open','queued'))::int AS waiting,
      COUNT(*) FILTER(WHERE w.terminal_at IS NULL AND w.state='offered')::int AS offered,
      COUNT(*) FILTER(WHERE w.terminal_at IS NULL AND w.state='active')::int AS active
      FROM acd_work_items w WHERE ${filter} GROUP BY w.channel`,
      args.slice(0, 5),
    ),
    db.query(
      `${base} SELECT to_char(date_trunc($7,terminal_at AT TIME ZONE $6),'YYYY-MM-DD HH24:MI') AS bucket,channel,
      COUNT(*)::int AS total,COUNT(*) FILTER(WHERE state='completed')::int AS completed FROM closed GROUP BY 1,2 ORDER BY 1,2`,
      args,
    ),
    db.query(
      `${base} SELECT visits.queue_id,COALESCE(q.display_name,q.name,'No queue') AS queue_name,c.channel,
      COUNT(DISTINCT c.id)::int AS total,COUNT(DISTINCT c.id) FILTER(WHERE c.state='completed')::int AS completed,
      COUNT(DISTINCT c.id) FILTER(WHERE c.state='abandoned')::int AS abandoned,COUNT(DISTINCT c.id) FILTER(WHERE c.state='failed')::int AS failed
      FROM closed c CROSS JOIN LATERAL (SELECT DISTINCT s.queue_id FROM acd_segments s WHERE s.work_item_id=c.id
        UNION SELECT c.queue_id WHERE NOT EXISTS(SELECT 1 FROM acd_segments s WHERE s.work_item_id=c.id AND s.queue_id IS NOT NULL)) visits
      LEFT JOIN cc_queues q ON q.id=visits.queue_id WHERE ($4::text IS NULL OR visits.queue_id=$4 OR ($4='none' AND visits.queue_id IS NULL))
      GROUP BY visits.queue_id,q.display_name,q.name,c.channel ORDER BY total DESC,queue_name`,
      args.slice(0, 5),
    ),
    db.query(
      `SELECT m.channel,m.state,COUNT(*)::int AS total,COUNT(*) FILTER(WHERE m.at_risk)::int AS at_risk,
      SUM((m.policy->>'targetPercentage')::numeric) AS target_sum FROM acd_sla_status m
      WHERE m.started_at>=$1 AND m.started_at<$2 AND m.channel=ANY($3::text[]) AND ($4::text IS NULL OR m.queue_id=$4 OR ($4='none' AND m.queue_id IS NULL))
      AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM acd_segments s WHERE s.work_item_id=m.work_item_id AND s.agent_id=$5)) GROUP BY m.channel,m.state`,
      args.slice(0, 5),
    ),
    db.query(
      `${base} SELECT w.channel,COUNT(*)::int AS total FROM closed w WHERE NOT EXISTS(SELECT 1 FROM acd_sla_measurements m WHERE m.work_item_id=w.id) GROUP BY w.channel`,
      args.slice(0, 5),
    ),
    db.query(
      `${base} SELECT s.agent_id,u.username,u.first_name,u.last_name,w.channel,COUNT(DISTINCT w.id)::int AS total,
      COUNT(DISTINCT w.id) FILTER(WHERE w.state='completed')::int AS completed,
      AVG(EXTRACT(EPOCH FROM s.ended_at-s.started_at)) AS avg_segment_seconds,
      COUNT(*) FILTER(WHERE s.outcome='transferred')::int AS transfers
      FROM closed w JOIN acd_segments s ON s.work_item_id=w.id AND s.kind='agent' LEFT JOIN users u ON u.id=s.agent_id
      WHERE ($5::text IS NULL OR s.agent_id=$5) AND ($4::text IS NULL OR s.queue_id=$4 OR ($4='none' AND s.queue_id IS NULL)) GROUP BY s.agent_id,u.username,u.first_name,u.last_name,w.channel ORDER BY total DESC`,
      args.slice(0, 5),
    ),
    db.query(
      `${base} SELECT s.wrapup_code_id,COALESCE(c.name,s.wrapup_code_id,'No disposition') AS name,w.channel,
      COUNT(DISTINCT w.id)::int AS interactions,COUNT(*)::int AS segments FROM closed w JOIN acd_segments s ON s.work_item_id=w.id AND s.kind='agent'
      LEFT JOIN cc_wrapup_codes c ON c.id=s.wrapup_code_id WHERE ($5::text IS NULL OR s.agent_id=$5) AND ($4::text IS NULL OR s.queue_id=$4 OR ($4='none' AND s.queue_id IS NULL))
      GROUP BY s.wrapup_code_id,c.name,w.channel ORDER BY interactions DESC`,
      args.slice(0, 5),
    ),
    db.query(
      `${base} SELECT w.id,w.channel,w.state,w.direction,w.customer_address,w.created_at,w.terminal_at,w.queue_name,
      w.handling_seconds,w.response_seconds FROM closed w ORDER BY w.terminal_at DESC LIMIT 100`,
      args.slice(0, 5),
    ),
    db.query(
      `SELECT m.channel,
      AVG(GREATEST(0,EXTRACT(EPOCH FROM COALESCE(m.served_at,m.ended_at,now())-m.deadline_at))) FILTER(WHERE m.state='breached') AS avg_lateness,
      percentile_cont(0.95) WITHIN GROUP(ORDER BY GREATEST(0,EXTRACT(EPOCH FROM COALESCE(m.served_at,m.ended_at,now())-m.deadline_at))) FILTER(WHERE m.state='breached') AS p95_lateness
      FROM acd_sla_status m JOIN acd_work_items w ON w.id=m.work_item_id
      WHERE m.started_at>=$1 AND m.started_at<$2 AND m.channel=ANY($3::text[]) AND ($4::text IS NULL OR m.queue_id=$4 OR ($4='none' AND m.queue_id IS NULL))
        AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM acd_segments s WHERE s.work_item_id=m.work_item_id AND s.agent_id=$5)) GROUP BY m.channel`,
      args.slice(0, 5),
    ),
    db.query(
      `SELECT to_char(date_trunc($7,m.started_at AT TIME ZONE $6),'YYYY-MM-DD HH24:MI') AS bucket,m.channel,
      COUNT(*) FILTER(WHERE m.state='met')::int AS met,COUNT(*) FILTER(WHERE m.state IN ('met','breached','unserved'))::int AS evaluated,
      COUNT(*) FILTER(WHERE m.state='breached')::int AS breached,COUNT(*) FILTER(WHERE m.state='pending')::int AS pending
      FROM acd_sla_status m WHERE m.started_at>=$1 AND m.started_at<$2 AND m.channel=ANY($3::text[]) AND ($4::text IS NULL OR m.queue_id=$4 OR ($4='none' AND m.queue_id IS NULL))
        AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM acd_segments s WHERE s.work_item_id=m.work_item_id AND s.agent_id=$5)) GROUP BY 1,2 ORDER BY 1,2`,
      args,
    ),
    db.query(
      `SELECT m.id,m.work_item_id,m.channel,m.queue_id,m.started_at,m.deadline_at,m.served_at,m.state,m.at_risk,m.policy,
      w.customer_address,w.terminal_at,w.state AS work_state,q.name AS queue_name FROM acd_sla_status m JOIN acd_work_items w ON w.id=m.work_item_id LEFT JOIN cc_queues q ON q.id=m.queue_id
      WHERE m.started_at>=$1 AND m.started_at<$2 AND m.channel=ANY($3::text[]) AND (m.state IN ('breached','unserved') OR m.at_risk)
      AND ($4::text IS NULL OR m.queue_id=$4 OR ($4='none' AND m.queue_id IS NULL)) AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM acd_segments s WHERE s.work_item_id=m.work_item_id AND s.agent_id=$5))
      ORDER BY m.deadline_at DESC LIMIT 100`,
      args.slice(0, 5),
    ),
  ]);
  const [
    closed,
    live,
    trend,
    queues,
    sla,
    unavailable,
    agents,
    wrapup,
    recent,
    lateness,
    slaTrend,
    breaches,
  ] = results.map((r) => r.rows);
  const series = channels.map((channel) => {
    const row = closed.find((r) => r.channel === channel) || {},
      current = live.find((r) => r.channel === channel) || {},
      definition = channelDefinition(channel);
    const metricSla = slaSummary(sla.filter((r) => r.channel === channel));
    const delay = lateness.find((row) => row.channel === channel);
    metricSla.avgLatenessSeconds = number(delay?.avg_lateness);
    metricSla.p95LatenessSeconds = number(delay?.p95_lateness);
    metricSla.unavailable =
      unavailable.find((r) => r.channel === channel)?.total || 0;
    return {
      channel,
      label: definition.label,
      closed: row.closed || 0,
      completed: row.completed || 0,
      abandoned: row.abandoned || 0,
      failed: row.failed || 0,
      received: current.received || 0,
      waiting: current.waiting || 0,
      offered: current.offered || 0,
      active: current.active || 0,
      avgWaitSeconds: number(row.avg_wait_seconds),
      avgHandlingSeconds: number(row.avg_handling_seconds),
      avgTalkSeconds: definition.capabilities.recordings
        ? number(row.avg_talk_seconds)
        : null,
      avgResponseSeconds: definition.capabilities.conversation
        ? number(row.avg_response_seconds)
        : null,
      avgAgentResponseSeconds: number(row.avg_agent_response_seconds),
      agentResponseCoverage: row.agent_response_coverage || 0,
      responseCoverage: row.response_coverage || 0,
      avgResolutionSeconds: number(row.avg_resolution_seconds),
      transfers: row.transfers || 0,
      sla: metricSla,
    };
  });
  const totals = Object.fromEntries(
    [
      "closed",
      "completed",
      "abandoned",
      "failed",
      "received",
      "waiting",
      "offered",
      "active",
    ].map((key) => [key, series.reduce((sum, r) => sum + r[key], 0)]),
  );
  return {
    version: 1,
    detail: await readSupervisorReportDetails(db, { report, base, args, scope }),
    scope,
    channels: series,
    totals,
    trend,
    queues,
    agents,
    wrapup,
    recent,
    slaTrend,
    breaches,
    sla: {
      ...slaSummary(sla),
      unavailable: unavailable.reduce((sum, r) => sum + r.total, 0),
    },
    timestamp: new Date().toISOString(),
  };
}

export async function readLiveWorkload(db, agentId = null, restriction = null) {
  const restrictionSql = interactionScopeSql(restriction, { agent: "r.agent_id", channel: "r.channel", workItem: "r.work_item_id" }, null).map((part) => ` AND ${part}`).join("");
  const agents = (
    await db.query(
      `SELECT a.agent_id,a.presence,a.manual_status,a.workflow_state,
    COALESCE(c.budget,a.capacity,1)::float AS budget,COALESCE(r.used,0)::float AS used,
    COALESCE(r.count,0)::int AS interactions,COALESCE(r.channels,'[]'::jsonb) AS channels
    FROM acd_agent_state a LEFT JOIN cc_agent_utilization c ON c.agent_id=a.agent_id
    LEFT JOIN LATERAL (SELECT SUM(weight) AS used,COUNT(DISTINCT work_item_id) AS count,
      jsonb_agg(jsonb_build_object('channel',channel,'weight',weight,'state',state,'workItemId',work_item_id)) AS channels
      FROM acd_reservations r WHERE r.agent_id=a.agent_id AND r.state<>'released'${restrictionSql}
        AND (r.state='active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at>now())) r ON true
    WHERE ($1::text IS NULL OR a.agent_id=$1) ORDER BY a.agent_id`,
      [agentId],
    )
  ).rows;
  const interactions = agentId
    ? (
        await db.query(
          `SELECT w.id,w.channel,w.state,w.direction,w.conversation_id,w.customer_address,
    w.created_at,w.terminal_at,w.queue_id,r.state AS reservation_state,r.release_requested_at,q.name AS queue_name,t.state AS assignment_state
    FROM acd_work_items w JOIN acd_reservations r ON r.work_item_id=w.id AND r.agent_id=$1
    LEFT JOIN cc_queues q ON q.id=w.queue_id LEFT JOIN acd_text_assignments t ON t.reservation_id=r.id
    WHERE r.state<>'released' AND (r.state='active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at>now())
    ORDER BY w.created_at`,
          [agentId],
        )
      ).rows
    : [];
  return {
    agents,
    interactions,
    used: agents.reduce((sum, a) => sum + a.used, 0),
    budget: agents.reduce((sum, a) => sum + a.budget, 0),
    scope: "All channels, including offered work and wrap-up",
  };
}
