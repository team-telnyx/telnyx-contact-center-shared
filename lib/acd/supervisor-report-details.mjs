import { RELEASED_CHANNELS, channelDefinition } from "./channel-registry.mjs";
import { slaSummary } from "./sla-report-summary.mjs";
import { agentAdherenceReport } from "./workforce-reports.mjs";
import { interactionScopeSql } from "../authz/scope.mjs";
// SLA measurements (alias `m`) narrowed to the caller's data scope (Phase 3a).
const measurementRestrictionSql = (scope) => interactionScopeSql(scope.restriction, { queue: "m.queue_id", workItem: "m.work_item_id", channel: "m.channel" }, null).map((c) => ` AND ${c}`).join("");

export const DETAIL_REPORTS = ["queue-performance", "agent-performance", "abandonment", "wrapup-codes"];
const numeric = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [key, value != null && /^(avg_|max_|total$|completed$|abandoned$|failed$|transfers$|holds$|hold_seconds$|interactions$|segments$|coded$|eligible$|distinct_codes$)/.test(key) ? Number(value) : value]));

// The caller supplies its canonical scoped/closed CTE and bound parameters. All
// historical outcomes therefore share the same cohort and participation rules.
export async function readSupervisorReportDetails(db, { report, base, args, scope }) {
  if (!DETAIL_REPORTS.includes(report)) return null;
  const query = async (sql, count = 5) => (await db.query(`${base} ${sql}`, args.slice(0, count))).rows.map(numeric);
  const bucket = "to_char(date_trunc($7,terminal_at AT TIME ZONE $6),'YYYY-MM-DD HH24:MI')";
  const segmentFilter = "($5::text IS NULL OR s.agent_id=$5) AND ($4::text IS NULL OR s.queue_id=$4 OR ($4='none' AND s.queue_id IS NULL))";
  const persistedChannels = RELEASED_CHANNELS.filter(id => channelDefinition(id).serviceEvent === "human_message_persisted").map(id => `'${id}'`).join(",");
  const queueWork = `, queue_work AS (
    SELECT w.id,w.channel,w.state,w.terminal_at,v.queue_id,
      COALESCE(q.display_name,q.name,'No queue') AS queue_name,
      d.wait_seconds,d.handling_seconds,d.talk_seconds,w.terminal_reason,
      (SELECT MIN(EXTRACT(EPOCH FROM m.served_at-m.started_at)) FROM acd_sla_measurements m
        WHERE m.work_item_id=w.id AND m.queue_id IS NOT DISTINCT FROM v.queue_id) AS response_seconds
    FROM closed w CROSS JOIN LATERAL (
      SELECT DISTINCT queue_id FROM acd_segments WHERE work_item_id=w.id
      UNION SELECT w.queue_id WHERE NOT EXISTS(SELECT 1 FROM acd_segments WHERE work_item_id=w.id AND queue_id IS NOT NULL)
    ) v LEFT JOIN cc_queues q ON q.id=v.queue_id
    LEFT JOIN LATERAL (SELECT
      SUM(EXTRACT(EPOCH FROM COALESCE(s.ended_at,w.terminal_at)-s.started_at)) FILTER(WHERE s.kind='queue_wait') AS wait_seconds,
      SUM(EXTRACT(EPOCH FROM COALESCE(s.wrapup_ended_at,s.ended_at,w.terminal_at)-s.started_at)) FILTER(WHERE s.kind='agent' AND ($5::text IS NULL OR s.agent_id=$5)) AS handling_seconds,
      SUM(EXTRACT(EPOCH FROM COALESCE(s.ended_at,w.terminal_at)-s.answered_at)) FILTER(WHERE s.kind='agent' AND ($5::text IS NULL OR s.agent_id=$5)) AS talk_seconds
      FROM acd_segments s WHERE s.work_item_id=w.id AND s.queue_id IS NOT DISTINCT FROM v.queue_id
    ) d ON true WHERE ($4::text IS NULL OR v.queue_id=$4 OR ($4='none' AND v.queue_id IS NULL))
  )`;
  if (report === "queue-performance") {
    const [trend, heatmap, queues, service, timing] = await Promise.all([
      query(`SELECT ${bucket} AS bucket,COUNT(*)::int AS total,
        COUNT(*) FILTER(WHERE state='completed')::int AS completed,COUNT(*) FILTER(WHERE state='abandoned')::int AS abandoned,
        COUNT(*) FILTER(WHERE state='failed')::int AS failed,AVG(wait_seconds) AS avg_wait_seconds FROM closed GROUP BY 1 ORDER BY 1`, 7),
      query(`SELECT EXTRACT(ISODOW FROM created_at AT TIME ZONE $6)::int AS day,
        EXTRACT(HOUR FROM created_at AT TIME ZONE $6)::int AS hour,COUNT(*)::int AS total
        FROM scoped WHERE created_at>=$1 AND created_at<$2 GROUP BY 1,2 ORDER BY 1,2`, 6),
      query(`${queueWork} SELECT queue_id,queue_name,channel,COUNT(*)::int AS total,
        COUNT(*) FILTER(WHERE state='completed')::int AS completed,COUNT(*) FILTER(WHERE state='abandoned')::int AS abandoned,
        COUNT(*) FILTER(WHERE state='failed')::int AS failed,AVG(wait_seconds) AS avg_wait_seconds,MAX(wait_seconds) AS max_wait_seconds,
        AVG(handling_seconds) AS avg_handling_seconds,AVG(talk_seconds) AS avg_talk_seconds,AVG(response_seconds) AS avg_response_seconds FROM queue_work GROUP BY 1,2,3 ORDER BY total DESC,queue_name,channel`),
      db.query(`SELECT m.queue_id,COALESCE(q.display_name,q.name,'No queue') AS queue_name,m.channel,m.state,COUNT(*)::int AS total,
        COUNT(*) FILTER(WHERE m.at_risk)::int AS at_risk,SUM((m.policy->>'targetPercentage')::numeric) AS target_sum
        FROM acd_sla_status m LEFT JOIN cc_queues q ON q.id=m.queue_id WHERE m.started_at>=$1 AND m.started_at<$2 AND m.channel=ANY($3::text[])
        AND ($4::text IS NULL OR m.queue_id=$4 OR ($4='none' AND m.queue_id IS NULL))
        AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM acd_segments s WHERE s.work_item_id=m.work_item_id AND s.agent_id=$5))${measurementRestrictionSql(scope)} GROUP BY 1,2,3,4`, args.slice(0,5)),
      query("SELECT AVG(wait_seconds) AS avg_wait_seconds,MAX(wait_seconds) AS max_wait_seconds FROM closed"),
    ]);
    // SLA-only queue rows remain visible even when their work has not closed yet.
    for (const row of service.rows) if (!queues.some(q => q.queue_id === row.queue_id && q.channel === row.channel))
      queues.push({ queue_id: row.queue_id, queue_name: row.queue_name, channel: row.channel, total: 0, completed: 0, abandoned: 0, failed: 0 });
    return { report, trend, heatmap, timing: timing[0], queues: queues.map(row => ({ ...row,
      avg_talk_seconds: channelDefinition(row.channel).capabilities.recordings ? row.avg_talk_seconds : null,
      avg_response_seconds: channelDefinition(row.channel).capabilities.conversation ? row.avg_response_seconds : null,
      sla: slaSummary(service.rows.filter(s => s.queue_id === row.queue_id && s.channel === row.channel)),
    })) };
  }
  if (report === "agent-performance") {
    const agentWork = `, agent_work AS (
      SELECT w.id,w.channel,w.state,w.terminal_at,s.agent_id,
        SUM(EXTRACT(EPOCH FROM COALESCE(s.wrapup_ended_at,s.ended_at,w.terminal_at)-s.started_at)) AS handling_seconds,
        SUM(EXTRACT(EPOCH FROM COALESCE(s.ended_at,w.terminal_at)-s.answered_at)) AS talk_seconds,
        COUNT(*) FILTER(WHERE s.outcome='transferred')::int AS transfers,
        AVG(EXTRACT(EPOCH FROM reply.at-s.started_at)) AS response_seconds
      FROM closed w JOIN acd_segments s ON s.work_item_id=w.id AND s.kind='agent'
      LEFT JOIN LATERAL (SELECT MIN(evidence.at) AS at FROM (
        SELECT CASE WHEN e.type='text_message_created' THEN m.created_at ELSE e.occurred_at END AS at
        FROM acd_messages m JOIN acd_events e ON e.work_item_id=w.id AND e.payload->>'message_id'=m.id::text
        WHERE m.work_item_id=w.id AND m.sender_role='agent' AND m.sender_id=s.agent_id
          AND m.created_at>=s.started_at AND m.created_at<=COALESCE(s.ended_at,w.terminal_at)
          AND ((e.type='text_message_created' AND w.channel=ANY(ARRAY[${persistedChannels}]::text[]))
            OR (e.type IN ('email_send_updated','message_send_updated') AND e.payload->>'status'='accepted'))
        ) evidence WHERE evidence.at<=COALESCE(s.ended_at,w.terminal_at)) reply ON true
      WHERE s.agent_id IS NOT NULL AND ${segmentFilter} GROUP BY w.id,w.channel,w.state,w.terminal_at,s.agent_id
    )`;
    const [agents, trend, totals, holds, workforce] = await Promise.all([
      query(`${agentWork} SELECT a.agent_id,u.username,COALESCE(NULLIF(concat_ws(' ',u.first_name,u.last_name),''),u.username,a.agent_id) AS name,
        a.channel,COUNT(*)::int AS total,COUNT(*) FILTER(WHERE a.state='completed')::int AS completed,
        AVG(a.handling_seconds) AS avg_handling_seconds,AVG(a.talk_seconds) AS avg_talk_seconds,AVG(a.response_seconds) AS avg_response_seconds,SUM(a.transfers)::int AS transfers,COUNT(*) FILTER(WHERE a.transfers>0)::int AS transferred
        FROM agent_work a LEFT JOIN users u ON u.id=a.agent_id GROUP BY 1,2,3,4 ORDER BY total DESC,name,channel`),
      query(`${agentWork} SELECT ${bucket} AS bucket,COUNT(DISTINCT id)::int AS total,
        AVG(handling_seconds) AS avg_handling_seconds FROM agent_work GROUP BY 1 ORDER BY 1`, 7),
      query(`${agentWork} SELECT COUNT(DISTINCT agent_id)::int AS agents,COUNT(DISTINCT id)::int AS total,SUM(transfers)::int AS transfers,
        AVG(handling_seconds) AS avg_handling_seconds FROM agent_work`),
      query(`SELECT owner.agent_id,w.channel,COUNT(*)::int AS holds,
        SUM(GREATEST(0,EXTRACT(EPOCH FROM COALESCE((SELECT MIN(e2.occurred_at) FROM acd_events e2
          WHERE e2.work_item_id=w.id AND e2.type='hold_ended' AND e2.id>e.id),w.terminal_at)-e.occurred_at))) AS hold_seconds
        FROM closed w JOIN acd_events e ON e.work_item_id=w.id AND e.type='hold_started'
        CROSS JOIN LATERAL (SELECT s.agent_id,s.queue_id FROM acd_segments s WHERE s.work_item_id=w.id AND s.kind='agent'
          AND s.started_at<=e.occurred_at AND COALESCE(s.ended_at,w.terminal_at)>=e.occurred_at AND (e.agent_id IS NULL OR s.agent_id=e.agent_id)
          ORDER BY s.seq DESC LIMIT 1) owner
        WHERE ($5::text IS NULL OR owner.agent_id=$5) AND ($4::text IS NULL OR owner.queue_id=$4 OR ($4='none' AND owner.queue_id IS NULL))
        GROUP BY 1,2`),
      agentAdherenceReport(db, scope),
    ]);
    return { report, trend, totals: totals[0], agents: agents.map(row => ({ ...row,
      avg_talk_seconds: channelDefinition(row.channel).capabilities.recordings ? row.avg_talk_seconds : null,
      holds: channelDefinition(row.channel).capabilities.holds ? holds.find(h => h.agent_id===row.agent_id && h.channel===row.channel)?.holds || 0 : null,
      hold_seconds: channelDefinition(row.channel).capabilities.holds ? holds.find(h => h.agent_id===row.agent_id && h.channel===row.channel)?.hold_seconds || 0 : null,
    })), workforce: workforce.agents.filter(w => agents.some(a => a.username===w.username)) };
  }
  if (report === "abandonment") {
    const [buckets, hourly, queues, reasons, recent] = await Promise.all([
      query(`, lost AS (SELECT CASE WHEN wait_seconds IS NULL THEN 8 WHEN wait_seconds<10 THEN 0 WHEN wait_seconds<30 THEN 1
        WHEN wait_seconds<60 THEN 2 WHEN wait_seconds<300 THEN 3 WHEN wait_seconds<3600 THEN 4 WHEN wait_seconds<86400 THEN 5
        ELSE 6 END AS bucket,state FROM closed WHERE state IN ('abandoned','failed'))
        SELECT bucket,COUNT(*)::int AS total,COUNT(*) FILTER(WHERE state='abandoned')::int AS abandoned,
        COUNT(*) FILTER(WHERE state='failed')::int AS failed FROM lost GROUP BY 1 ORDER BY 1`),
      query(`SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE $6)::int AS hour,COUNT(*)::int AS total,
        COUNT(*) FILTER(WHERE state='completed')::int AS completed,COUNT(*) FILTER(WHERE state='abandoned')::int AS abandoned,
        COUNT(*) FILTER(WHERE state='failed')::int AS failed FROM closed GROUP BY 1 ORDER BY 1`, 6),
      query(`${queueWork} SELECT queue_id,queue_name,channel,COUNT(*)::int AS total,
        COUNT(*) FILTER(WHERE state='abandoned')::int AS abandoned,COUNT(*) FILTER(WHERE state='failed')::int AS failed,
        AVG(wait_seconds) FILTER(WHERE state IN ('abandoned','failed')) AS avg_wait_seconds
        FROM queue_work GROUP BY 1,2,3 ORDER BY (COUNT(*) FILTER(WHERE state IN ('abandoned','failed'))) DESC,queue_name`),
      query("SELECT channel,state,COALESCE(terminal_reason,'Not recorded') AS reason,COUNT(*)::int AS total FROM closed WHERE state IN ('abandoned','failed') GROUP BY 1,2,3 ORDER BY total DESC"),
      query("SELECT id,channel,state,customer_address,queue_name,terminal_at,terminal_reason,wait_seconds AS avg_wait_seconds FROM closed WHERE state IN ('abandoned','failed') ORDER BY terminal_at DESC LIMIT 100"),
    ]);
    const labels = { 0: "< 10s", 1: "10–30s", 2: "30–60s", 3: "1–5m", 4: "5–60m", 5: "1–24h", 6: "24h+", 8: "Not recorded" };
    return { report, buckets: buckets.map(r => ({ ...r, label: labels[r.bucket] })), hourly, queues, reasons, recent };
  }
  const coded = `, coded AS (SELECT w.id,w.channel,w.state,w.terminal_at,s.queue_id,s.wrapup_code_id,
    COALESCE(c.name,s.wrapup_code_id,'No disposition') AS name,s.id AS segment_id
    FROM closed w JOIN acd_segments s ON s.work_item_id=w.id AND s.kind='agent'
    LEFT JOIN cc_wrapup_codes c ON c.id=s.wrapup_code_id WHERE ${segmentFilter})`;
  const [totals, codes, trend, queues] = await Promise.all([
    query(`${coded} SELECT COUNT(DISTINCT id) FILTER(WHERE state='completed')::int AS eligible,
      COUNT(DISTINCT id) FILTER(WHERE state='completed' AND wrapup_code_id IS NOT NULL)::int AS coded,
      COUNT(DISTINCT wrapup_code_id)::int AS distinct_codes FROM coded`),
    query(`${coded} SELECT wrapup_code_id,name,channel,COUNT(DISTINCT id)::int AS interactions,COUNT(*)::int AS segments
      FROM coded GROUP BY 1,2,3 ORDER BY interactions DESC,name,channel`),
    query(`${coded} SELECT ${bucket} AS bucket,wrapup_code_id,name,COUNT(DISTINCT id)::int AS interactions
      FROM coded GROUP BY 1,2,3 ORDER BY 1,3`, 7),
    query(`${coded} SELECT d.queue_id,COALESCE(q.display_name,q.name,'No queue') AS queue_name,d.channel,d.wrapup_code_id,d.name,
      COUNT(DISTINCT d.id)::int AS interactions,COUNT(*)::int AS segments FROM coded d LEFT JOIN cc_queues q ON q.id=d.queue_id
      GROUP BY 1,2,3,4,5 ORDER BY interactions DESC,queue_name,d.name`),
  ]);
  return { report, totals: totals[0], codes, trend, queues };
}
