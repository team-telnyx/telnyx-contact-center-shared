import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { contactCenterRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

// Historical analytics for supervisors. Reports are computed directly from
// cc_interactions (source of truth) plus cc_user_time_tracking for agent
// occupancy, because the pre-aggregated statistics tables may lag or be empty
// on fresh deployments.

const REPORTS = [
  "queue-performance",
  "agent-performance",
  "abandonment",
  "agent-adherence",
  "transfers-holds",
  "wrapup-codes",
  "ai-handoffs",
  "outbound-campaigns",
  "skills-gap",
  "cradle-to-grave",
];
const MAX_RANGE_DAYS = 92;
const DEFAULT_SLA_SECONDS = 20;

function clampDateRange(fromParam, toParam) {
  const now = new Date();
  let to = toParam ? new Date(toParam) : now;
  if (Number.isNaN(to.getTime())) to = now;
  let from = fromParam ? new Date(fromParam) : new Date(to.getTime() - 7 * 86400000);
  if (Number.isNaN(from.getTime())) from = new Date(to.getTime() - 7 * 86400000);
  if (from > to) [from, to] = [to, from];
  // Hard bound so a single query can never scan an unbounded range.
  const maxSpan = MAX_RANGE_DAYS * 86400000;
  if (to.getTime() - from.getTime() > maxSpan) {
    from = new Date(to.getTime() - maxSpan);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function baseFilters({ from, to, queueName }) {
  const where = [
    "i.is_contact_center = true",
    "COALESCE(i.metadata->>'is_transfer_leg', 'false') <> 'true'",
    "COALESCE(i.metadata->>'is_consult_call', 'false') <> 'true'",
    "COALESCE(i.completed_at, i.abandoned_at, i.created_at) >= $1",
    "COALESCE(i.completed_at, i.abandoned_at, i.created_at) <= $2",
  ];
  const vals = [from, to];
  let paramIndex = 3;
  if (queueName) {
    where.push(`i.queue_name = $${paramIndex++}`);
    vals.push(queueName);
  }
  return { where, vals, paramIndex };
}

async function queuePerformanceReport(pool, { from, to, queueName, slaSeconds }) {
  const { where, vals, paramIndex } = baseFilters({ from, to, queueName });
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const slaParam = `$${paramIndex}`;
  const valsWithSla = [...vals, slaSeconds];

  const perQueueQuery = `
    SELECT
      COALESCE(i.queue_name, 'No queue') AS queue_name,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE i.state = 'completed')::int AS answered,
      COUNT(*) FILTER (WHERE i.state = 'abandoned')::int AS abandoned,
      COUNT(*) FILTER (WHERE i.state = 'completed' AND COALESCE(i.wait_time_seconds, 0) <= ${slaParam})::int AS answered_within_sla,
      AVG(i.wait_time_seconds)::NUMERIC(10,2) AS avg_wait_seconds,
      MAX(i.wait_time_seconds)::int AS max_wait_seconds,
      AVG(i.handle_time_seconds) FILTER (WHERE i.state = 'completed')::NUMERIC(10,2) AS avg_handle_seconds,
      AVG(i.talk_time_seconds) FILTER (WHERE i.state = 'completed')::NUMERIC(10,2) AS avg_talk_seconds
    FROM cc_interactions i
    ${whereSql}
    GROUP BY COALESCE(i.queue_name, 'No queue')
    ORDER BY total DESC
    LIMIT 50
  `;

  const dailyQuery = `
    SELECT
      DATE(COALESCE(i.completed_at, i.abandoned_at, i.created_at)) AS day,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE i.state = 'completed')::int AS answered,
      COUNT(*) FILTER (WHERE i.state = 'abandoned')::int AS abandoned,
      AVG(i.wait_time_seconds)::NUMERIC(10,2) AS avg_wait_seconds
    FROM cc_interactions i
    ${whereSql}
    GROUP BY 1
    ORDER BY 1 ASC
    LIMIT ${MAX_RANGE_DAYS + 1}
  `;

  const heatmapQuery = `
    SELECT
      EXTRACT(ISODOW FROM COALESCE(i.completed_at, i.abandoned_at, i.created_at))::int AS dow,
      EXTRACT(HOUR FROM COALESCE(i.completed_at, i.abandoned_at, i.created_at))::int AS hour,
      COUNT(*)::int AS total
    FROM cc_interactions i
    ${whereSql}
    GROUP BY 1, 2
    ORDER BY 1, 2
    LIMIT 168
  `;

  const [perQueueRes, dailyRes, heatmapRes] = await Promise.all([
    pool.query(perQueueQuery, valsWithSla),
    pool.query(dailyQuery, vals),
    pool.query(heatmapQuery, vals),
  ]);

  const queues = perQueueRes.rows.map((row) => {
    const answered = Number(row.answered || 0);
    const abandoned = Number(row.abandoned || 0);
    const offered = Math.max(answered + abandoned, 1);
    return {
      queueName: row.queue_name,
      total: Number(row.total || 0),
      answered,
      abandoned,
      answeredWithinSla: Number(row.answered_within_sla || 0),
      serviceLevelPct: Math.round((Number(row.answered_within_sla || 0) / offered) * 100),
      answerRatePct: Math.round((answered / offered) * 100),
      avgWaitSeconds: Number(row.avg_wait_seconds || 0),
      maxWaitSeconds: Number(row.max_wait_seconds || 0),
      avgHandleSeconds: Number(row.avg_handle_seconds || 0),
      avgTalkSeconds: Number(row.avg_talk_seconds || 0),
    };
  });

  const totals = queues.reduce(
    (acc, q) => {
      acc.total += q.total;
      acc.answered += q.answered;
      acc.abandoned += q.abandoned;
      acc.answeredWithinSla += q.answeredWithinSla;
      return acc;
    },
    { total: 0, answered: 0, abandoned: 0, answeredWithinSla: 0 },
  );
  const offeredTotal = Math.max(totals.answered + totals.abandoned, 1);

  return {
    slaSeconds,
    totals: {
      ...totals,
      serviceLevelPct: Math.round((totals.answeredWithinSla / offeredTotal) * 100),
      answerRatePct: Math.round((totals.answered / offeredTotal) * 100),
    },
    queues,
    daily: dailyRes.rows.map((row) => ({
      day: row.day,
      label: new Date(row.day).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      total: Number(row.total || 0),
      answered: Number(row.answered || 0),
      abandoned: Number(row.abandoned || 0),
      avgWaitSeconds: Number(row.avg_wait_seconds || 0),
    })),
    heatmap: heatmapRes.rows.map((row) => ({
      dow: Number(row.dow || 0),
      hour: Number(row.hour || 0),
      total: Number(row.total || 0),
    })),
  };
}

async function agentPerformanceReport(pool, { from, to, queueName }) {
  const { where, vals } = baseFilters({ from, to, queueName });
  const agentWhereSql = `WHERE ${[...where, "i.agent_username IS NOT NULL"].join(" AND ")}`;

  const perAgentQuery = `
    SELECT
      i.agent_username,
      MAX(u.first_name) AS first_name,
      MAX(u.last_name) AS last_name,
      COUNT(*)::int AS handled,
      COUNT(*) FILTER (WHERE i.state = 'completed')::int AS completed,
      AVG(i.handle_time_seconds) FILTER (WHERE i.state = 'completed')::NUMERIC(10,2) AS avg_handle_seconds,
      AVG(i.talk_time_seconds) FILTER (WHERE i.state = 'completed')::NUMERIC(10,2) AS avg_talk_seconds,
      SUM(COALESCE(i.hold_count, 0))::int AS hold_count,
      SUM(COALESCE(i.hold_duration_seconds, 0))::int AS hold_duration_seconds,
      SUM(COALESCE(i.transfer_count, 0))::int AS transfer_count
    FROM cc_interactions i
    LEFT JOIN users u ON u.username = i.agent_username
    ${agentWhereSql}
    GROUP BY i.agent_username
    ORDER BY handled DESC
    LIMIT 100
  `;

  // Occupancy from the hourly time-tracking aggregate; joined via users so we
  // can match interactions (agent_username) with tracking rows (user_id).
  const timeTrackingQuery = `
    SELECT
      u.username,
      SUM(t.logged_in_seconds)::bigint AS logged_in_seconds,
      SUM(t.call_seconds)::bigint AS call_seconds,
      SUM(t.break_seconds)::bigint AS break_seconds,
      SUM(t.status_available_seconds)::bigint AS available_seconds
    FROM cc_user_time_tracking t
    JOIN users u ON u.id = t.user_id
    WHERE t.tracking_date >= DATE($1) AND t.tracking_date <= DATE($2)
    GROUP BY u.username
    LIMIT 200
  `;

  const dailyQuery = `
    SELECT
      DATE(COALESCE(i.completed_at, i.abandoned_at, i.created_at)) AS day,
      COUNT(*)::int AS handled,
      AVG(i.handle_time_seconds) FILTER (WHERE i.state = 'completed')::NUMERIC(10,2) AS avg_handle_seconds
    FROM cc_interactions i
    ${agentWhereSql}
    GROUP BY 1
    ORDER BY 1 ASC
    LIMIT ${MAX_RANGE_DAYS + 1}
  `;

  const [perAgentRes, trackingRes, dailyRes] = await Promise.all([
    pool.query(perAgentQuery, vals),
    pool.query(timeTrackingQuery, [from, to]),
    pool.query(dailyQuery, vals),
  ]);

  const trackingByUsername = new Map(
    trackingRes.rows.map((row) => [row.username, row]),
  );

  const agents = perAgentRes.rows.map((row) => {
    const tracking = trackingByUsername.get(row.agent_username) || {};
    const loggedIn = Number(tracking.logged_in_seconds || 0);
    const callSeconds = Number(tracking.call_seconds || 0);
    const handled = Number(row.handled || 0);
    return {
      username: row.agent_username,
      name:
        row.first_name || row.last_name
          ? `${row.first_name || ""} ${row.last_name || ""}`.trim()
          : row.agent_username,
      handled,
      completed: Number(row.completed || 0),
      avgHandleSeconds: Number(row.avg_handle_seconds || 0),
      avgTalkSeconds: Number(row.avg_talk_seconds || 0),
      holdCount: Number(row.hold_count || 0),
      holdDurationSeconds: Number(row.hold_duration_seconds || 0),
      transferCount: Number(row.transfer_count || 0),
      transferRatePct: handled > 0 ? Math.round((Number(row.transfer_count || 0) / handled) * 100) : 0,
      loggedInSeconds: loggedIn,
      callSeconds,
      breakSeconds: Number(tracking.break_seconds || 0),
      occupancyPct: loggedIn > 0 ? Math.min(100, Math.round((callSeconds / loggedIn) * 100)) : null,
    };
  });

  const totals = agents.reduce(
    (acc, a) => {
      acc.handled += a.handled;
      acc.completed += a.completed;
      acc.transferCount += a.transferCount;
      acc.holdCount += a.holdCount;
      return acc;
    },
    { handled: 0, completed: 0, transferCount: 0, holdCount: 0 },
  );

  return {
    totals: { ...totals, agents: agents.length },
    agents,
    daily: dailyRes.rows.map((row) => ({
      day: row.day,
      label: new Date(row.day).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      handled: Number(row.handled || 0),
      avgHandleSeconds: Number(row.avg_handle_seconds || 0),
    })),
  };
}

const ABANDONMENT_BUCKETS = [
  { id: "lt10", label: "< 10s", min: 0, max: 10 },
  { id: "b10_30", label: "10–30s", min: 10, max: 30 },
  { id: "b30_60", label: "30–60s", min: 30, max: 60 },
  { id: "b60_120", label: "1–2 min", min: 60, max: 120 },
  { id: "gt120", label: "> 2 min", min: 120, max: null },
];

async function abandonmentReport(pool, { from, to, queueName }) {
  const { where, vals } = baseFilters({ from, to, queueName });
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const abandonedWhereSql = `WHERE ${[...where, "i.state = 'abandoned'"].join(" AND ")}`;

  const bucketSelect = ABANDONMENT_BUCKETS.map((bucket) => {
    const upper = bucket.max == null ? "" : ` AND COALESCE(i.wait_time_seconds, 0) < ${bucket.max}`;
    return `COUNT(*) FILTER (WHERE COALESCE(i.wait_time_seconds, 0) >= ${bucket.min}${upper})::int AS "${bucket.id}"`;
  }).join(",\n      ");

  const bucketsQuery = `
    SELECT
      ${bucketSelect}
    FROM cc_interactions i
    ${abandonedWhereSql}
  `;

  const perQueueQuery = `
    SELECT
      COALESCE(i.queue_name, 'No queue') AS queue_name,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE i.state = 'abandoned')::int AS abandoned,
      AVG(i.wait_time_seconds) FILTER (WHERE i.state = 'abandoned')::NUMERIC(10,2) AS avg_wait_before_abandon_seconds
    FROM cc_interactions i
    ${whereSql}
    GROUP BY COALESCE(i.queue_name, 'No queue')
    ORDER BY abandoned DESC
    LIMIT 50
  `;

  const hourlyQuery = `
    SELECT
      EXTRACT(HOUR FROM COALESCE(i.abandoned_at, i.completed_at, i.created_at))::int AS hour,
      COUNT(*) FILTER (WHERE i.state = 'completed')::int AS answered,
      COUNT(*) FILTER (WHERE i.state = 'abandoned')::int AS abandoned
    FROM cc_interactions i
    ${whereSql}
    GROUP BY 1
    ORDER BY 1
    LIMIT 24
  `;

  const callbackQuery = `
    SELECT
      i.id,
      i.from_number,
      i.from_name,
      i.queue_name,
      i.wait_time_seconds,
      i.abandoned_at
    FROM cc_interactions i
    ${abandonedWhereSql}
    ORDER BY i.abandoned_at DESC NULLS LAST
    LIMIT 50
  `;

  const [bucketsRes, perQueueRes, hourlyRes, callbackRes] = await Promise.all([
    pool.query(bucketsQuery, vals),
    pool.query(perQueueQuery, vals),
    pool.query(hourlyQuery, vals),
    pool.query(callbackQuery, vals),
  ]);

  const bucketRow = bucketsRes.rows?.[0] || {};
  const buckets = ABANDONMENT_BUCKETS.map((bucket) => ({
    id: bucket.id,
    label: bucket.label,
    total: Number(bucketRow[bucket.id] || 0),
  }));

  const queues = perQueueRes.rows.map((row) => {
    const total = Number(row.total || 0);
    const abandoned = Number(row.abandoned || 0);
    return {
      queueName: row.queue_name,
      total,
      abandoned,
      abandonRatePct: total > 0 ? Math.round((abandoned / total) * 100) : 0,
      avgWaitBeforeAbandonSeconds: Number(row.avg_wait_before_abandon_seconds || 0),
    };
  });

  const totals = queues.reduce(
    (acc, q) => {
      acc.total += q.total;
      acc.abandoned += q.abandoned;
      return acc;
    },
    { total: 0, abandoned: 0 },
  );

  return {
    totals: {
      ...totals,
      abandonRatePct: totals.total > 0 ? Math.round((totals.abandoned / totals.total) * 100) : 0,
    },
    buckets,
    queues,
    hourly: hourlyRes.rows.map((row) => ({
      hour: Number(row.hour || 0),
      label: `${String(row.hour).padStart(2, "0")}:00`,
      answered: Number(row.answered || 0),
      abandoned: Number(row.abandoned || 0),
    })),
    callbacks: callbackRes.rows.map((row) => ({
      id: row.id,
      fromNumber: row.from_number,
      fromName: row.from_name,
      queueName: row.queue_name,
      waitTimeSeconds: Number(row.wait_time_seconds || 0),
      abandonedAt: row.abandoned_at,
    })),
  };
}

async function agentAdherenceReport(pool, { from, to }) {
  // Status timeline from the activity log (status_change rows carry
  // started_at/ended_at/duration via the user-status manager).
  const statusBreakdownQuery = `
    SELECT
      u.username,
      MAX(u.first_name) AS first_name,
      MAX(u.last_name) AS last_name,
      l.activity_value AS status,
      COUNT(*)::int AS changes,
      SUM(COALESCE(l.duration_seconds, 0))::bigint AS duration_seconds
    FROM cc_user_activity_log l
    JOIN users u ON u.id = l.user_id
    WHERE l.activity_type = 'status_change'
      AND l.created_at >= $1 AND l.created_at <= $2
    GROUP BY u.username, l.activity_value
    ORDER BY u.username ASC
    LIMIT 1000
  `;

  const loginsQuery = `
    SELECT
      u.username,
      COUNT(*) FILTER (WHERE l.activity_type = 'login')::int AS logins,
      MIN(l.created_at) FILTER (WHERE l.activity_type = 'login') AS first_login,
      MAX(l.created_at) FILTER (WHERE l.activity_type = 'logout') AS last_logout
    FROM cc_user_activity_log l
    JOIN users u ON u.id = l.user_id
    WHERE l.activity_type IN ('login', 'logout')
      AND l.created_at >= $1 AND l.created_at <= $2
    GROUP BY u.username
    LIMIT 200
  `;

  const timeTrackingQuery = `
    SELECT
      u.username,
      SUM(t.logged_in_seconds)::bigint AS logged_in_seconds,
      SUM(t.call_seconds)::bigint AS call_seconds,
      SUM(t.break_seconds)::bigint AS break_seconds,
      SUM(t.status_available_seconds)::bigint AS available_seconds,
      SUM(t.status_change_count)::int AS status_changes
    FROM cc_user_time_tracking t
    JOIN users u ON u.id = t.user_id
    WHERE t.tracking_date >= DATE($1) AND t.tracking_date <= DATE($2)
    GROUP BY u.username
    LIMIT 200
  `;

  const recentTransitionsQuery = `
    SELECT
      h.agent_username,
      h.status,
      h.previous_status,
      h.duration_seconds,
      h.created_at
    FROM cc_agent_status_history h
    WHERE h.created_at >= $1 AND h.created_at <= $2
    ORDER BY h.created_at DESC
    LIMIT 100
  `;

  const [statusRes, loginsRes, trackingRes, transitionsRes] = await Promise.all([
    pool.query(statusBreakdownQuery, [from, to]),
    pool.query(loginsQuery, [from, to]),
    pool.query(timeTrackingQuery, [from, to]),
    pool.query(recentTransitionsQuery, [from, to]),
  ]);

  const agentsMap = new Map();
  const ensureAgent = (username) => {
    if (!agentsMap.has(username)) {
      agentsMap.set(username, {
        username,
        name: username,
        statuses: {},
        statusChanges: 0,
        logins: 0,
        firstLogin: null,
        lastLogout: null,
        loggedInSeconds: 0,
        callSeconds: 0,
        breakSeconds: 0,
        availableSeconds: 0,
      });
    }
    return agentsMap.get(username);
  };

  for (const row of statusRes.rows) {
    const agent = ensureAgent(row.username);
    if (row.first_name || row.last_name) {
      agent.name = `${row.first_name || ""} ${row.last_name || ""}`.trim();
    }
    const status = row.status || "Unknown";
    agent.statuses[status] = {
      changes: Number(row.changes || 0),
      durationSeconds: Number(row.duration_seconds || 0),
    };
    agent.statusChanges += Number(row.changes || 0);
  }
  for (const row of loginsRes.rows) {
    const agent = ensureAgent(row.username);
    agent.logins = Number(row.logins || 0);
    agent.firstLogin = row.first_login;
    agent.lastLogout = row.last_logout;
  }
  for (const row of trackingRes.rows) {
    const agent = ensureAgent(row.username);
    agent.loggedInSeconds = Number(row.logged_in_seconds || 0);
    agent.callSeconds = Number(row.call_seconds || 0);
    agent.breakSeconds = Number(row.break_seconds || 0);
    agent.availableSeconds = Number(row.available_seconds || 0);
  }

  const agents = Array.from(agentsMap.values()).map((agent) => ({
    ...agent,
    occupancyPct:
      agent.loggedInSeconds > 0
        ? Math.min(100, Math.round((agent.callSeconds / agent.loggedInSeconds) * 100))
        : null,
    availabilityPct:
      agent.loggedInSeconds > 0
        ? Math.min(100, Math.round((agent.availableSeconds / agent.loggedInSeconds) * 100))
        : null,
  }));

  // Aggregate status mix across all agents for the donut/bars.
  const statusTotals = {};
  for (const agent of agents) {
    for (const [status, value] of Object.entries(agent.statuses)) {
      if (!statusTotals[status]) statusTotals[status] = { changes: 0, durationSeconds: 0 };
      statusTotals[status].changes += value.changes;
      statusTotals[status].durationSeconds += value.durationSeconds;
    }
  }
  const statusMix = Object.entries(statusTotals)
    .map(([status, value]) => ({ status, ...value }))
    .sort((a, b) => b.durationSeconds - a.durationSeconds)
    .slice(0, 12);

  return {
    totals: {
      agents: agents.length,
      statusChanges: agents.reduce((sum, agent) => sum + agent.statusChanges, 0),
      logins: agents.reduce((sum, agent) => sum + agent.logins, 0),
    },
    statusMix,
    agents: agents.sort((a, b) => b.statusChanges - a.statusChanges).slice(0, 100),
    recentTransitions: transitionsRes.rows.map((row) => ({
      agentUsername: row.agent_username,
      status: row.status,
      previousStatus: row.previous_status,
      durationSeconds: Number(row.duration_seconds || 0),
      createdAt: row.created_at,
    })),
  };
}

async function transfersHoldsReport(pool, { from, to, queueName }) {
  const { where, vals } = baseFilters({ from, to, queueName });
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const totalsQuery = `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE COALESCE(i.transfer_count, 0) > 0)::int AS with_transfers,
      SUM(COALESCE(i.transfer_count, 0))::int AS transfer_count,
      COUNT(*) FILTER (WHERE COALESCE(i.hold_count, 0) > 0)::int AS with_holds,
      SUM(COALESCE(i.hold_count, 0))::int AS hold_count,
      SUM(COALESCE(i.hold_duration_seconds, 0))::bigint AS hold_duration_seconds,
      AVG(i.hold_duration_seconds) FILTER (WHERE COALESCE(i.hold_count, 0) > 0)::NUMERIC(10,2) AS avg_hold_seconds,
      MAX(i.hold_duration_seconds)::int AS max_hold_seconds
    FROM cc_interactions i
    ${whereSql}
  `;

  const byAgentQuery = `
    SELECT
      i.agent_username,
      MAX(u.first_name) AS first_name,
      MAX(u.last_name) AS last_name,
      COUNT(*)::int AS handled,
      SUM(COALESCE(i.transfer_count, 0))::int AS transfer_count,
      SUM(COALESCE(i.hold_count, 0))::int AS hold_count,
      SUM(COALESCE(i.hold_duration_seconds, 0))::bigint AS hold_duration_seconds
    FROM cc_interactions i
    LEFT JOIN users u ON u.username = i.agent_username
    ${whereSql} AND i.agent_username IS NOT NULL
    GROUP BY i.agent_username
    ORDER BY (SUM(COALESCE(i.transfer_count, 0)) + SUM(COALESCE(i.hold_count, 0))) DESC
    LIMIT 50
  `;

  const byQueueQuery = `
    SELECT
      COALESCE(i.queue_name, 'No queue') AS queue_name,
      COUNT(*)::int AS total,
      SUM(COALESCE(i.transfer_count, 0))::int AS transfer_count,
      SUM(COALESCE(i.hold_count, 0))::int AS hold_count,
      AVG(i.hold_duration_seconds) FILTER (WHERE COALESCE(i.hold_count, 0) > 0)::NUMERIC(10,2) AS avg_hold_seconds
    FROM cc_interactions i
    ${whereSql}
    GROUP BY COALESCE(i.queue_name, 'No queue')
    ORDER BY total DESC
    LIMIT 50
  `;

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
    FROM cc_interactions i
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
      transferRatePct: totalCalls > 0 ? Math.round((Number(totals.with_transfers || 0) / totalCalls) * 100) : 0,
      withHolds: Number(totals.with_holds || 0),
      holdCount: Number(totals.hold_count || 0),
      holdRatePct: totalCalls > 0 ? Math.round((Number(totals.with_holds || 0) / totalCalls) * 100) : 0,
      holdDurationSeconds: Number(totals.hold_duration_seconds || 0),
      avgHoldSeconds: Number(totals.avg_hold_seconds || 0),
      maxHoldSeconds: Number(totals.max_hold_seconds || 0),
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
        transferRatePct: handled > 0 ? Math.round((Number(row.transfer_count || 0) / handled) * 100) : 0,
        holdCount: Number(row.hold_count || 0),
        holdDurationSeconds: Number(row.hold_duration_seconds || 0),
      };
    }),
    queues: byQueueRes.rows.map((row) => ({
      queueName: row.queue_name,
      total: Number(row.total || 0),
      transferCount: Number(row.transfer_count || 0),
      holdCount: Number(row.hold_count || 0),
      avgHoldSeconds: Number(row.avg_hold_seconds || 0),
    })),
    longestHolds: longestRes.rows.map((row) => ({
      id: row.id,
      queueName: row.queue_name,
      agentUsername: row.agent_username,
      fromNumber: row.from_number,
      fromName: row.from_name,
      holdCount: Number(row.hold_count || 0),
      holdDurationSeconds: Number(row.hold_duration_seconds || 0),
      happenedAt: row.happened_at,
    })),
  };
}

async function wrapupCodesReport(pool, { from, to, queueName }) {
  const { where, vals } = baseFilters({ from, to, queueName });
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const codesQuery = `
    SELECT
      code.value AS code_id,
      COALESCE(MAX(w.name), code.value) AS code_name,
      COUNT(*)::int AS total
    FROM cc_interactions i
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(i.wrapup_codes, '[]'::jsonb)) AS code(value)
    LEFT JOIN cc_wrapup_codes w ON w.id = code.value
    ${whereSql}
    GROUP BY code.value
    ORDER BY total DESC
    LIMIT 30
  `;

  const dailyQuery = `
    SELECT
      DATE(COALESCE(i.completed_at, i.abandoned_at, i.created_at)) AS day,
      code.value AS code_id,
      COALESCE(MAX(w.name), code.value) AS code_name,
      COUNT(*)::int AS total
    FROM cc_interactions i
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(i.wrapup_codes, '[]'::jsonb)) AS code(value)
    LEFT JOIN cc_wrapup_codes w ON w.id = code.value
    ${whereSql}
    GROUP BY 1, code.value
    ORDER BY 1 ASC
    LIMIT 1000
  `;

  const byQueueQuery = `
    SELECT
      COALESCE(i.queue_name, 'No queue') AS queue_name,
      code.value AS code_id,
      COALESCE(MAX(w.name), code.value) AS code_name,
      COUNT(*)::int AS total
    FROM cc_interactions i
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(i.wrapup_codes, '[]'::jsonb)) AS code(value)
    LEFT JOIN cc_wrapup_codes w ON w.id = code.value
    ${whereSql}
    GROUP BY COALESCE(i.queue_name, 'No queue'), code.value
    ORDER BY total DESC
    LIMIT 300
  `;

  const coverageQuery = `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(i.wrapup_codes, '[]'::jsonb)) > 0)::int AS with_codes
    FROM cc_interactions i
    ${whereSql} AND i.state = 'completed'
  `;

  const [codesRes, dailyRes, byQueueRes, coverageRes] = await Promise.all([
    pool.query(codesQuery, vals),
    pool.query(dailyQuery, vals),
    pool.query(byQueueQuery, vals),
    pool.query(coverageQuery, vals),
  ]);

  const coverage = coverageRes.rows?.[0] || {};
  const completedTotal = Number(coverage.total || 0);
  const withCodes = Number(coverage.with_codes || 0);

  // Pivot daily rows into one object per day for stacked charts; keep the top
  // five codes as series and fold the rest into "other".
  const topCodes = codesRes.rows.slice(0, 5).map((row) => row.code_name);
  const dailyByDay = new Map();
  for (const row of dailyRes.rows) {
    const dayKey = String(row.day);
    if (!dailyByDay.has(dayKey)) {
      dailyByDay.set(dayKey, {
        day: row.day,
        label: new Date(row.day).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        other: 0,
      });
    }
    const entry = dailyByDay.get(dayKey);
    const codeName = row.code_name;
    if (topCodes.includes(codeName)) {
      entry[codeName] = (entry[codeName] || 0) + Number(row.total || 0);
    } else {
      entry.other += Number(row.total || 0);
    }
  }

  return {
    totals: {
      completed: completedTotal,
      withCodes,
      coveragePct: completedTotal > 0 ? Math.round((withCodes / completedTotal) * 100) : 0,
      distinctCodes: codesRes.rows.length,
    },
    codes: codesRes.rows.map((row) => ({
      codeId: row.code_id,
      codeName: row.code_name,
      total: Number(row.total || 0),
    })),
    topCodes,
    daily: Array.from(dailyByDay.values()),
    byQueue: byQueueRes.rows.map((row) => ({
      queueName: row.queue_name,
      codeId: row.code_id,
      codeName: row.code_name,
      total: Number(row.total || 0),
    })),
  };
}

async function aiHandoffsReport(pool, { from, to, queueName }) {
  const { where, vals } = baseFilters({ from, to, queueName });
  const whereSql = `WHERE ${where.join(" AND ")}`;

  // Containment: AI-involved interactions that were NOT handed to an agent
  // never appear in cc_interactions, so containment is measured from
  // aa_ai_handoff_events vs ai-tagged interactions in range.
  const handoffTotalsQuery = `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE h.status = 'processed')::int AS processed,
      COUNT(*) FILTER (WHERE h.status LIKE 'pending%')::int AS pending,
      COUNT(*) FILTER (WHERE h.status NOT IN ('processed') AND h.status NOT LIKE 'pending%')::int AS failed,
      COUNT(*) FILTER (WHERE h.error_message IS NOT NULL)::int AS with_errors
    FROM aa_ai_handoff_events h
    WHERE h.created_at >= $1 AND h.created_at <= $2
  `;

  const aiInteractionsQuery = `
    SELECT
      COUNT(*)::int AS ai_handled,
      COUNT(*) FILTER (WHERE i.state = 'completed')::int AS completed,
      AVG(i.handle_time_seconds) FILTER (WHERE i.state = 'completed')::NUMERIC(10,2) AS avg_handle_seconds,
      AVG(i.wait_time_seconds)::NUMERIC(10,2) AS avg_wait_seconds
    FROM cc_interactions i
    ${whereSql} AND i.metadata->>'ai_call_control_id' IS NOT NULL
  `;

  const byQueueQuery = `
    SELECT
      COALESCE(i.queue_name, 'No queue') AS queue_name,
      COUNT(*)::int AS handoffs,
      COUNT(*) FILTER (WHERE i.state = 'completed')::int AS completed,
      AVG(i.handle_time_seconds) FILTER (WHERE i.state = 'completed')::NUMERIC(10,2) AS avg_handle_seconds
    FROM cc_interactions i
    ${whereSql} AND i.metadata->>'ai_call_control_id' IS NOT NULL
    GROUP BY COALESCE(i.queue_name, 'No queue')
    ORDER BY handoffs DESC
    LIMIT 50
  `;

  const dailyQuery = `
    SELECT
      DATE(h.created_at) AS day,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE h.status = 'processed')::int AS processed
    FROM aa_ai_handoff_events h
    WHERE h.created_at >= $1 AND h.created_at <= $2
    GROUP BY 1
    ORDER BY 1 ASC
    LIMIT ${MAX_RANGE_DAYS + 1}
  `;

  const recentQuery = `
    SELECT
      h.id,
      h.interaction_id,
      h.status,
      h.error_message,
      h.created_at,
      i.queue_name,
      i.agent_username,
      i.from_number,
      i.from_name
    FROM aa_ai_handoff_events h
    LEFT JOIN cc_interactions i ON i.id = h.interaction_id
    WHERE h.created_at >= $1 AND h.created_at <= $2
    ORDER BY h.created_at DESC
    LIMIT 50
  `;

  const [handoffRes, aiRes, byQueueRes, dailyRes, recentRes] = await Promise.all([
    pool.query(handoffTotalsQuery, [from, to]),
    pool.query(aiInteractionsQuery, vals),
    pool.query(byQueueQuery, vals),
    pool.query(dailyQuery, [from, to]),
    pool.query(recentQuery, [from, to]),
  ]);

  const handoffTotals = handoffRes.rows?.[0] || {};
  const aiTotals = aiRes.rows?.[0] || {};

  return {
    totals: {
      handoffs: Number(handoffTotals.total || 0),
      processed: Number(handoffTotals.processed || 0),
      pending: Number(handoffTotals.pending || 0),
      failed: Number(handoffTotals.failed || 0),
      withErrors: Number(handoffTotals.with_errors || 0),
      processedRatePct:
        Number(handoffTotals.total || 0) > 0
          ? Math.round((Number(handoffTotals.processed || 0) / Number(handoffTotals.total || 0)) * 100)
          : 0,
      aiHandledInteractions: Number(aiTotals.ai_handled || 0),
      aiCompleted: Number(aiTotals.completed || 0),
      avgHandleSecondsAfterHandoff: Number(aiTotals.avg_handle_seconds || 0),
      avgWaitSecondsAfterHandoff: Number(aiTotals.avg_wait_seconds || 0),
    },
    daily: dailyRes.rows.map((row) => ({
      day: row.day,
      label: new Date(row.day).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      total: Number(row.total || 0),
      processed: Number(row.processed || 0),
    })),
    byQueue: byQueueRes.rows.map((row) => ({
      queueName: row.queue_name,
      handoffs: Number(row.handoffs || 0),
      completed: Number(row.completed || 0),
      avgHandleSeconds: Number(row.avg_handle_seconds || 0),
    })),
    recent: recentRes.rows.map((row) => ({
      id: row.id,
      interactionId: row.interaction_id,
      status: row.status,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      queueName: row.queue_name,
      agentUsername: row.agent_username,
      fromNumber: row.from_number,
      fromName: row.from_name,
    })),
  };
}

async function outboundCampaignsReport(pool, { from, to }) {
  const campaignsQuery = `
    SELECT
      c.id,
      c.name,
      c.status AS campaign_status,
      COUNT(DISTINCT r.id)::int AS runs,
      MAX(r.started_at) AS last_run_at,
      COUNT(l.id)::int AS attempts,
      COUNT(l.id) FILTER (WHERE l.status = 'answered')::int AS answered,
      COUNT(l.id) FILTER (WHERE l.status = 'completed')::int AS completed,
      COUNT(l.id) FILTER (WHERE l.status = 'failed')::int AS failed,
      COUNT(l.id) FILTER (WHERE l.status IN ('suppressed', 'skipped', 'cancelled'))::int AS suppressed
    FROM outbound_campaigns c
    LEFT JOIN outbound_campaign_runs r
      ON r.campaign_id = c.id AND r.started_at >= $1 AND r.started_at <= $2
    LEFT JOIN outbound_attempt_ledger l
      ON l.campaign_id = c.id AND l.created_at >= $1 AND l.created_at <= $2
    GROUP BY c.id, c.name, c.status
    ORDER BY attempts DESC, c.name ASC
    LIMIT 50
  `;

  const funnelQuery = `
    SELECT
      l.status,
      COUNT(*)::int AS total
    FROM outbound_attempt_ledger l
    WHERE l.created_at >= $1 AND l.created_at <= $2
    GROUP BY l.status
    ORDER BY total DESC
  `;

  const hourlyQuery = `
    SELECT
      EXTRACT(HOUR FROM l.created_at)::int AS hour,
      COUNT(*)::int AS attempts,
      COUNT(*) FILTER (WHERE l.status IN ('answered', 'completed'))::int AS connected
    FROM outbound_attempt_ledger l
    WHERE l.created_at >= $1 AND l.created_at <= $2
    GROUP BY 1
    ORDER BY 1
    LIMIT 24
  `;

  const failuresQuery = `
    SELECT
      COALESCE(NULLIF(TRIM(l.failure_reason), ''), 'Unspecified') AS reason,
      COUNT(*)::int AS total
    FROM outbound_attempt_ledger l
    WHERE l.created_at >= $1 AND l.created_at <= $2 AND l.status = 'failed'
    GROUP BY 1
    ORDER BY total DESC
    LIMIT 12
  `;

  const recentRunsQuery = `
    SELECT
      r.id,
      c.name AS campaign_name,
      r.status,
      r.started_by,
      r.stop_reason,
      r.started_at,
      r.stopped_at
    FROM outbound_campaign_runs r
    JOIN outbound_campaigns c ON c.id = r.campaign_id
    WHERE r.started_at >= $1 AND r.started_at <= $2
    ORDER BY r.started_at DESC
    LIMIT 25
  `;

  const [campaignsRes, funnelRes, hourlyRes, failuresRes, runsRes] = await Promise.all([
    pool.query(campaignsQuery, [from, to]),
    pool.query(funnelQuery, [from, to]),
    pool.query(hourlyQuery, [from, to]),
    pool.query(failuresQuery, [from, to]),
    pool.query(recentRunsQuery, [from, to]),
  ]);

  const campaigns = campaignsRes.rows.map((row) => {
    const attempts = Number(row.attempts || 0);
    const connected = Number(row.answered || 0) + Number(row.completed || 0);
    return {
      id: row.id,
      name: row.name,
      campaignStatus: row.campaign_status,
      runs: Number(row.runs || 0),
      lastRunAt: row.last_run_at,
      attempts,
      answered: Number(row.answered || 0),
      completed: Number(row.completed || 0),
      failed: Number(row.failed || 0),
      suppressed: Number(row.suppressed || 0),
      connectRatePct: attempts > 0 ? Math.round((connected / attempts) * 100) : 0,
    };
  });

  const totals = campaigns.reduce(
    (acc, c) => {
      acc.attempts += c.attempts;
      acc.answered += c.answered;
      acc.completed += c.completed;
      acc.failed += c.failed;
      acc.suppressed += c.suppressed;
      acc.runs += c.runs;
      return acc;
    },
    { attempts: 0, answered: 0, completed: 0, failed: 0, suppressed: 0, runs: 0 },
  );

  return {
    totals: {
      ...totals,
      campaigns: campaigns.length,
      connectRatePct:
        totals.attempts > 0
          ? Math.round(((totals.answered + totals.completed) / totals.attempts) * 100)
          : 0,
    },
    campaigns,
    funnel: funnelRes.rows.map((row) => ({
      status: row.status,
      total: Number(row.total || 0),
    })),
    hourly: hourlyRes.rows.map((row) => ({
      hour: Number(row.hour || 0),
      label: `${String(row.hour).padStart(2, "0")}:00`,
      attempts: Number(row.attempts || 0),
      connected: Number(row.connected || 0),
    })),
    failures: failuresRes.rows.map((row) => ({
      reason: row.reason,
      total: Number(row.total || 0),
    })),
    recentRuns: runsRes.rows.map((row) => ({
      id: row.id,
      campaignName: row.campaign_name,
      status: row.status,
      startedBy: row.started_by,
      stopReason: row.stop_reason,
      startedAt: row.started_at,
      stoppedAt: row.stopped_at,
    })),
  };
}

async function skillsGapReport(pool, { from, to }) {
  // Skill supply: active agents and their proficiency per skill (users.skills
  // is JSONB {skill_uuid: proficiency 1-5}).
  const supplyQuery = `
    SELECT
      s.id AS skill_id,
      s.name AS skill_name,
      COUNT(u.id)::int AS agents,
      COALESCE(AVG((u.skills ->> s.id)::numeric), 0)::NUMERIC(10,2) AS avg_proficiency,
      COALESCE(MAX((u.skills ->> s.id)::int), 0)::int AS max_proficiency
    FROM skills s
    LEFT JOIN users u ON u.skills ? s.id
    WHERE s.is_active = true
    GROUP BY s.id, s.name
    ORDER BY s.name ASC
    LIMIT 100
  `;

  // Skill demand: required_skills on interactions in range ({skill_name: level}).
  const demandQuery = `
    SELECT
      req.key AS skill_name,
      COUNT(*)::int AS interactions,
      AVG(req.value::numeric)::NUMERIC(10,2) AS avg_required_level,
      COUNT(*) FILTER (WHERE i.state = 'abandoned')::int AS abandoned,
      AVG(i.wait_time_seconds)::NUMERIC(10,2) AS avg_wait_seconds
    FROM cc_interactions i
    CROSS JOIN LATERAL jsonb_each_text(COALESCE(i.required_skills, '{}'::jsonb)) AS req(key, value)
    WHERE i.is_contact_center = true
      AND COALESCE(i.completed_at, i.abandoned_at, i.created_at) >= $1
      AND COALESCE(i.completed_at, i.abandoned_at, i.created_at) <= $2
    GROUP BY req.key
    ORDER BY interactions DESC
    LIMIT 100
  `;

  // Queue requirements: cc_queues.skill_requirements is {skill_uuid: level}.
  const queueReqsQuery = `
    SELECT
      q.name AS queue_name,
      s.name AS skill_name,
      (q.skill_requirements ->> s.id)::int AS required_level,
      (
        SELECT COUNT(*)::int
        FROM users u
        WHERE (u.skills ->> s.id)::int >= (q.skill_requirements ->> s.id)::int
      ) AS qualified_agents
    FROM cc_queues q
    JOIN skills s ON q.skill_requirements ? s.id
    WHERE q.skill_requirements IS NOT NULL AND q.skill_requirements != '{}'::jsonb
    ORDER BY q.name ASC, s.name ASC
    LIMIT 200
  `;

  const [supplyRes, demandRes, queueReqsRes] = await Promise.all([
    pool.query(supplyQuery),
    pool.query(demandQuery, [from, to]),
    pool.query(queueReqsQuery),
  ]);

  const supply = supplyRes.rows.map((row) => ({
    skillId: row.skill_id,
    skillName: row.skill_name,
    agents: Number(row.agents || 0),
    avgProficiency: Number(row.avg_proficiency || 0),
    maxProficiency: Number(row.max_proficiency || 0),
  }));
  const supplyByName = new Map(supply.map((row) => [row.skillName, row]));

  const demand = demandRes.rows.map((row) => {
    const matchingSupply = supplyByName.get(row.skill_name);
    const interactions = Number(row.interactions || 0);
    const abandoned = Number(row.abandoned || 0);
    return {
      skillName: row.skill_name,
      interactions,
      avgRequiredLevel: Number(row.avg_required_level || 0),
      abandoned,
      abandonRatePct: interactions > 0 ? Math.round((abandoned / interactions) * 100) : 0,
      avgWaitSeconds: Number(row.avg_wait_seconds || 0),
      agentsWithSkill: matchingSupply ? matchingSupply.agents : 0,
      avgProficiency: matchingSupply ? matchingSupply.avgProficiency : 0,
      coverageGap: matchingSupply
        ? Math.max(0, Number(row.avg_required_level || 0) - matchingSupply.avgProficiency)
        : Number(row.avg_required_level || 0),
    };
  });

  return {
    totals: {
      skills: supply.length,
      skillsInDemand: demand.length,
      uncoveredSkills: demand.filter((row) => row.agentsWithSkill === 0).length,
      totalSkilledAgents: supply.reduce((max, row) => Math.max(max, row.agents), 0),
    },
    supply,
    demand,
    queueRequirements: queueReqsRes.rows.map((row) => ({
      queueName: row.queue_name,
      skillName: row.skill_name,
      requiredLevel: Number(row.required_level || 0),
      qualifiedAgents: Number(row.qualified_agents || 0),
    })),
  };
}

const CRADLE_HIDDEN_EVENTS = new Set(["agent_timeout"]);

async function cradleToGraveReport(pool, { from, to, queueName }) {
  const { where, vals, paramIndex } = baseFilters({ from, to, queueName });
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const interactionsQuery = `
    SELECT
      i.id,
      i.queue_name,
      i.agent_username,
      i.direction,
      i.state,
      i.from_number,
      i.from_name,
      i.enqueued_at,
      i.assigned_at,
      i.answered_at,
      i.completed_at,
      i.abandoned_at,
      i.created_at,
      i.wait_time_seconds,
      i.handle_time_seconds,
      i.talk_time_seconds,
      i.hold_count,
      i.hold_duration_seconds,
      i.transfer_count,
      i.recording_url,
      (i.metadata->>'ai_call_control_id') IS NOT NULL AS has_ai,
      COALESCE(jsonb_array_length(i.routing_metadata->'timeline'), 0)::int AS timeline_events,
      i.routing_metadata->'timeline' AS timeline
    FROM cc_interactions i
    ${whereSql}
    ORDER BY COALESCE(i.completed_at, i.abandoned_at, i.created_at) DESC
    LIMIT $${paramIndex}
  `;

  const limit = 30;
  const interactionsRes = await pool.query(interactionsQuery, [...vals, limit]);

  const interactions = interactionsRes.rows.map((row) => {
    let timeline = [];
    if (Array.isArray(row.timeline)) {
      timeline = row.timeline;
    } else if (typeof row.timeline === "string") {
      try {
        timeline = JSON.parse(row.timeline) || [];
      } catch {
        timeline = [];
      }
    }
    const events = (Array.isArray(timeline) ? timeline : [])
      .filter((event) => event && !CRADLE_HIDDEN_EVENTS.has(event.type))
      .map((event) => ({
        type: event.type || "event",
        at: event.at || event.timestamp || event.time || null,
        detail:
          event.agent ||
          event.agent_username ||
          event.queue ||
          event.queue_name ||
          event.reason ||
          null,
      }));
    return {
      id: row.id,
      queueName: row.queue_name,
      agentUsername: row.agent_username,
      direction: row.direction,
      state: row.state,
      fromNumber: row.from_number,
      fromName: row.from_name,
      startedAt: row.answered_at || row.assigned_at || row.enqueued_at || row.created_at,
      endedAt: row.completed_at || row.abandoned_at,
      waitTimeSeconds: Number(row.wait_time_seconds || 0),
      handleTimeSeconds: Number(row.handle_time_seconds || 0),
      talkTimeSeconds: Number(row.talk_time_seconds || 0),
      holdCount: Number(row.hold_count || 0),
      holdDurationSeconds: Number(row.hold_duration_seconds || 0),
      transferCount: Number(row.transfer_count || 0),
      hasRecording: Boolean(row.recording_url),
      hasAi: Boolean(row.has_ai),
      timelineEvents: Number(row.timeline_events || 0),
      timeline: events.slice(0, 40),
    };
  });

  return {
    totals: {
      interactions: interactions.length,
      withTimeline: interactions.filter((row) => row.timelineEvents > 0).length,
      withRecording: interactions.filter((row) => row.hasRecording).length,
      withAi: interactions.filter((row) => row.hasAi).length,
    },
    interactions,
  };
}

export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const report = searchParams.get("report");
    if (!REPORTS.includes(report)) {
      return NextResponse.json(
        { ok: false, error: `Unknown report. Expected one of: ${REPORTS.join(", ")}` },
        { status: 400 },
      );
    }

    const { from, to } = clampDateRange(searchParams.get("from"), searchParams.get("to"));
    const queueName = searchParams.get("queue") || null;
    const slaSeconds = Math.min(
      300,
      Math.max(5, Number(searchParams.get("sla") || DEFAULT_SLA_SECONDS)),
    );

    let data;
    if (report === "queue-performance") {
      data = await queuePerformanceReport(pool, { from, to, queueName, slaSeconds });
    } else if (report === "agent-performance") {
      data = await agentPerformanceReport(pool, { from, to, queueName });
    } else if (report === "agent-adherence") {
      data = await agentAdherenceReport(pool, { from, to });
    } else if (report === "transfers-holds") {
      data = await transfersHoldsReport(pool, { from, to, queueName });
    } else if (report === "wrapup-codes") {
      data = await wrapupCodesReport(pool, { from, to, queueName });
    } else if (report === "ai-handoffs") {
      data = await aiHandoffsReport(pool, { from, to, queueName });
    } else if (report === "outbound-campaigns") {
      data = await outboundCampaignsReport(pool, { from, to });
    } else if (report === "skills-gap") {
      data = await skillsGapReport(pool, { from, to });
    } else if (report === "cradle-to-grave") {
      data = await cradleToGraveReport(pool, { from, to, queueName });
    } else {
      data = await abandonmentReport(pool, { from, to, queueName });
    }

    return NextResponse.json({ ok: true, report, range: { from, to }, data });
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error }) });
    return NextResponse.json(
      { ok: false, error: "Failed to build analytics report" },
      { status: 500 },
    );
  }
}
