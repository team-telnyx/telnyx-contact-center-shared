import { createHash } from 'node:crypto';
import { applyTransition,openSegment } from './lifecycle.mjs';
import { tryOfferAndReserve,releaseReservation,resolveOffer } from './reservations.mjs';
import { beginWrapup,startTextOffer } from './text-lifecycle.mjs';
import { appendEvent } from './events.mjs';
import { candidatesForQueue,filterByCapacity } from './router.mjs';
import { channelProfile } from './channels.mjs';
import { NATIVE_LIFECYCLE_CHANNELS } from './channel-registry.mjs';
import { emailError } from '../email/provider.mjs';

export async function requireTextTransferWork(db,{workItemId,agentId,channel}){
  if(!NATIVE_LIFECYCLE_CHANNELS.includes(channel))throw emailError('Unsupported messaging channel');
  const work=(await db.query(`SELECT w.* FROM acd_work_items w WHERE w.id=$1 AND w.channel=$3 AND w.state='active' AND w.terminal_at IS NULL
    AND EXISTS(SELECT 1 FROM acd_text_assignments a WHERE a.work_item_id=w.id AND a.agent_id=$2 AND a.state='active')`,[workItemId,agentId,channel])).rows[0];
  if(!work)throw emailError('This messaging interaction is not active or assigned to you',403);
  return work;
}

export async function messagingTransferTargets(db,identity){
  const work=await requireTextTransferWork(db,identity),{channel,agentId}=identity;
  const queues=(await db.query(`SELECT q.id,q.name FROM cc_queues q JOIN cc_queue_channels c ON c.queue_id=q.id AND c.channel=$1 AND c.enabled WHERE q.enabled ORDER BY q.name`,[channel])).rows;
  const agents=[];
  for(const queue of queues){
    const candidates=filterByCapacity(await candidatesForQueue(db,queue.id,channel),channelProfile(channel)).filter(c=>c.agent_id!==agentId);
    if(!candidates.length)continue;
    const users=(await db.query(`SELECT id,first_name,last_name FROM users WHERE id=ANY($1::text[]) AND NOT EXISTS
      (SELECT 1 FROM acd_direct_intents i WHERE i.agent_id=users.id AND i.state='revoked' AND i.provider_call_id IS NOT NULL AND i.ended_at IS NULL)`,[candidates.map(c=>c.agent_id)])).rows;
    agents.push(...users.map(user=>({...user,queue_id:queue.id})));
  }
  const forward=channel==='email'?(await db.query(`SELECT m.id AS message_id,e.envelope->>'subject' AS subject,jsonb_array_length(COALESCE(e.envelope->'attachments','[]'::jsonb)) AS attachment_count
    FROM acd_messages m JOIN cc_email_messages e ON e.message_id=m.id JOIN cc_email_mailboxes b ON b.id=e.mailbox_id AND b.sending_enabled
    WHERE m.conversation_id=$1 AND m.sender_role='customer' AND e.provider_message_id IS NOT NULL ORDER BY m.seq DESC LIMIT 1`,[work.conversation_id])).rows[0]||null:null;
  return {queues,agents,currentQueueId:work.queue_id,version:String(work.version),forward};
}

export async function transferTextWork(pool,{workItemId,agentId,queueId,targetAgentId=null,expectedVersion,commandId,channel="chat"}){
  if(!NATIVE_LIFECYCLE_CHANNELS.includes(channel)||typeof queueId!=='string'||!queueId||expectedVersion==null||!/^[a-f0-9-]{36}$/i.test(commandId||''))throw emailError('Transfer destination, version and command ID are required');
  const db=await pool.connect(),hash=createHash('sha256').update(JSON.stringify({action:'transfer',queueId,targetAgentId,expectedVersion})).digest('hex');
  try{
    await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(741901,5)');
    const work=(await db.query("SELECT * FROM acd_work_items WHERE id=$1 AND channel=$2 FOR UPDATE",[workItemId,channel])).rows[0];
    const prior=(await db.query('SELECT * FROM acd_text_commands WHERE work_item_id=$1 AND actor_id=$2 AND command_id=$3',[workItemId,agentId,commandId])).rows[0];
    if(prior){if(prior.request_hash!==hash)throw emailError('Transfer ID already used',409);await db.query('COMMIT');return prior.result;}
    await requireTextTransferWork(db,{workItemId,agentId,channel});
    if(String(work.version)!==String(expectedVersion))throw emailError('Interaction changed. Refresh and retry.',409);
    if(targetAgentId===agentId)throw emailError('Choose another agent');
    const queue=(await db.query(`SELECT q.* FROM cc_queues q JOIN cc_queue_channels c ON c.queue_id=q.id AND c.channel=$2 AND c.enabled WHERE q.id=$1 AND q.enabled`,[queueId,channel])).rows[0];
    if(!queue)throw emailError(`Target queue is not accepting ${channel}`,409);
    if(channel==='email'&&(await db.query(`SELECT 1 FROM cc_email_messages e JOIN acd_messages m ON m.id=e.message_id WHERE m.work_item_id=$1 AND e.status IN ('queued','scheduled','ambiguous')`,[workItemId])).rowCount)throw emailError('Resolve pending sends before transferring',409);
    if(channel==='sms'&&(await db.query(`SELECT 1 FROM cc_sms_messages s JOIN acd_messages m ON m.id=s.message_id WHERE m.work_item_id=$1 AND s.status='queued'`,[workItemId])).rowCount)throw emailError('Wait for the pending SMS send before transferring',409);
    if(channel==='whatsapp'&&(await db.query(`SELECT 1 FROM cc_whatsapp_messages s JOIN acd_messages m ON m.id=s.message_id WHERE m.work_item_id=$1 AND s.status='queued'`,[workItemId])).rowCount)throw emailError('Wait for the pending WhatsApp send before transferring',409);
    const assignment=(await db.query("SELECT * FROM acd_text_assignments WHERE work_item_id=$1 AND agent_id=$2 AND state='active' FOR UPDATE",[workItemId,agentId])).rows[0];
    await beginWrapup(db,work,assignment,agentId,{outcome:'transferred'});
    const offer=(await db.query("SELECT id FROM acd_offers WHERE work_item_id=$1 AND agent_id=$2 AND state='accepted'",[workItemId,agentId])).rows[0];
    if(offer)await resolveOffer(db,offer.id,'cancelled',{reason:`${channel}_transferred`,actor:agentId});
    await releaseReservation(db,assignment.reservation_id,`${channel}_transferred`,{actor:agentId});
    await applyTransition(db,{workItemId,to:'queued',eventType:'work_item_queue_transferred',patch:{queueId,enqueuedAt:new Date().toISOString()},actor:agentId});
    await openSegment(db,{workItemId,kind:'queue_wait',queueId});
    if(targetAgentId){
      const next=await tryOfferAndReserve(db,{workItemId,agentId:targetAgentId,channel,offerDeadlineMs:30000,actor:agentId});
      if(!next)throw emailError(`Target agent is not eligible or has no ${channel} capacity`,409);
      await applyTransition(db,{workItemId,to:'offered',eventType:'work_item_offered',actor:agentId,payload:{agent_id:targetAgentId,offer_id:next.offerId}});
      await startTextOffer(db,{workItemId,...next,agentId:targetAgentId,offerDeadlineMs:30000});
    }
    const result={ok:true};
    await db.query('INSERT INTO acd_text_commands(work_item_id,actor_id,command_id,request_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)',[workItemId,agentId,commandId,hash,JSON.stringify(result)]);
    await appendEvent(db,{workItemId,type:`${channel}_transferred`,actor:agentId,payload:{queue_id:queueId,target_agent_id:targetAgentId}});
    await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

export const transferEmailWork=(pool,input)=>transferTextWork(pool,{...input,channel:"email"});
