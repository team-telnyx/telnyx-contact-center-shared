import { effectiveAgentStatusSql } from "./agent-state.mjs";
const MAX_RANGE_DAYS = 366;
export async function agentAdherenceReport(pool, { from, to, agentId = null }) {
  // Core records each closed effective-status interval exactly once.
  const statusBreakdownQuery = `
    WITH intervals AS (SELECT user_id,status,status_type,started_at,ended_at,true AS closed FROM cc_agent_status_intervals
  UNION ALL SELECT a.agent_id,${effectiveAgentStatusSql("a")},CASE WHEN a.workflow_state='idle' THEN COALESCE(us.type,'active') ELSE 'active' END,
    a.status_started_at,now(),false FROM acd_agent_state a LEFT JOIN cc_user_statuses us ON us.id=a.status_id)
    SELECT
      u.username,
      MAX(u.first_name) AS first_name,
      MAX(u.last_name) AS last_name,
      l.status,
      COUNT(*) FILTER(WHERE l.closed AND l.ended_at<$2)::int AS changes,
      SUM(GREATEST(0, EXTRACT(EPOCH FROM (
        LEAST(l.ended_at, $2::timestamptz) -
        GREATEST(l.started_at, $1::timestamptz)
      ))))::bigint AS duration_seconds
    FROM intervals l
    JOIN users u ON u.id = l.user_id
    WHERE l.ended_at >= $1 AND l.started_at < $2
    AND ($3::text IS NULL OR u.id=$3)
    GROUP BY u.username, l.status
    ORDER BY u.username ASC

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
      AND l.created_at >= $1 AND l.created_at < $2
    AND ($3::text IS NULL OR u.id=$3)
    GROUP BY u.username

  `;

  const timeTrackingQuery = `
    WITH intervals AS (SELECT user_id,status,status_type,started_at,ended_at,true AS closed FROM cc_agent_status_intervals
  UNION ALL SELECT a.agent_id,${effectiveAgentStatusSql("a")},CASE WHEN a.workflow_state='idle' THEN COALESCE(us.type,'active') ELSE 'active' END,
    a.status_started_at,now(),false FROM acd_agent_state a LEFT JOIN cc_user_statuses us ON us.id=a.status_id)
    SELECT
      u.username,
      SUM(span.seconds) FILTER (WHERE t.status <> 'Offline')::bigint AS logged_in_seconds,
      SUM(span.seconds) FILTER (WHERE t.status = 'Busy')::bigint AS call_seconds,
      SUM(span.seconds) FILTER (WHERE t.status_type = 'break')::bigint AS break_seconds,
      SUM(span.seconds) FILTER (WHERE t.status = 'Available')::bigint AS available_seconds,
      COUNT(*)::int AS status_changes
    FROM intervals t
    JOIN users u ON u.id = t.user_id
    CROSS JOIN LATERAL (
      SELECT GREATEST(0, EXTRACT(EPOCH FROM (
        LEAST(t.ended_at, $2::timestamptz) -
        GREATEST(t.started_at, $1::timestamptz)
      )))::bigint AS seconds
    ) span
    WHERE t.ended_at >= $1 AND t.started_at < $2
    AND ($3::text IS NULL OR u.id=$3)
    GROUP BY u.username

  `;

  const recentTransitionsQuery = `
    SELECT
      h.agent_username,
      h.next_status AS status,
      h.status AS previous_status,
      h.duration_seconds,
      h.ended_at AS created_at
    FROM cc_agent_status_intervals h
    WHERE h.ended_at >= $1 AND h.ended_at < $2
    AND ($3::text IS NULL OR h.user_id=$3)
    ORDER BY h.ended_at DESC LIMIT 100

  `;

  const [statusRes, loginsRes, trackingRes, transitionsRes] = await Promise.all(
    [
      pool.query(statusBreakdownQuery, [from, to, agentId]),
      pool.query(loginsQuery, [from, to, agentId]),
      pool.query(timeTrackingQuery, [from, to, agentId]),
      pool.query(recentTransitionsQuery, [from, to, agentId]),
    ],
  );

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
        ? Math.min(
            100,
            Math.round((agent.callSeconds / agent.loggedInSeconds) * 100),
          )
        : null,
    availabilityPct:
      agent.loggedInSeconds > 0
        ? Math.min(
            100,
            Math.round((agent.availableSeconds / agent.loggedInSeconds) * 100),
          )
        : null,
  }));

  // Aggregate status mix across all agents for the donut/bars.
  const statusTotals = {};
  for (const agent of agents) {
    for (const [status, value] of Object.entries(agent.statuses)) {
      if (!statusTotals[status])
        statusTotals[status] = { changes: 0, durationSeconds: 0 };
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
      statusChanges: agents.reduce(
        (sum, agent) => sum + agent.statusChanges,
        0,
      ),
      logins: agents.reduce((sum, agent) => sum + agent.logins, 0),
    },
    statusMix,
    agents: agents.sort((a, b) => b.statusChanges - a.statusChanges),
    recentTransitions: transitionsRes.rows.map((row) => ({
      agentUsername: row.agent_username,
      status: row.status,
      previousStatus: row.previous_status,
      durationSeconds: Number(row.duration_seconds || 0),
      createdAt: row.created_at,
    })),
  };
}

export async function outboundCampaignsReport(pool, { from, to, campaignIds = null }) {
  // `campaignIds` (null = every campaign) narrows every section to the caller's campaign scope.
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
      ON l.campaign_id = c.id AND l.created_at >= $1 AND l.created_at < $2
    WHERE ($3::text[] IS NULL OR c.id::text = ANY($3::text[]))
    GROUP BY c.id, c.name, c.status
    ORDER BY attempts DESC, c.name ASC

  `;

  const funnelQuery = `
    SELECT
      l.status,
      COUNT(*)::int AS total
    FROM outbound_attempt_ledger l
    WHERE l.created_at >= $1 AND l.created_at < $2 AND ($3::text[] IS NULL OR l.campaign_id::text = ANY($3::text[]))
    GROUP BY l.status
    ORDER BY total DESC
  `;

  const hourlyQuery = `
    SELECT
      EXTRACT(HOUR FROM l.created_at)::int AS hour,
      COUNT(*)::int AS attempts,
      COUNT(*) FILTER (WHERE l.status IN ('answered', 'completed'))::int AS connected
    FROM outbound_attempt_ledger l
    WHERE l.created_at >= $1 AND l.created_at < $2 AND ($3::text[] IS NULL OR l.campaign_id::text = ANY($3::text[]))
    GROUP BY 1
    ORDER BY 1
    LIMIT 24
  `;

  const failuresQuery = `
    SELECT
      COALESCE(NULLIF(TRIM(l.failure_reason), ''), 'Unspecified') AS reason,
      COUNT(*)::int AS total
    FROM outbound_attempt_ledger l
    WHERE l.created_at >= $1 AND l.created_at < $2 AND l.status = 'failed' AND ($3::text[] IS NULL OR l.campaign_id::text = ANY($3::text[]))
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
    WHERE r.started_at >= $1 AND r.started_at <= $2 AND ($3::text[] IS NULL OR r.campaign_id::text = ANY($3::text[]))
    ORDER BY r.started_at DESC
    LIMIT 25
  `;

  const [campaignsRes, funnelRes, hourlyRes, failuresRes, runsRes] =
    await Promise.all([
      pool.query(campaignsQuery, [from, to, campaignIds]),
      pool.query(funnelQuery, [from, to, campaignIds]),
      pool.query(hourlyQuery, [from, to, campaignIds]),
      pool.query(failuresQuery, [from, to, campaignIds]),
      pool.query(recentRunsQuery, [from, to, campaignIds]),
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
      connectRatePct:
        attempts > 0 ? Math.round((connected / attempts) * 100) : 0,
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
    {
      attempts: 0,
      answered: 0,
      completed: 0,
      failed: 0,
      suppressed: 0,
      runs: 0,
    },
  );

  return {
    totals: {
      ...totals,
      campaigns: campaigns.length,
      connectRatePct:
        totals.attempts > 0
          ? Math.round(
              ((totals.answered + totals.completed) / totals.attempts) * 100,
            )
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
