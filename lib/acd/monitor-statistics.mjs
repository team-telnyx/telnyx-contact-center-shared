import { interactionScopeSql, queueScopeSql, agentScopeSql, campaignScopeSql, scopedChannels, interactionInScope } from "../authz/scope.mjs";
import { resolveReportingScope } from "./reporting-scope.mjs";
import { RELEASED_CHANNELS, channelDefinition } from "./channel-registry.mjs";
import { agentStatusPresentation } from "./agent-state.mjs";
import { readLiveWorkload, slaSummary } from "./interaction-reporting.mjs";
import {
  defaultChannelPolicy,
  effectiveChannelPolicy,
} from "./channel-policy.mjs";
const n = (value) => (value == null ? null : Number(value));
export async function readMonitorStatistics(pool, options = {}) {
  const scope = await resolveReportingScope(
    pool,
    new URLSearchParams({
      period: "today",
      timezone: options.timezone || "UTC",
      channel: options.channel || "all",
    }),
  );
  const restriction = options.restriction;
  const narrow = (columns) => interactionScopeSql(restriction, columns, null).map((part) => ` AND ${part}`).join("");
  const channels = scopedChannels(restriction, scope.channel, RELEASED_CHANNELS),
    args = [scope.from, scope.to, channels];
  const [
    queues,
    users,
    live,
    closed,
    agentHistory,
    sla,
    workload,
    assignments,
  ] = [
    await (pool.query(
      `SELECT id,name,display_name,enabled FROM cc_queues WHERE TRUE${queueScopeSql(restriction, "id", null).map((part) => ` AND ${part}`).join("")} ORDER BY name`,
    )),
    await (pool.query(
      `SELECT u.id,u.username,u.first_name,u.last_name,ast.*,
        ARRAY(SELECT DISTINCT capability.key FROM acd_agent_sessions session
          CROSS JOIN LATERAL jsonb_each_text(session.capabilities) capability
          WHERE session.agent_id=u.id AND session.state='online' AND session.expires_at>now() AND capability.value='true') AS ready_channels,
        EXISTS(SELECT 1 FROM acd_direct_intents d WHERE d.agent_id=u.id AND d.state='revoked' AND d.provider_call_id IS NOT NULL AND d.ended_at IS NULL) AS unconfirmed_origination
        FROM users u LEFT JOIN acd_agent_state ast ON ast.agent_id=u.id WHERE u.active=true${agentScopeSql(restriction, "u.id", null).map((part) => ` AND ${part}`).join("")}`,
    )),
    await (pool.query(
      `SELECT w.queue_id,w.channel,COUNT(*) FILTER(WHERE w.state='queued')::int AS queued,
      COUNT(*) FILTER(WHERE w.state='offered')::int AS offered,COUNT(*) FILTER(WHERE w.state='active')::int AS active,
      MAX(EXTRACT(EPOCH FROM now()-COALESCE(s.started_at,w.enqueued_at,w.created_at))) FILTER(WHERE w.state IN ('queued','offered')) AS longest_wait,
      AVG(EXTRACT(EPOCH FROM now()-COALESCE(s.started_at,w.enqueued_at,w.created_at))) FILTER(WHERE w.state IN ('queued','offered')) AS avg_wait
      FROM acd_work_items w LEFT JOIN LATERAL(SELECT started_at FROM acd_segments WHERE work_item_id=w.id AND kind='queue_wait' AND ended_at IS NULL ORDER BY seq DESC LIMIT 1) s ON true
      WHERE w.terminal_at IS NULL AND w.channel=ANY($1::text[])${narrow({ queue: "w.queue_id", workItem: "w.id", channel: "w.channel" })} GROUP BY w.queue_id,w.channel`,
      [channels],
    )),
    await (pool.query(
      `WITH closed AS (SELECT * FROM acd_history_interactions i WHERE terminal_at>=$1 AND terminal_at<$2 AND interaction_type=ANY($3::text[])${narrow({ queue: "i.queue_id", agent: "i.agent_id", workItem: "i.work_item_id", channel: "i.interaction_type" })}),
      records AS (SELECT 'global' AS scope,NULL::text AS queue_id,i.interaction_type AS channel,i.state,i.wait_time_seconds AS wait,i.handle_time_seconds AS handle,i.talk_time_seconds AS talk FROM closed i
        UNION ALL SELECT 'queue',v.queue_id,i.interaction_type,i.state,d.wait,d.handle,CASE WHEN i.interaction_type='voice' THEN d.talk END
        FROM closed i CROSS JOIN LATERAL(SELECT DISTINCT queue_id FROM acd_segments WHERE work_item_id=i.id UNION SELECT i.queue_id WHERE NOT EXISTS(SELECT 1 FROM acd_segments WHERE work_item_id=i.id)) v
        LEFT JOIN LATERAL(SELECT SUM(EXTRACT(EPOCH FROM s.ended_at-s.started_at)) FILTER(WHERE s.kind='queue_wait') AS wait,
          SUM(EXTRACT(EPOCH FROM s.ended_at-s.started_at)+CASE WHEN s.wrapup_ended_at IS NOT NULL THEN EXTRACT(EPOCH FROM s.wrapup_ended_at-s.ended_at) ELSE 0 END) FILTER(WHERE s.kind='agent') AS handle,
          SUM(EXTRACT(EPOCH FROM s.ended_at-s.answered_at)) FILTER(WHERE s.kind='agent') AS talk
          FROM acd_segments s WHERE s.work_item_id=i.id AND s.queue_id IS NOT DISTINCT FROM v.queue_id) d ON true)
      SELECT scope,queue_id,channel,COUNT(*)::int AS total,COUNT(*) FILTER(WHERE state='completed')::int AS completed,
        COUNT(*) FILTER(WHERE state='abandoned')::int AS abandoned,COUNT(*) FILTER(WHERE state='failed')::int AS failed,
        AVG(wait) AS avg_wait,COUNT(wait)::int AS avg_wait_count,MAX(wait) AS max_wait,AVG(handle) AS avg_handle,COUNT(handle)::int AS avg_handle_count,
        AVG(talk) FILTER(WHERE channel='voice') AS avg_talk,COUNT(talk) FILTER(WHERE channel='voice')::int AS avg_talk_count
      FROM records GROUP BY scope,queue_id,channel`,
      args,
    )),
    await (pool.query(
      `WITH participation AS (SELECT s.agent_id,w.id,w.channel,w.state,w.terminal_at,
        SUM(EXTRACT(EPOCH FROM s.ended_at-s.started_at)+CASE WHEN s.wrapup_ended_at IS NOT NULL THEN EXTRACT(EPOCH FROM s.wrapup_ended_at-s.ended_at) ELSE 0 END) AS handle,
        SUM(EXTRACT(EPOCH FROM s.ended_at-s.answered_at)) FILTER(WHERE w.channel='voice') AS talk,MIN(s.answered_at) AS first_at
      FROM acd_work_items w JOIN acd_segments s ON s.work_item_id=w.id AND s.kind='agent'
      WHERE w.terminal_at>=$1 AND w.terminal_at<$2 AND w.channel=ANY($3::text[])${narrow({ queue: "w.queue_id", agent: "s.agent_id", workItem: "w.id", channel: "w.channel" })} GROUP BY s.agent_id,w.id)
      SELECT agent_id,COUNT(*)::int AS total,COUNT(*) FILTER(WHERE state='completed')::int AS completed,
        COUNT(*) FILTER(WHERE state='abandoned')::int AS abandoned,COUNT(*) FILTER(WHERE state='failed')::int AS failed,
        AVG(handle) AS avg_handle,AVG(talk) AS avg_talk,SUM(talk) AS total_talk,MIN(first_at) AS first_at,MAX(terminal_at) AS last_at
      FROM participation GROUP BY agent_id`,
      args,
    )),
    await (pool.query(
      `WITH measurements AS (
        SELECT queue_id,channel,state,at_risk,policy,started_at FROM acd_sla_status sla WHERE TRUE${narrow({ queue: "sla.queue_id", workItem: "sla.work_item_id", channel: "sla.channel" })}
        UNION ALL
        SELECT s.queue_id,w.channel,'unavailable',false,NULL::jsonb,s.started_at
        FROM acd_segments s JOIN acd_work_items w ON w.id=s.work_item_id
        WHERE w.channel='voice' AND w.direction='inbound' AND s.kind='queue_wait'
          AND NOT EXISTS(SELECT 1 FROM acd_sla_measurements m WHERE m.segment_id=s.id)${narrow({ queue: "s.queue_id", workItem: "w.id", channel: "w.channel" })}
        UNION ALL
        SELECT w.queue_id,w.channel,'unavailable',false,NULL::jsonb,w.created_at
        FROM acd_work_items w WHERE w.channel<>'voice' AND w.direction='inbound'
          AND NOT EXISTS(SELECT 1 FROM acd_sla_measurements m WHERE m.work_item_id=w.id)${narrow({ queue: "w.queue_id", workItem: "w.id", channel: "w.channel" })}
      ) SELECT queue_id,channel,state,COUNT(*)::int AS total,COUNT(*) FILTER(WHERE at_risk)::int AS at_risk,
      SUM((policy->>'targetPercentage')::numeric) AS target_sum FROM measurements
      WHERE started_at>=$1 AND started_at<$2 AND channel=ANY($3::text[]) GROUP BY queue_id,channel,state`,
      args,
    )),
    await (readLiveWorkload(pool, null, restriction)),
    await (pool.query(
      `SELECT user_id,queue_id,enabled,activated_at,deactivated_at FROM cc_queue_user_assignments WHERE enabled=true`,
    ))
  ];
  const [agentPolicies, queuePolicies, channelMembership] = [
    await (pool.query("SELECT * FROM cc_agent_channel_policies")),
    await (pool.query("SELECT * FROM cc_queue_channels")),
    await (pool.query("SELECT * FROM cc_agent_queue_channels WHERE enabled=false"))
  ];
  const mapped = (row, channel) =>
    row
      ? {
          enabled: row.enabled,
          maxConcurrent: Number(row.max_concurrent),
          weight: Number(row.weight),
        }
      : defaultChannelPolicy(channel);
  const agents = users.rows.map((user) => {
    const load = workload.agents.find((a) => a.agent_id === user.id),
      history = agentHistory.rows.find((a) => a.agent_id === user.id) || {},
      presentation = user.agent_id
        ? agentStatusPresentation(user)
        : { status: "Offline", pendingStatus: null, pendingSince: null },
      status = presentation.status;
    const queueIds = assignments.rows
      .filter(
        (a) => a.user_id === user.id && a.activated_at && !a.deactivated_at,
      )
      .map((a) => a.queue_id);
    const capacityByChannel = {},
      capacityByQueue = {};
    for (const channel of channels.filter((channel) => interactionInScope(restriction, { agentIds: [user.id], queueIds, channel }))) {
      let eligible = false;
      for (const queueId of queueIds) {
        const policy = effectiveChannelPolicy(
          mapped(
            agentPolicies.rows.find(
              (p) => p.agent_id === user.id && p.channel === channel,
            ),
            channel,
          ),
          mapped(
            queuePolicies.rows.find(
              (p) => p.queue_id === queueId && p.channel === channel,
            ),
            channel,
          ),
        );
        policy.enabled =
          policy.enabled &&
          queues.rows.some((q) => q.id === queueId && q.enabled) &&
          !channelMembership.rows.some(
            (m) =>
              m.agent_id === user.id &&
              m.queue_id === queueId &&
              m.channel === channel,
          );
        const occupied = load?.channels || [],
          count = occupied.filter((r) => r.channel === channel).length,
          exclusive = channelDefinition(channel).capacity.exclusive,
          hasExclusive = occupied.some(r => channelDefinition(r.channel).capacity.exclusive),
          budget = exclusive ? (load?.budget || 1) : Math.min(load?.budget || 1, 1);
        const ready =
          user.presence === "online" &&
          !user.unconfirmed_origination &&
          user.ready_channels.includes(channel) &&
          (exclusive
            ? user.workflow_state === "idle" && user.routability === "routable"
            : user.manual_status === "Available" && ["idle", "offered", "handling"].includes(user.workflow_state));
        if (
          ready &&
          (exclusive ? occupied.length === 0 : !hasExclusive) &&
          policy.enabled &&
          (load?.used || 0) + policy.weight <= budget + 0.00001 &&
          count < policy.maxConcurrent
        ) {
          eligible = true;
          capacityByQueue[queueId] = true;
        }
      }
      capacityByChannel[channel] = eligible;
    }
    return {
      userId: user.id,
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
      status,
      // Manual status waiting to apply once the agent's current interactions end.
      pendingStatus: presentation.pendingStatus,
      pendingSince: presentation.pendingSince,
      currentCalls: new Set((load?.channels || []).filter(r => channels.includes(r.channel)).map(r => r.workItemId)).size,
      currentInteractions: new Set((load?.channels || []).filter(r => channels.includes(r.channel)).map(r => r.workItemId)).size,
      currentInteractionIds: [...new Set((load?.channels || []).filter(r => channels.includes(r.channel)).map(r => r.workItemId))],
      usedCapacity: load?.used || 0,
      capacityBudget: load?.budget || 1,
      capacityByChannel,
      capacityByQueue,
      isAvailableForRouting: Object.values(capacityByChannel).some(Boolean),
      maxConcurrentCalls: 1,
      activeQueues: queueIds.length,
      activeQueueIds: queueIds,
      assignedQueues: assignments.rows.filter((a) => a.user_id === user.id)
        .length,
      activeCampaignIds: [],
      activeCampaigns: 0,
      availableSince: status === "Available" ? user.status_started_at : null,
      currentIdleSeconds:
        status === "Available" && !load?.used
          ? Math.max(
              0,
              (Date.now() - Date.parse(user.status_started_at)) / 1000,
            )
          : 0,
      today: {
        totalCalls: history.total || 0,
        completedCalls: history.completed || 0,
        abandonedCalls: history.abandoned || 0,
        failedInteractions: history.failed || 0,
        avgHandleTimeSeconds: n(history.avg_handle),
        avgTalkTimeSeconds: n(history.avg_talk),
        totalTalkTimeSeconds: n(history.total_talk),
        firstCallTime: history.first_at,
        lastCallTime: history.last_at,
      },
      lastUpdated: new Date().toISOString(),
    };
  });
  const campaignTable = (
    await pool.query(
      "SELECT to_regclass('public.outbound_campaign_agent_assignments') AS present",
    )
  ).rows[0].present;
  if (campaignTable) {
    const campaigns = (
      await pool.query(
        `SELECT agent_username,campaign_id FROM outbound_campaign_agent_assignments WHERE enabled=true${campaignScopeSql(restriction, "campaign_id::text", null).map((part) => ` AND ${part}`).join("")}`,
      )
    ).rows;
    for (const agent of agents) {
      agent.activeCampaignIds = campaigns
        .filter((c) => c.agent_username === agent.username)
        .map((c) => c.campaign_id);
      agent.activeCampaigns = agent.activeCampaignIds.length;
    }
  }
  const sum = (rows, key) =>
    rows.reduce((total, row) => total + Number(row[key] || 0), 0);
  const queueStats = queues.rows
    .filter((q) => q.enabled)
    .map((q) => {
      const current = live.rows.filter((r) => r.queue_id === q.id),
        history = closed.rows.filter(
          (r) => r.scope === "queue" && r.queue_id === q.id,
        ),
        slaRows = sla.rows.filter((r) => r.queue_id === q.id);
      const members = agents.filter((a) => a.activeQueueIds.includes(q.id)),
        slaTotals = slaSummary(slaRows),
        total = sum(history, "total");
      const average = (key) => {
        const eligible = history.filter((r) => r[key] != null),
          count = sum(eligible, key + "_count");
        return count
          ? eligible.reduce(
              (sum, r) => sum + Number(r[key]) * r[key + "_count"],
              0,
            ) / count
          : null;
      };
      return {
        queueId: q.id,
        queueName: q.display_name || q.name,
        realtime: {
          currentSize: sum(current, "queued") + sum(current, "offered"),
          waitingCalls: sum(current, "queued") + sum(current, "offered"),
          activeCalls: sum(current, "active"),
          queuedCalls: sum(current, "queued"),
          ringingCalls: sum(current, "offered"),
          longestWaitSeconds: Math.max(
            0,
            ...current.map((r) => Number(r.longest_wait || 0)),
          ),
          avgWaitSeconds: sum(current, "queued") + sum(current, "offered")
            ? current.reduce((total, row) => total + Number(row.avg_wait || 0) * (Number(row.queued) + Number(row.offered)), 0) / (sum(current, "queued") + sum(current, "offered"))
            : null,
        },
        today: {
          totalCalls: total,
          answeredCalls: sum(history, "completed"),
          abandonedCalls: sum(history, "abandoned"),
          failedInteractions: sum(history, "failed"),
          avgWaitTimeSeconds: average("avg_wait"),
          maxWaitTimeSeconds: Math.max(
            0,
            ...history.map((r) => Number(r.max_wait || 0)),
          ),
          avgHandleTimeSeconds: average("avg_handle"),
          avgTalkTimeSeconds: average("avg_talk"),
          serviceLevelPercentage: slaTotals.rate,
        },
        sla: slaTotals,
        channels: current,
        agents: {
          available: members.filter((a) => a.capacityByQueue[q.id]).length,
          busy: members.filter((a) => a.usedCapacity > 0).length,
          totalActive: members.filter((a) => a.status !== "Offline").length,
        },
        lastUpdated: new Date().toISOString(),
      };
    });
  return {
    queues: queueStats,
    agents,
    overall: {
      calls: {
        total: sum(
          closed.rows.filter((r) => r.scope === "global"),
          "total",
        ),
        answered: sum(
          closed.rows.filter((r) => r.scope === "global"),
          "completed",
        ),
        abandoned: sum(
          closed.rows.filter((r) => r.scope === "global"),
          "abandoned",
        ),
        failed: sum(
          closed.rows.filter((r) => r.scope === "global"),
          "failed",
        ),
        active: sum(live.rows, "active"),
      },
      agents: {
        available: agents.filter((a) => a.isAvailableForRouting).length,
        busy: agents.filter((a) => a.usedCapacity > 0).length,
        totalActive: agents.filter((a) => a.status !== "Offline").length,
        total: agents.length,
      },
      queues: {
        total: queues.rows.length,
        active: queueStats.length,
        totalWaitingCalls: sum(live.rows, "queued") + sum(live.rows, "offered"),
      },
      sla: slaSummary(sla.rows),
      scope,
      lastUpdated: new Date().toISOString(),
    },
  };
}
