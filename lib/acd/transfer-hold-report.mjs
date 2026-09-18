import { RELEASED_CHANNELS } from "./channel-registry.mjs";
import { interactionScopeSql } from "../authz/scope.mjs";
function baseFilters({ from, to, queueName, channel, channels, restriction }) {
  const where = [
    "i.interaction_type = ANY($3::text[])",
    "i.terminal_at IS NOT NULL",
    "i.terminal_at >= $1",
    "i.terminal_at < $2",
  ];
  const vals = [from, to, channels || (channel ? [channel] : RELEASED_CHANNELS)];
  let paramIndex = 4;
  if (queueName) {
    where.push(
      `(i.queue_name = $${paramIndex} OR EXISTS(SELECT 1 FROM acd_segments sq JOIN cc_queues q ON q.id=sq.queue_id WHERE sq.work_item_id=i.work_item_id AND q.name=$${paramIndex++}))`,
    );
    vals.push(queueName);
  }
  // Caller's data scope (Phase 3a).
  where.push(...interactionScopeSql(restriction, { queue: "i.queue_id", agent: "i.agent_id", channel: "i.interaction_type", workItem: "i.work_item_id" }, vals));
  paramIndex = vals.length + 1;
  return { where, vals, paramIndex };
}

export async function transfersHoldsReport(
  pool,
  { from, to, queueName, channel, channels, restriction },
) {
  const { where, vals } = baseFilters({ from, to, queueName, channel, channels, restriction });
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const totalsQuery = `
    SELECT
      COUNT(*)::int AS total,COUNT(*) FILTER(WHERE i.interaction_type='voice')::int AS voice_total,
      COUNT(*) FILTER (WHERE COALESCE(i.transfer_count, 0) > 0)::int AS with_transfers,
      SUM(COALESCE(i.transfer_count, 0))::int AS transfer_count,
      COUNT(*) FILTER (WHERE COALESCE(i.hold_count, 0) > 0)::int AS with_holds,
      SUM(COALESCE(i.hold_count, 0))::int AS hold_count,
      SUM(COALESCE(i.hold_duration_seconds, 0))::bigint AS hold_duration_seconds,
      AVG(i.hold_duration_seconds) FILTER (WHERE COALESCE(i.hold_count, 0) > 0)::NUMERIC(10,2) AS avg_hold_seconds,
      MAX(i.hold_duration_seconds)::int AS max_hold_seconds
    FROM acd_history_interactions i
    ${whereSql}
  `;

  const participation = `WITH scoped AS (SELECT i.* FROM acd_history_interactions i ${whereSql}), records AS (
    SELECT i.id AS work_item_id,s.agent_id,s.queue_id,CASE WHEN s.outcome='transferred' THEN 1 ELSE 0 END AS transfers,0 AS holds,0::numeric AS hold_seconds
      FROM scoped i JOIN acd_segments s ON s.work_item_id=i.id AND s.kind='agent'
    UNION ALL SELECT i.id,COALESCE(e.agent_id,owner.agent_id),owner.queue_id,0,1,
      GREATEST(0,EXTRACT(EPOCH FROM COALESCE((SELECT MIN(e2.occurred_at) FROM acd_events e2 WHERE e2.work_item_id=i.id AND e2.type='hold_ended' AND e2.id>e.id),i.terminal_at)-e.occurred_at))
      FROM scoped i JOIN acd_events e ON e.work_item_id=i.id AND e.type='hold_started'
      LEFT JOIN LATERAL(SELECT s.agent_id,s.queue_id FROM acd_segments s WHERE s.work_item_id=i.id AND s.kind='agent'
        AND s.started_at<=e.occurred_at AND (s.ended_at IS NULL OR s.ended_at>=e.occurred_at)
        AND (e.agent_id IS NULL OR s.agent_id=e.agent_id) ORDER BY s.seq DESC LIMIT 1) owner ON true
      WHERE i.interaction_type='voice')`;
  const byAgentQuery = `${participation} SELECT u.username AS agent_username,u.first_name,u.last_name,
    COUNT(DISTINCT r.work_item_id)::int AS handled,SUM(r.transfers)::int AS transfer_count,SUM(r.holds)::int AS hold_count,SUM(r.hold_seconds) AS hold_duration_seconds
    FROM records r LEFT JOIN users u ON u.id=r.agent_id WHERE r.agent_id IS NOT NULL GROUP BY r.agent_id,u.username,u.first_name,u.last_name ORDER BY handled DESC`;
  const byQueueQuery = `${participation} SELECT COALESCE(q.name,'No queue') AS queue_name,COUNT(DISTINCT r.work_item_id)::int AS total,
    SUM(r.transfers)::int AS transfer_count,SUM(r.holds)::int AS hold_count,AVG(r.hold_seconds) FILTER(WHERE r.holds=1) AS avg_hold_seconds
    FROM records r LEFT JOIN cc_queues q ON q.id=r.queue_id ${queueName ? "WHERE q.name=$4" : ""} GROUP BY r.queue_id,q.name ORDER BY total DESC`;

  const longestHoldsQuery = `
    SELECT
      i.id,
      i.queue_name,
      i.agent_username,
      i.from_number,
      i.from_name,
      i.hold_count,
      i.hold_duration_seconds,
      COALESCE(i.completed_at, i.abandoned_at, i.created_at) AS happened_at
    FROM acd_history_interactions i
    ${whereSql} AND COALESCE(i.hold_count, 0) > 0
    ORDER BY i.hold_duration_seconds DESC NULLS LAST
    LIMIT 25
  `;

  const [totalsRes, byAgentRes, byQueueRes, longestRes] = await Promise.all([
    pool.query(totalsQuery, vals),
    pool.query(byAgentQuery, vals),
    pool.query(byQueueQuery, vals),
    pool.query(longestHoldsQuery, vals),
  ]);

  const totals = totalsRes.rows?.[0] || {};
  const totalCalls = Number(totals.total || 0);

  return {
    totals: {
      total: totalCalls,
      withTransfers: Number(totals.with_transfers || 0),
      transferCount: Number(totals.transfer_count || 0),
      transferRatePct:
        totalCalls > 0
          ? Math.round((Number(totals.with_transfers || 0) / totalCalls) * 100)
          : 0,
      withHolds:
        channel && channel !== "voice" ? null : Number(totals.with_holds || 0),
      holdCount:
        channel && channel !== "voice" ? null : Number(totals.hold_count || 0),
      holdRatePct:
        Number(totals.voice_total) > 0
          ? (100 * Number(totals.with_holds || 0)) / Number(totals.voice_total)
          : null,
      holdDurationSeconds:
        channel && channel !== "voice"
          ? null
          : Number(totals.hold_duration_seconds || 0),
      avgHoldSeconds:
        totals.avg_hold_seconds == null
          ? null
          : Number(totals.avg_hold_seconds),
      maxHoldSeconds:
        channel && channel !== "voice"
          ? null
          : Number(totals.max_hold_seconds || 0),
    },
    agents: byAgentRes.rows.map((row) => {
      const handled = Number(row.handled || 0);
      return {
        username: row.agent_username,
        name:
          row.first_name || row.last_name
            ? `${row.first_name || ""} ${row.last_name || ""}`.trim()
            : row.agent_username,
        handled,
        transferCount: Number(row.transfer_count || 0),
        transferRatePct:
          handled > 0
            ? Math.round((Number(row.transfer_count || 0) / handled) * 100)
            : 0,
        holdCount:
          channel && channel !== "voice" ? null : Number(row.hold_count || 0),
        holdDurationSeconds:
          channel && channel !== "voice"
            ? null
            : Number(row.hold_duration_seconds || 0),
      };
    }),
    queues: byQueueRes.rows.map((row) => ({
      queueName: row.queue_name,
      total: Number(row.total || 0),
      transferCount: Number(row.transfer_count || 0),
      holdCount:
        channel && channel !== "voice" ? null : Number(row.hold_count || 0),
      avgHoldSeconds:
        row.avg_hold_seconds == null ? null : Number(row.avg_hold_seconds),
    })),
    longestHolds: longestRes.rows.map((row) => ({
      id: row.id,
      queueName: row.queue_name,
      agentUsername: row.agent_username,
      fromNumber: row.from_number,
      fromName: row.from_name,
      holdCount:
        channel && channel !== "voice" ? null : Number(row.hold_count || 0),
      holdDurationSeconds:
        channel && channel !== "voice"
          ? null
          : Number(row.hold_duration_seconds || 0),
      happenedAt: row.happened_at,
    })),
  };
}
