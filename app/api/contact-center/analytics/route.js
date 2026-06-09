import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { contactCenterRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";

// Historical analytics for supervisors. Reports are computed directly from
// cc_interactions (source of truth) plus cc_user_time_tracking for agent
// occupancy, because the pre-aggregated statistics tables may lag or be empty
// on fresh deployments.

const REPORTS = ["queue-performance", "agent-performance", "abandonment"];
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
