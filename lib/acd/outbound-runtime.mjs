import { startOutboundConnect } from './sagas/outbound-connect.mjs';
import { reserveOutboundLine } from './outbound-capacity.mjs';
import { claimOneAgentlessRecord, startCampaignRun } from '../outbound-dialer/execution.js';
import { completeCampaignIfExhausted } from '../outbound-dialer/completion.js';
import { outboundBlendingBudget } from './outbound-blending.mjs';
import {
  computePowerDialBudget,
  computePredictiveRatio,
  powerPacingConfig,
  predictivePacingConfig,
} from './outbound-pacing.mjs';
import { driveSaga } from './saga-engine.mjs';
import { answeredWithoutAgentGuard } from '../outbound-dialer/answered-without-agent-policy.mjs';
import { priorityDistributionCursor } from '../outbound-dialer/agent-campaigns-view-model.js';
import { tickOutboundMessaging as runMessagingTick } from '../outbound-dialer/messaging/execution.mjs';

const AUTONOMOUS_MODES = ['power','predictive','agentless_ai','agentless_flow'];

async function loadAutonomousCampaigns(tx) {
  return (await tx.query(`SELECT c.*, active_run.id AS active_run_id, active_run.metadata AS active_run_metadata,
      COALESCE(run_usage.served_count, 0)::int AS run_served_count
    FROM outbound_campaigns c
    LEFT JOIN LATERAL (
      SELECT r.id, r.metadata
      FROM outbound_campaign_runs r
      WHERE r.campaign_id = c.id AND r.status = 'running'
      ORDER BY r.started_at DESC, r.id DESC
      LIMIT 1
    ) active_run ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS served_count
      FROM outbound_attempt_ledger ledger
      WHERE ledger.run_id = active_run.id
        AND COALESCE(ledger.metadata->>'blending_deferred', 'false') <> 'true'
    ) run_usage ON true
    WHERE c.status='running' AND c.channel='voice' AND c.mode=ANY($1::text[])
    ORDER BY c.id`, [AUTONOMOUS_MODES])).rows;
}

async function claimAutonomousCampaign(tx, campaign) {
  if (!campaign || campaign.status !== 'running' || campaign.channel !== 'voice' || !AUTONOMOUS_MODES.includes(campaign.mode)) return { claim:null, rollback:false };
  if (['power', 'predictive'].includes(campaign.mode)) {
    const quality = await answeredWithoutAgentGuard(tx, campaign);
    const previousGuard = campaign.metadata?.answered_without_agent_guard || {};
    if (Boolean(previousGuard.blocked) !== quality.blocked) {
      await tx.query(`UPDATE outbound_campaigns SET metadata=metadata || jsonb_build_object(
        'answered_without_agent_guard', jsonb_build_object(
          'blocked',$2::boolean,'human_answers',$3::int,'abandons',$4::int,
          'rate_percent',$5::numeric,'limit_percent',$6::numeric,'changed_at',now()::text))
        WHERE id=$1`, [campaign.id, quality.blocked, quality.humanAnswers, quality.abandons,
      quality.ratePercent, quality.policy.max_abandon_rate_percent]);
    }
    if (quality.blocked) return { claim:null, rollback:false };
    const config = predictivePacingConfig(campaign);
    const {free} = await outboundBlendingBudget(tx,campaign);
    const debt = Number((await tx.query(`SELECT COUNT(*)::int AS n FROM acd_outbound_lines l JOIN acd_work_items w ON w.id = l.work_item_id
      WHERE l.released_at IS NULL AND w.queue_id = $1 AND w.state <> 'active'`, [campaign.handler_ref])).rows[0].n);
    let ratio = powerPacingConfig(campaign).ratio;
    if (campaign.mode === 'predictive') {
      const stats = (await tx.query(`SELECT COUNT(*)::int AS samples, COUNT(*) FILTER (WHERE metadata ? 'human_answered_at')::int AS answers,
        COUNT(*) FILTER (WHERE metadata ? 'abandoned_at')::int AS abandons FROM outbound_attempt_ledger WHERE campaign_id = $1
        AND created_at > now() - ($2::text || ' minutes')::interval AND status IN ('completed', 'failed', 'cancelled')`, [campaign.id, String(config.statsWindowMinutes)])).rows[0];
      const effectiveTarget = Math.min(config.abandonTarget, quality.policy.max_abandon_rate_percent / 100);
      ratio = computePredictiveRatio({ ...config, abandonTarget: effectiveTarget, sampleSize: stats.samples, answerRate: stats.answers / Math.max(1, stats.samples), abandonRate: stats.abandons / Math.max(1, stats.answers) });
      if (stats.samples >= config.minSampleSize && stats.abandons / Math.max(1, stats.answers) > effectiveTarget) ratio = 0;
    }
    if (ratio <= 0 || computePowerDialBudget({ freeAgents: free, ratio, inFlight: debt, maxLines: Infinity }) < 1) return { claim:null, rollback:false };
  }
  const run = campaign.active_run_id
    ? (await tx.query(`SELECT * FROM outbound_campaign_runs WHERE id=$1`, [campaign.active_run_id])).rows[0]
    : await startCampaignRun(tx, campaign.id);
  const ledger = await claimOneAgentlessRecord(tx, campaign, run.id, { attemptReason: `acd_${campaign.mode}` });
  if (!ledger) {
    await completeCampaignIfExhausted(tx, campaign);
    return { claim:null, rollback:false };
  }
  const started = await startOutboundConnect(tx, { campaign, ledger });
  if (!await reserveOutboundLine(tx, { attemptId: ledger.id, campaignId:campaign.id, workItemId:started.workItemId, sagaId:started.sagaId, campaign })) {
    return { claim:null, rollback:true };
  }
  await tx.query(`INSERT INTO acd_outbound_schedule(campaign_id,polled_at) VALUES($1,now())
    ON CONFLICT(campaign_id) DO UPDATE SET polled_at=EXCLUDED.polled_at`, [campaign.id]);
  return { claim:{...started,attemptId:ledger.id,campaignId:campaign.id}, rollback:false };
}

export async function claimAutonomousOutbound(pool, campaignId) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    // This same lock is used for line admission. Every node/campaign sees
    // uncommitted claims only after the preceding admission has committed.
    await tx.query(`SELECT pg_advisory_xact_lock(741901, 5)`);
    const campaign = (await tx.query(`SELECT c.*, active_run.id AS active_run_id FROM outbound_campaigns c
      LEFT JOIN LATERAL (SELECT r.id FROM outbound_campaign_runs r WHERE r.campaign_id=c.id AND r.status='running' ORDER BY r.started_at DESC,r.id DESC LIMIT 1) active_run ON true
      WHERE c.id=$1 FOR UPDATE OF c`, [campaignId])).rows[0];
    const result = await claimAutonomousCampaign(tx,campaign);
    if (result.rollback) {
      await tx.query('ROLLBACK'); return null;
    }
    await tx.query('COMMIT');
    return result.claim;
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}

export async function claimNextAutonomousOutbound(pool) {
  const tx=await pool.connect();
  try{
    await tx.query('BEGIN');
    await tx.query(`SELECT pg_advisory_xact_lock(741901,5)`);
    const candidates=await loadAutonomousCampaigns(tx);
    const remaining=[...candidates];
    let firstFailure=null;
    while(remaining.length){
      const selected=priorityDistributionCursor(remaining);
      remaining.splice(remaining.findIndex(c=>c.id===selected.id),1);
      const campaign=(await tx.query(`SELECT c.*, $2::uuid AS active_run_id FROM outbound_campaigns c WHERE c.id=$1 FOR UPDATE`,[selected.id,selected.active_run_id])).rows[0];
      if(!campaign||campaign.status!=='running')continue;
      await tx.query('SAVEPOINT outbound_priority_candidate');
      try{
        const result=await claimAutonomousCampaign(tx,campaign);
        if(result.rollback){
          await tx.query('ROLLBACK TO SAVEPOINT outbound_priority_candidate');
          await tx.query('RELEASE SAVEPOINT outbound_priority_candidate');
          continue;
        }
        await tx.query('RELEASE SAVEPOINT outbound_priority_candidate');
        if(result.claim){await tx.query('COMMIT');return result.claim;}
      }catch(error){
        await tx.query('ROLLBACK TO SAVEPOINT outbound_priority_candidate');
        await tx.query('RELEASE SAVEPOINT outbound_priority_candidate');
        firstFailure ||= {campaignId:campaign.id,routed:false,error:String(error?.message||error)};
      }
    }
    await tx.query('COMMIT');return firstFailure;
  }catch(error){await tx.query('ROLLBACK');throw error;}
  finally{tx.release();}
}

export async function tickOutboundVoice(pool, provider, { node = 'outbound-worker', limit = 10 } = {}) {
  // Stored running campaigns are rediscovered after every restart, even when
  // the web process that handled Start no longer exists.
  await pool.query(`INSERT INTO acd_outbound_schedule(campaign_id,polled_at)
    SELECT c.id::text,now() FROM outbound_campaigns c WHERE c.status='running' AND c.channel='voice' AND c.mode=ANY($1::text[])
    ON CONFLICT(campaign_id) DO NOTHING`,[AUTONOMOUS_MODES]);
  const results = [];
  for (let index=0;index<limit;index++) {
    try {
      const claim=await claimNextAutonomousOutbound(pool);
      if(!claim)break;
      if(claim.routed===false){results.push(claim);break;}
      results.push(claim);await driveSaga(pool,claim.sagaId,{provider,node});
    } catch(error) {
      // One misconfigured campaign cannot stop inbound routing or other
      // campaigns on this node. Worker diagnostics report the failed admission.
      results.push({campaignId:null,routed:false,error:String(error?.message || error)});
    }
  }
  return results;
}

export async function requestOutboundDial(pool, { attemptId, agentId }) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const saga = (await tx.query(`SELECT s.* FROM acd_sagas s JOIN acd_work_items w ON w.id = s.work_item_id
      WHERE w.outbound_attempt_id = $1 AND s.type = 'outbound_connect' AND s.data->>'agentId' = $2 FOR UPDATE OF s`, [attemptId, agentId])).rows[0];
    if (!saga) throw Object.assign(new Error('Assigned campaign record not found'), { status: 404 });
    if (!['running', 'compensating'].includes(saga.state)) throw Object.assign(new Error('Attempt already ended'), { status: 409 });
    await tx.query(`UPDATE acd_sagas SET data = data || '{"dialRequested":true}'::jsonb WHERE id = $1`, [saga.id]);
    await tx.query(`SELECT pg_notify('acd_events', '{}')`);
    await tx.query('COMMIT');
    return { ok: true, server_dial: true, saga_id: saga.id, work_item_id: saga.work_item_id };
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}

// Messaging broadcasts (SMS/WhatsApp/email) share the drain with voice admission
// but never take the voice line lock: their budget lock is (741901, 6).
export async function tickOutboundMessaging(pool, provider, { node = 'outbound-worker', limit = 10 } = {}) {
  return runMessagingTick(pool, provider, { node, limit });
}
