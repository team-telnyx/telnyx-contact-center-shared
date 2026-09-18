import { resolvePolicy } from './policies/index.mjs';

const bounded = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
export function normalizeBlending(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  return { mode: value.mode === 'pause_when_inbound_queued' ? value.mode : 'dynamic',
    reserve_agents: bounded(value.reserve_agents, 10000), reserve_percent: bounded(value.reserve_percent, 100) };
}

// Maximum bipartite matching preserves scarce skills across overlapping queues.
// Earlier (higher-priority) work keeps its place when later work is considered.
export function matchInboundAgents(items) {
  const assigned = new Map();
  function place(item, seen) {
    for (const id of item.agents) {
      if (seen.has(id)) continue;
      seen.add(id);
      const previous = assigned.get(id);
      if (!previous || place(previous, seen)) { assigned.set(id, item); return true; }
    }
    return false;
  }
  for (const item of items) place(item, new Set());
  return assigned;
}

// Admission callers hold the shared outbound budget lock. Pending preview and
// progressive reservations remain candidates for yielding; live media never is.
export async function outboundBlendingBudget(tx, campaign, { agentId = null, reservationId = null, protectAutonomousDemand = false } = {}) {
  const ready = (await tx.query(`SELECT a.agent_id, u.skills, a.workflow_state,
      (SELECT max(r.released_at) FROM acd_reservations r WHERE r.agent_id=a.agent_id) AS last_released_at,
      EXISTS(SELECT 1 FROM acd_reservations r WHERE r.agent_id=a.agent_id AND r.state<>'released') AS pending
    FROM acd_agent_state a JOIN users u ON u.id=a.agent_id
    WHERE a.presence='online' AND a.routability='routable' AND a.capacity>=1
      AND (a.workflow_state='idle' OR EXISTS (
        SELECT 1 FROM acd_reservations r JOIN acd_sagas s ON s.id=r.owner_saga_id
        WHERE r.agent_id=a.agent_id AND r.state<>'released' AND s.type='outbound_connect' AND s.step='await_dial'))
      AND NOT EXISTS (SELECT 1 FROM acd_reservations r LEFT JOIN acd_sagas s ON s.id=r.owner_saga_id
        WHERE r.agent_id=a.agent_id AND r.state<>'released'
        AND (r.state='active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at>now())
        AND r.id IS DISTINCT FROM $1
        AND NOT COALESCE(s.type='outbound_connect' AND s.step='await_dial' AND r.state<>'active',false))
      AND EXISTS (SELECT 1 FROM acd_agent_sessions s WHERE s.agent_id=a.agent_id AND s.state='online' AND s.expires_at>now() AND s.capabilities->>'voice'='true')
    ORDER BY pending, a.agent_id`, [reservationId])).rows;
  // Include this attempt's already answered agent for the final pre-dial check.
  if (agentId && reservationId && !ready.some(a => a.agent_id === agentId)) {
    const own = (await tx.query(`SELECT a.agent_id,u.skills,a.workflow_state,true AS pending FROM acd_agent_state a JOIN users u ON u.id=a.agent_id
      JOIN acd_reservations r ON r.agent_id=a.agent_id WHERE a.agent_id=$1 AND r.id=$2 AND r.state<>'released'
      AND a.presence='online' AND a.manual_status='Available'
      AND a.workflow_state IN ('offered','handling')
      AND EXISTS(SELECT 1 FROM acd_agent_sessions s WHERE s.agent_id=a.agent_id AND s.state='online' AND s.expires_at>now() AND s.capabilities->>'voice'='true')`, [agentId,reservationId])).rows;
    ready.push(...own);
  }
  const memberships = (await tx.query(`SELECT qa.user_id,qa.queue_id,qa.priority FROM cc_queue_user_assignments qa
    WHERE qa.user_id=ANY($1::text[]) AND qa.enabled=true AND qa.activated_at IS NOT NULL AND qa.deactivated_at IS NULL`, [ready.map(a=>a.agent_id)])).rows;
  const queueIds = [...new Set(memberships.map(q=>q.queue_id))];
  const queues = (await tx.query('SELECT * FROM cc_queues WHERE id=ANY($1::text[])',[queueIds])).rows;
  const works = (await tx.query(`SELECT w.* FROM acd_work_items w WHERE queue_id=ANY($1::text[]) AND direction='inbound' AND channel='voice' AND state='queued' ORDER BY priority DESC,enqueued_at,id`,[queueIds])).rows;
  const catalog = (await tx.query('SELECT id,name,is_active FROM skills')).rows;
  const now = (await tx.query('SELECT now() AS now')).rows[0].now;
  const items = works.map(work=>{
    const queue=queues.find(q=>q.id===work.queue_id);
    const candidates=ready.filter(a=>memberships.some(m=>m.user_id===a.agent_id&&m.queue_id===work.queue_id)).map(a=>({...a,queue_priority:memberships.find(m=>m.user_id===a.agent_id&&m.queue_id===work.queue_id)?.priority}));
    const policy=resolvePolicy(queue?.routing_strategy);
    const ranked=policy.rank(candidates,work,{queue,catalog,now});
    return {id:work.id,agents:ranked.map(a=>a.agent_id)};
  });
  const protectedAgents = new Set(matchInboundAgents(items).keys());
  const pool = ready.filter(a=>a.agent_id===agentId||memberships.some(m=>m.user_id===a.agent_id&&m.queue_id===campaign.handler_ref));
  const relevantQueues=new Set(memberships.filter(m=>pool.some(a=>a.agent_id===m.user_id)).map(m=>m.queue_id));
  const queued=works.filter(w=>relevantQueues.has(w.queue_id)).length;
  const globalRow=(await tx.query("SELECT settings FROM outbound_settings WHERE id='default'")).rows[0];
  const global=normalizeBlending(globalRow?.settings?.blending);
  const local=campaign.metadata?.blending_config||campaign.pacing_config?.blending||{};
  const policy=normalizeBlending(local);
  const strict=global.mode==='pause_when_inbound_queued'||policy.mode==='pause_when_inbound_queued'||local.denyWhenInboundQueued===true||local.deny_when_inbound_queued===true;
  const spare=pool.filter(a=>!protectedAgents.has(a.agent_id));
  const reserve=Math.max(global.reserve_agents,policy.reserve_agents,Math.ceil(pool.length*Math.max(global.reserve_percent,policy.reserve_percent,bounded(local.inboundReservePercent??local.inbound_reserve_percent,100))/100));
  for(const a of spare.slice(0,reserve))protectedAgents.add(a.agent_id);
  const outbound=pool.filter(a=>(!a.pending||a.agent_id===agentId)&&!protectedAgents.has(a.agent_id));
  // A Power/Predictive customer leg consumes future agent capacity while it is
  // ringing or waiting for a bridge. Without this virtual reservation, an
  // agent-driven campaign can claim every idle agent during that interval and
  // turn a legitimate human answer into an avoidable abandoned call.
  let autonomousDebt=0;
  const autonomousProtectedAgentIds=[];
  if(protectAutonomousDemand&&campaign.handler_type==='queue'&&campaign.handler_ref){
    autonomousDebt=Number((await tx.query(`SELECT COUNT(DISTINCT l.attempt_id)::int AS n
      FROM acd_outbound_lines l JOIN acd_work_items w ON w.id=l.work_item_id
      WHERE l.released_at IS NULL AND w.queue_id=$1 AND w.direction='outbound'
        AND w.attributes->>'outbound_mode' IN ('power','predictive') AND w.state<>'active'`,[campaign.handler_ref])).rows[0]?.n||0);
    // Prefer an otherwise idle agent. An already reserved agent is protected
    // too when no alternative remains, which makes its agent-first saga yield
    // before it dials a second customer.
    const ordered=reservationId
      ?[...outbound.filter(a=>a.agent_id!==agentId),...outbound.filter(a=>a.agent_id===agentId)]
      :outbound;
    autonomousProtectedAgentIds.push(...ordered.slice(0,autonomousDebt).map(a=>a.agent_id));
  }
  const autonomousProtected=new Set(autonomousProtectedAgentIds);
  const available=outbound.filter(a=>!autonomousProtected.has(a.agent_id));
  const blocked=strict&&queued>0;
  return {free:blocked?0:available.length,queued,agentEligible:!agentId||(!blocked&&available.some(a=>a.agent_id===agentId)),
    protectedAgentIds:[...new Set([...protectedAgents,...autonomousProtectedAgentIds])],autonomousProtectedAgentIds,autonomousDebt,
    mode:strict?'pause_when_inbound_queued':'dynamic'};
}
