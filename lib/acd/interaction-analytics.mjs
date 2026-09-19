import { RELEASED_CHANNELS } from "./channel-registry.mjs";
import { interactionScopeSql, queueScopeSql } from "../authz/scope.mjs";
const channelsFor = (scope) => scope.channels || (scope.channel ? [scope.channel] : RELEASED_CHANNELS);
// Data scope (Phase 3a) appended as literals next to the fixed report parameters.
const restrictionSql = (scope, columns) => interactionScopeSql(scope.restriction, columns, null).map((c) => ` AND ${c}`).join("");
const queueRestrictionSql = (scope, column) => queueScopeSql(scope.restriction, column, null).map((c) => ` AND ${c}`).join("");
export async function readHandoffReport(db, scope) {
  const args = [
    scope.from,
    scope.to,
    channelsFor(scope),
    scope.queueId,
    scope.timezone,
  ];
  const cte = `WITH sources AS (
    SELECT h.id::text AS id,h.work_item_id,'voice'::text AS channel,h.status,h.error_message,h.created_at,w.queue_id
      FROM aa_ai_handoff_events h LEFT JOIN acd_work_items w ON w.id=h.work_item_id
    UNION ALL SELECT h.session_id::text,h.work_item_id,'chat',CASE WHEN h.work_item_id IS NOT NULL THEN 'processed' ELSE h.status END,h.error,h.created_at,h.queue_id FROM cc_widget_handoffs h
  ), scoped AS (SELECT h.*,w.state AS work_state,w.customer_address,q.name AS queue_name FROM sources h
    LEFT JOIN acd_work_items w ON w.id=h.work_item_id LEFT JOIN cc_queues q ON q.id=h.queue_id
    WHERE h.created_at>=$1 AND h.created_at<$2 AND h.channel=ANY($3::text[]) AND ($4::text IS NULL OR h.queue_id=$4)${restrictionSql(scope, { queue: "h.queue_id", workItem: "h.work_item_id", channel: "h.channel" })})`;
  const [counts, daily, queues, recent] = await Promise.all([
    db.query(
      `${cte} SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='processed')::int AS processed,
      COUNT(*) FILTER(WHERE status LIKE 'pending%' OR status='waiting')::int AS pending,
      COUNT(*) FILTER(WHERE status<>'processed' AND status NOT LIKE 'pending%' AND status<>'waiting')::int AS failed,
      COUNT(*) FILTER(WHERE error_message IS NOT NULL)::int AS errors,COUNT(DISTINCT work_item_id)::int AS interactions,
      COUNT(DISTINCT work_item_id) FILTER(WHERE work_state='completed')::int AS completed FROM scoped`,
      args.slice(0, 4),
    ),
    db.query(
      `${cte} SELECT to_char(created_at AT TIME ZONE $5,'YYYY-MM-DD') AS day,COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='processed')::int AS processed FROM scoped GROUP BY 1 ORDER BY 1`,
      args,
    ),
    db.query(
      `${cte} SELECT COALESCE(queue_name,'No queue') AS queue_name,COUNT(*)::int AS handoffs,COUNT(DISTINCT work_item_id) FILTER(WHERE work_state='completed')::int AS completed FROM scoped GROUP BY queue_name ORDER BY handoffs DESC`,
      args.slice(0, 4),
    ),
    db.query(
      `${cte} SELECT * FROM scoped ORDER BY created_at DESC LIMIT 100`,
      args.slice(0, 4),
    ),
  ]);
  const c = counts.rows[0];
  return {
    totals: {
      handoffs: c.total,
      processed: c.processed,
      pending: c.pending,
      failed: c.failed,
      withErrors: c.errors,
      processedRatePct: c.total ? (100 * c.processed) / c.total : null,
      aiHandledInteractions: c.interactions,
      aiCompleted: c.completed,
      avgHandleSecondsAfterHandoff: null,
      avgWaitSecondsAfterHandoff: null,
    },
    daily: daily.rows.map((r) => ({ ...r, label: r.day })),
    byQueue: queues.rows.map((r) => ({
      queueName: r.queue_name,
      handoffs: r.handoffs,
      completed: r.completed,
      avgHandleSeconds: null,
    })),
    recent: recent.rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      interactionId: r.work_item_id,
      status: r.status,
      errorMessage: r.error_message,
      createdAt: r.created_at,
      queueName: r.queue_name,
      fromNumber: r.customer_address,
    })),
    scope:
      "Handoff attempts from voice intake and native widget ledgers; linked interaction outcomes are distinct.",
  };
}
export async function readSkillsReport(db, scope) {
  const args = [
    scope.from,
    scope.to,
    channelsFor(scope),
    scope.queueId,
  ];
  const supply = (
    await db.query(
      `SELECT s.id,s.name,ARRAY_AGG(DISTINCT u.id) FILTER(WHERE u.id IS NOT NULL) AS agent_ids,COUNT(DISTINCT u.id)::int AS agents,AVG((u.skills->>s.id)::numeric) AS proficiency,
    MAX((u.skills->>s.id)::numeric) AS max_proficiency FROM skills s LEFT JOIN users u ON u.active AND u.skills?s.id
      AND EXISTS(SELECT 1 FROM cc_queue_user_assignments a JOIN cc_queues q ON q.id=a.queue_id AND q.enabled
        CROSS JOIN unnest($1::text[]) channel(id)
        LEFT JOIN cc_queue_channels qp ON qp.queue_id=q.id AND qp.channel=channel.id
        LEFT JOIN cc_agent_channel_policies ap ON ap.agent_id=u.id AND ap.channel=channel.id
        WHERE a.user_id=u.id AND a.enabled AND a.activated_at IS NOT NULL AND a.deactivated_at IS NULL
          AND ($2::text IS NULL OR q.id=$2)${queueRestrictionSql(scope, "q.id")} AND COALESCE(qp.enabled,channel.id='voice') AND COALESCE(ap.enabled,channel.id='voice')
          AND NOT EXISTS(SELECT 1 FROM cc_agent_queue_channels ac WHERE ac.agent_id=u.id AND ac.queue_id=q.id AND ac.channel=channel.id AND NOT ac.enabled))
    WHERE s.is_active GROUP BY s.id,s.name ORDER BY s.name`,
      [args[2], args[3]],
    )
  ).rows;
  const demand = (
    await db.query(
      `SELECT req.key AS skill_id,COALESCE(s.name,req.key) AS name,COUNT(DISTINCT w.id)::int AS interactions,
    AVG(req.value::numeric) AS level,COUNT(DISTINCT w.id) FILTER(WHERE w.state='abandoned')::int AS abandoned
    FROM acd_work_items w CROSS JOIN LATERAL jsonb_each_text(w.required_skills) req LEFT JOIN skills s ON s.id=req.key
    WHERE w.terminal_at>=$1 AND w.terminal_at<$2 AND w.channel=ANY($3::text[]) AND ($4::text IS NULL OR w.queue_id=$4
      OR EXISTS(SELECT 1 FROM acd_segments seg WHERE seg.work_item_id=w.id AND seg.queue_id=$4))${restrictionSql(scope, { queue: "w.queue_id", workItem: "w.id", channel: "w.channel" })} GROUP BY req.key,s.name ORDER BY interactions DESC`,
      args,
    )
  ).rows;
  const queueRows = (
    await db.query(
      `SELECT q.id,q.name AS queue_name,s.name AS skill_name,(q.skill_requirements->>s.id)::int AS required_level,
    COUNT(DISTINCT u.id)::int AS qualified_agents FROM cc_queues q JOIN skills s ON q.skill_requirements?s.id
    LEFT JOIN cc_queue_user_assignments a ON a.queue_id=q.id AND a.enabled AND a.activated_at IS NOT NULL AND a.deactivated_at IS NULL
    LEFT JOIN users u ON u.id=a.user_id AND u.active AND (u.skills->>s.id)::numeric >= (q.skill_requirements->>s.id)::numeric
      AND EXISTS(SELECT 1 FROM unnest($1::text[]) channel(id) LEFT JOIN cc_queue_channels qp ON qp.queue_id=q.id AND qp.channel=channel.id
        LEFT JOIN cc_agent_channel_policies ap ON ap.agent_id=u.id AND ap.channel=channel.id
        WHERE COALESCE(qp.enabled,channel.id='voice') AND COALESCE(ap.enabled,channel.id='voice')
          AND NOT EXISTS(SELECT 1 FROM cc_agent_queue_channels ac WHERE ac.agent_id=u.id AND ac.queue_id=q.id AND ac.channel=channel.id AND NOT ac.enabled))
    WHERE q.enabled AND ($2::text IS NULL OR q.id=$2)${queueRestrictionSql(scope, "q.id")} GROUP BY q.id,q.name,s.id,s.name ORDER BY q.name,s.name`,
      [args[2], args[3]],
    )
  ).rows;
  const rows = demand.map((d) => {
    const matched = supply.find((s) => s.id === d.skill_id);
    return {
      skillId: d.skill_id,
      skillName: d.name,
      interactions: d.interactions,
      avgRequiredLevel: Number(d.level),
      abandoned: d.abandoned,
      abandonRatePct: d.interactions ? (100 * d.abandoned) / d.interactions : 0,
      avgWaitSeconds: null,
      agentsWithSkill: matched?.agents || 0,
      avgProficiency: Number(matched?.proficiency || 0),
      coverageGap: Math.max(
        0,
        Number(d.level) - Number(matched?.proficiency || 0),
      ),
    };
  });
  return {
    totals: {
      totalSkilledAgents: new Set(supply.flatMap((row) => row.agent_ids || []))
        .size,
      skills: supply.length,
      skillsInDemand: rows.length,
      uncoveredSkills: rows.filter((r) => !r.agentsWithSkill).length,
      totalDemand: rows.reduce((s, r) => s + r.interactions, 0),
    },
    supply: supply.map((s) => ({
      skillId: s.id,
      skillName: s.name,
      agents: s.agents,
      avgProficiency: Number(s.proficiency || 0),
      maxProficiency: Number(s.max_proficiency || 0),
    })),
    demand: rows,
    queueRequirements: queueRows.map((q) => ({
      queueName: q.queue_name,
      skillName: q.skill_name,
      requiredLevel: q.required_level,
      qualifiedAgents: q.qualified_agents,
    })),
    scope:
      "Configured, active channel-enabled membership; skill supply is not current spare capacity.",
  };
}
