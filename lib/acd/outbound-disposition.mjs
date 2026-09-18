import { applyCampaignDispositionToLedger } from '../outbound-dialer/campaign-dispositions.js';
import { completeAcdWrapup } from './wrapup.mjs';
import { effectiveAgentStatus } from './agent-state.mjs';

export async function submitOutboundDisposition(pool, { attemptId, agentId, dispositionCodeId, callbackAt = null, notes = '' }) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const work = (await tx.query(`SELECT * FROM acd_work_items WHERE outbound_attempt_id = $1 FOR UPDATE`, [attemptId])).rows[0];
    if (!work) { await tx.query('COMMIT'); return null; }
    const segment = (await tx.query(`SELECT * FROM acd_segments WHERE work_item_id = $1 AND kind = 'agent' ORDER BY seq DESC LIMIT 1`, [work.id])).rows[0];
    if (!segment?.ended_at || segment.agent_id !== agentId) throw Object.assign(new Error('Final ended agent assignment required'), { status:403 });
    const live = await tx.query(`SELECT 1 FROM acd_outbound_lines WHERE attempt_id=$1 AND released_at IS NULL`, [attemptId]);
    if (live.rowCount || !work.terminal_at) throw Object.assign(new Error('Wait for confirmed call completion'),{status:409});
    const ledger = (await tx.query(`SELECT l.*, c.retry_policy FROM outbound_attempt_ledger l JOIN outbound_campaigns c ON c.id=l.campaign_id WHERE l.id=$1 FOR UPDATE OF l`,[attemptId])).rows[0];
    const submission = JSON.stringify({ dispositionCodeId, callbackAt, notes });
    if (ledger.metadata?.acd_disposition_submission) {
      if (ledger.metadata.acd_disposition_submission !== submission || ledger.metadata.acd_disposition_agent_id !== agentId) throw Object.assign(new Error('Disposition already submitted'),{status:409});
      const agent=(await tx.query(`SELECT * FROM acd_agent_state WHERE agent_id=$1`,[agentId])).rows[0];
      await tx.query('COMMIT'); return {ok:true,attemptId,status:ledger.status,agent_status:effectiveAgentStatus(agent),alreadySubmitted:true};
    }
    if (segment.wrapup_ended_at) throw Object.assign(new Error('Campaign wrap-up is no longer pending'), { status:409 });
    const mapping = (await tx.query(`SELECT m.* FROM outbound_disposition_code_mappings m JOIN cc_wrapup_codes w ON w.id=m.wrapup_code_id AND w.is_active=true
      WHERE m.wrapup_code_id=$1 AND m.status='active' AND (m.campaign_id=$2 OR m.campaign_id IS NULL)
      ORDER BY (m.campaign_id=$2) DESC NULLS LAST LIMIT 1`,[dispositionCodeId,ledger.campaign_id])).rows[0];
    if (!mapping) throw Object.assign(new Error('Disposition mapping not found'),{status:400});
    if ((mapping.requires_callback && !callbackAt) || (callbackAt && (!Number.isFinite(Date.parse(callbackAt)) || Date.parse(callbackAt)<=Date.now()))) {
      throw Object.assign(new Error('A future callback date/time is required'),{status:400});
    }
    const nextRetry = callbackAt || (mapping.classification==='retry' ? new Date(Date.now()+Math.max(60,Number(ledger.retry_policy?.minDelayHours||6)*3600)*1000).toISOString() : null);
    const update=applyCampaignDispositionToLedger(ledger,mapping,{callback_at:nextRetry,notes});
    update.metadata.next_retry_at=update.next_retry_at;
    update.metadata.acd_disposition_submission=submission;
    update.metadata.acd_disposition_agent_id=agentId;
    await tx.query(`UPDATE outbound_attempt_ledger SET status=$2, dial_state='disposed', metadata=$3::jsonb,
      next_retry_at=$4, lease_expires_at=NULL, updated_at=now() WHERE id=$1`,[attemptId,update.status,JSON.stringify(update.metadata),update.next_retry_at]);
    if(update.contact_validation_status) await tx.query(`UPDATE outbound_contact_records SET validation_status=$2 WHERE id=$1`,[ledger.contact_record_id,update.contact_validation_status]);
    const wrapup=await completeAcdWrapup(pool,{workItemId:work.id,expectedAgentId:agentId,wrapupCodeId:dispositionCodeId,transactionClient:tx,actor:`agent:${agentId}`});
    if(!wrapup.completed || wrapup.alreadyCompleted) throw Object.assign(new Error(wrapup.reason||'Cannot complete agent wrap-up'),{status:409});
    const agent=(await tx.query(`SELECT * FROM acd_agent_state WHERE agent_id=$1`,[agentId])).rows[0];
    await tx.query('COMMIT');
    return {ok:true,attemptId,status:update.status,agent_status:effectiveAgentStatus(agent)};
  } catch(error) {await tx.query('ROLLBACK');throw error;} finally {tx.release();}
}
