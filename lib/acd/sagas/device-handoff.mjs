import { randomUUID } from 'node:crypto';
import { defineSaga } from '../saga-engine.mjs';
import { appendEvent } from '../events.mjs';
const patch=(tx,ctx,value)=>tx.query('UPDATE acd_sagas SET data=data||$2::jsonb WHERE id=$1',[ctx.saga.id,JSON.stringify(value)]);
const targetLeg=async(tx,ctx)=>(await tx.query(`SELECT * FROM acd_legs WHERE work_item_id=$1 AND owner_saga_id=$2
  AND role IN ('handoff_target','handoff_transport') ORDER BY (role='handoff_target') DESC,created_at DESC LIMIT 1`,[ctx.workItem.id,ctx.saga.id])).rows[0];
async function stopRequested(tx,ctx) {
  if(ctx.workItem.terminal_at||ctx.workItem.state!=='active'||ctx.data.cancelRequested)return 'cleanup_target';
  const endpoint=await tx.query('SELECT 1 FROM cc_voice_endpoints WHERE id=$1 AND agent_id=$2 AND revoked_at IS NULL',[ctx.data.targetId,ctx.data.agentId]);
  if(!endpoint.rowCount)return 'cleanup_target';
  const segment=(await tx.query('SELECT ended_at FROM acd_segments WHERE id=$1',[ctx.data.segmentId])).rows[0];
  if(!segment||segment.ended_at)return 'cleanup_target';
  if(ctx.data.channel==='voice'&&['dial_target','await_answer','check_answer','bridge_target'].includes(ctx.saga.step)) {
    const source=await tx.query(`SELECT 1 FROM acd_legs WHERE id=ANY($1::uuid[]) AND ended_at IS NOT NULL`,[ctx.data.sourceLegIds]);
    if(source.rowCount)return 'cleanup_target';
  }
  if(ctx.data.channel==='video'&&ctx.data.targetParticipant) {
    const video=(await tx.query('SELECT participants FROM acd_video_sessions WHERE work_item_id=$1',[ctx.workItem.id])).rows[0];
    if(!video?.participants?.some(p=>p.participant_id===ctx.data.targetParticipant&&!p.left_at))return 'cleanup_target';
  }
  return null;
}
async function bridgeConfirmed(tx,ctx) {
  const target=await targetLeg(tx,ctx);
  if(!target||target.role!=='handoff_target'||!target.answered_at)return false;
  const device=await tx.query("SELECT 1 FROM acd_legs WHERE owner_saga_id=$1 AND role='handoff_target' AND ended_at IS NULL",[ctx.saga.id]);
  if(!device.rowCount)return false;
  const customer=(await tx.query('SELECT * FROM acd_legs WHERE provider_call_id=$1 AND ended_at IS NULL',[ctx.data.customerCallId])).rows[0];
  if(!customer||target.ended_at)return false;
  if(customer.bridged_peer_call_id===target.provider_call_id||target.bridged_peer_call_id===customer.provider_call_id)return true;
  // Some provider events omit the peer. Both freshly bridged legs, tied to
  // this unique Dial and its exclusive bridge command, are sufficient.
  const command=(await tx.query("SELECT MIN(created_at) AS at FROM acd_commands WHERE saga_id=$1 AND operation='device_handoff_bridge'",[ctx.saga.id])).rows[0];
  return Boolean(command?.at && target.bridged_at && customer.bridged_at &&
    !target.bridged_peer_call_id && !customer.bridged_peer_call_id &&
    new Date(target.bridged_at)>=new Date(command.at) && new Date(customer.bridged_at)>=new Date(command.at));
}
async function clear(tx,ctx) {
  await tx.query('UPDATE acd_work_items SET handoff_saga_id=NULL,version=version+1 WHERE id=$1 AND handoff_saga_id=$2',[ctx.workItem.id,ctx.saga.id]);
}
async function publish(tx,ctx,type) {
  await appendEvent(tx,{workItemId:ctx.workItem.id,agentId:ctx.data.agentId,type,actor:'device_handoff',
    payload:{saga_id:ctx.saga.id,source_endpoint_id:ctx.data.sourceId,target_endpoint_id:ctx.data.targetId}});
}
async function commitOwner(tx,ctx) {
  const work=(await tx.query('SELECT terminal_at,state FROM acd_work_items WHERE id=$1 FOR UPDATE',[ctx.workItem.id])).rows[0];
  if(!work||work.terminal_at||work.state!=='active')return false;
  const changed=await tx.query(`UPDATE acd_segments SET media_endpoint_id=$2,wrapup_endpoint_id=$2,wrapup_owner_version=wrapup_owner_version+1
    WHERE id=$1 AND ended_at IS NULL AND media_endpoint_id=$3 RETURNING id`,[ctx.data.segmentId,ctx.data.targetId,ctx.data.sourceId]);
  if(!changed.rowCount)throw new Error('The handling segment changed during device handoff');
  await tx.query('UPDATE cc_agent_voice_preferences SET endpoint_id=$2,generation=generation+1 WHERE agent_id=$1',[ctx.data.agentId,ctx.data.targetId]);
  await tx.query('UPDATE users SET telephony_credentials_id=$2,telephony_user_name=$3 WHERE id=$1',[ctx.data.agentId,ctx.data.credentialId,ctx.data.targetSip]);
  await tx.query(`UPDATE acd_agent_sessions SET capabilities=jsonb_set(jsonb_set(capabilities,'{voice}',to_jsonb(id=$2::uuid AND EXISTS(SELECT 1 FROM cc_voice_endpoints e WHERE e.id=$2 AND (e.ready OR e.push_ready)))),
    '{video}',to_jsonb(id=$2::uuid AND EXISTS(SELECT 1 FROM cc_voice_endpoints e WHERE e.id=$2 AND e.video_ready))) WHERE agent_id=$1`,[ctx.data.agentId,ctx.data.targetId]);
  await publish(tx,ctx,'voice_endpoint_changed');
  await patch(tx,ctx,{ownershipCommitted:true});
  await publish(tx,ctx,'device_handoff_completed');
  return true;
}
export const deviceHandoffSaga=defineSaga('device_handoff',{
  initialStep:'dial_target',steps:{
    dial_target:{guard:stopRequested,cmd:ctx=>({operation:'device_handoff_dial',endpoint:'/calls',request:{
      connection_id:ctx.data.connectionId,to:`sip:${ctx.data.targetSip}@sip.telnyx.com`,
      from:ctx.data.callerNumber,client_state:ctx.data.clientState||undefined,from_display_name:'Take over current call',timeout_secs:30,
      // Dial must not unbridge the current call. Park is applied by the explicit Bridge after answer.
      custom_headers:[{name:'X-CC-Work-Item-Id',value:ctx.workItem.id},{name:'X-CC-Saga-Id',value:ctx.saga.id},
        {name:'X-CC-Leg-Role',value:'handoff_target'},{name:'X-CC-Handoff-Nonce',value:ctx.data.nonce}]}}),
      onAccepted:async(tx,{saga,response})=>{
        const callId=response?.data?.call_control_id;if(!callId)return;
        await tx.query(`INSERT INTO acd_legs(id,work_item_id,role,agent_id,provider_call_id,owner_saga_id,state)
          VALUES($1,$2,'handoff_transport',$3,$4,$5,'ringing') ON CONFLICT(provider_call_id) DO NOTHING`,
          [randomUUID(),saga.work_item_id,saga.data.agentId,callId,saga.id]);
      },on:{accepted:'await_answer'},deadlineMs:35000,onDeadline:'cleanup_target',onFailure:'cleanup_target'},
    await_answer:{run:async(tx,ctx)=>{
      const stop=await stopRequested(tx,ctx);if(stop)return stop;
      const target=await targetLeg(tx,ctx);
      if(target?.role==='handoff_target'&&target.ended_at)return 'cleanup_target';
      return target?.role==='handoff_target'&&target.answered_at?'bridge_target':null;
    },on:{'leg.answered:handoff_transport':'check_answer','leg.answered:handoff_target':'check_answer',
      'leg.ended:handoff_transport':'check_answer','leg.ended:handoff_target':'cleanup_target','leg.ended:customer':'cleanup_target','leg.ended:agent_device':'cleanup_target'},
      deadlineMs:35000,onDeadline:'cleanup_target'},
    check_answer:{run:async(tx,ctx)=>{
      const stop=await stopRequested(tx,ctx);if(stop)return stop;
      const target=await targetLeg(tx,ctx);
      if(target?.role==='handoff_target'&&target.ended_at)return 'cleanup_target';
      return target?.role==='handoff_target'&&target.answered_at?'bridge_target':'await_answer';
    }},
    bridge_target:{guard:stopRequested,cmd:async ctx=>{
      const target=await targetLeg(ctx.tx,ctx);
      if(!target||target.role!=='handoff_target'||!target.answered_at||target.ended_at)throw new Error('Handoff target no longer connected');
      return {operation:'device_handoff_bridge',endpoint:`/calls/${encodeURIComponent(ctx.data.customerCallId)}/actions/bridge`,
        request:{call_control_id:target.provider_call_id,park_after_unbridge:'self'}};
    },on:{accepted:'verify_bridge','leg.bridged:customer':'verify_bridge','leg.bridged:handoff_transport':'verify_bridge','leg.bridged:handoff_target':'verify_bridge'},
      deadlineMs:10000,onDeadline:'verify_bridge',onFailure:'cleanup_target'},
    verify_bridge:{run:async(tx,ctx)=>{
      if(ctx.workItem.terminal_at)return 'cleanup_target';
      if(await bridgeConfirmed(tx,ctx))return 'commit_voice';
      const target=await targetLeg(tx,ctx);
      if(target?.ended_at) {
        const source=(await tx.query('SELECT ended_at FROM acd_legs WHERE provider_call_id=$1',[ctx.data.sourceCallId])).rows[0];
        return source&&!source.ended_at?'restore_source':'cleanup_target';
      }
      // A timeout is not proof that the bridge failed. Retain both legs and
      // the mutex; the signed bridge/hangup event resolves an uncertain command.
      return null;
    },on:{'leg.bridged:customer':'verify_bridge','leg.bridged:handoff_transport':'verify_bridge','leg.bridged:handoff_target':'verify_bridge','leg.ended:handoff_transport':'verify_bridge','leg.ended:handoff_target':'verify_bridge','leg.ended:customer':'cleanup_target'},
      deadlineMs:15000,onDeadline:'reconcile_bridge'},
    restore_source:{cmd:ctx=>({operation:'device_handoff_restore',endpoint:`/calls/${encodeURIComponent(ctx.data.customerCallId)}/actions/bridge`,
      request:{call_control_id:ctx.data.sourceCallId,park_after_unbridge:'self'}}),
      on:{accepted:'verify_restore','leg.bridged:customer':'verify_restore','leg.ended:customer':'cleanup_target'},
      deadlineMs:10000,onDeadline:'verify_restore',onFailure:'verify_restore'},
    verify_restore:{run:async(tx,ctx)=>{
      if(ctx.workItem.terminal_at)return 'cleanup_target';
      const restored=await tx.query(`SELECT 1 FROM acd_legs l WHERE provider_call_id=$1 AND bridged_peer_call_id=$2 AND ended_at IS NULL
        AND bridged_at>=(SELECT MIN(created_at) FROM acd_commands WHERE saga_id=$3 AND operation='device_handoff_restore')`,[ctx.data.customerCallId,ctx.data.sourceCallId,ctx.saga.id]);
      return restored.rowCount?'cleanup_target':null;
    },on:{'leg.bridged:customer':'verify_restore','leg.ended:customer':'cleanup_target'},deadlineMs:15000,onDeadline:'verify_restore'},
    reconcile_bridge:{run:async(tx,ctx)=>{
      if(await bridgeConfirmed(tx,ctx))return 'commit_voice';
      if(ctx.workItem.terminal_at)return 'cleanup_target';
      await publish(tx,ctx,'device_handoff_awaiting_media_evidence');return 'verify_bridge';
    }},
    commit_voice:{run:async(tx,ctx)=>{
      if(ctx.workItem.terminal_at)return 'cleanup_target';
      if(!await bridgeConfirmed(tx,ctx))return 'verify_bridge';
      const target=await targetLeg(tx,ctx);
      const parent=(await tx.query('SELECT * FROM acd_sagas WHERE id=$1 FOR UPDATE',[ctx.data.parentId])).rows[0];
      if(!parent||parent.state!=='running')return 'cleanup_target';
      if(!await commitOwner(tx,ctx))return 'cleanup_target';
      // Retired source legs cannot finish the original assignment when their
      // delayed hangup arrives. The replacement assumes that lifecycle owner.
      await tx.query(`UPDATE acd_legs SET role='handoff_source',owner_saga_id=$2 WHERE id=ANY($1::uuid[])`,[ctx.data.sourceLegIds,ctx.saga.id]);
      await tx.query(`UPDATE acd_legs SET role=CASE WHEN role='handoff_transport' THEN 'agent_transport' ELSE 'agent_device' END,
        owner_saga_id=$2,offer_generation=$3 WHERE owner_saga_id=$1 AND role IN ('handoff_target','handoff_transport')`,
        [ctx.saga.id,parent.id,parent.data.generation??1]);
      const device=(await tx.query(`SELECT id,provider_call_id FROM acd_legs WHERE work_item_id=$1 AND owner_saga_id=$2 AND role='agent_device' AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1`,[ctx.workItem.id,parent.id])).rows[0];
      const transport=(await tx.query(`SELECT provider_call_id FROM acd_legs WHERE work_item_id=$1 AND owner_saga_id=$2 AND role='agent_transport' ORDER BY created_at DESC LIMIT 1`,[ctx.workItem.id,parent.id])).rows[0];
      const agentCallId=device?.provider_call_id||target.provider_call_id;
      if(device)await tx.query(`INSERT INTO acd_leg_intents
        (id,work_item_id,reservation_id,agent_id,offer_generation,expected_role,command_id,state,transport_call_id,bound_leg_id,deadline_at)
        VALUES($1,$2,$3,$4,$5,'agent_device',$6,'bound',$7,$8,now())
        ON CONFLICT(work_item_id,expected_role,offer_generation) DO UPDATE SET
          state='bound',transport_call_id=EXCLUDED.transport_call_id,bound_leg_id=EXCLUDED.bound_leg_id`,
        [randomUUID(),ctx.workItem.id,parent.data.reservationId||null,ctx.data.agentId,parent.data.generation??1,
          `device-handoff:${ctx.saga.id}`,transport?.provider_call_id||target.provider_call_id,device.id]);
      await tx.query(`UPDATE acd_sagas SET data=data||jsonb_build_object('agentProviderCallId',$2::text) WHERE id=$1`,[parent.id,agentCallId]);
      await tx.query(`UPDATE acd_work_items SET attributes=attributes||jsonb_build_object('agent_device_call_control_id',$2::text) WHERE id=$1`,[ctx.workItem.id,agentCallId]);
      await clear(tx,ctx);return 'hangup_source';
    }},
    hangup_source:{guard:async(tx,ctx)=>{
      const source=(await tx.query('SELECT ended_at FROM acd_legs WHERE provider_call_id=$1',[ctx.data.sourceCallId])).rows[0];
      return source?.ended_at?'succeeded':null;
    },cmd:ctx=>({operation:'device_handoff_release_source',endpoint:`/calls/${encodeURIComponent(ctx.data.sourceCallId)}/actions/hangup`,request:{}}),
      on:{accepted:'succeeded','leg.ended:handoff_source':'succeeded'},deadlineMs:10000,onDeadline:'retry_source',onFailure:'retry_source'},
    retry_source:{run:async(tx,ctx)=>{
      const source=(await tx.query('SELECT ended_at FROM acd_legs WHERE provider_call_id=$1',[ctx.data.sourceCallId])).rows[0];
      return source?.ended_at?'succeeded':'hangup_source';
    }},
    await_video:{run:async(tx,ctx)=>{
      const stop=await stopRequested(tx,ctx);if(stop)return stop;
      return ctx.data.targetParticipant?'kick_video_source':null;
    },deadlineMs:60000,onDeadline:'cleanup_target'},
    kick_video_source:{guard:stopRequested,cmd:ctx=>({operation:'device_handoff_video_kick',
      endpoint:`/room_sessions/${encodeURIComponent(ctx.data.roomSessionId)}/actions/kick`,request:{participants:ctx.data.sourceParticipants}}),
      on:{accepted:'await_video_departure'},deadlineMs:10000,onDeadline:'kick_video_source',onFailure:'video_switch_failed'},
    video_switch_failed:{run:async(tx,ctx)=>{
      await publish(tx,ctx,'device_handoff_video_switch_failed');return 'cleanup_target';
    }},
    await_video_departure:{run:async(tx,ctx)=>{
      const stop=await stopRequested(tx,ctx);if(stop)return stop;
      const video=(await tx.query('SELECT participants FROM acd_video_sessions WHERE work_item_id=$1',[ctx.workItem.id])).rows[0];
      return ctx.data.sourceParticipants.every(id=>video?.participants?.some(p=>p.participant_id===id&&p.left_at))?'commit_video':null;
    },deadlineMs:15000,onDeadline:'await_video_departure'},
    commit_video:{run:async(tx,ctx)=>{
      const stop=await stopRequested(tx,ctx);if(stop)return stop;
      if(ctx.workItem.terminal_at)return 'cleanup_target';
      if(!await commitOwner(tx,ctx))return 'cleanup_target';
      await clear(tx,ctx);return 'succeeded';
    }},
    cleanup_target:{run:async(tx,ctx)=>{
      if(ctx.data.channel==='video') {
        const session=(await tx.query('SELECT participants FROM acd_video_sessions WHERE work_item_id=$1',[ctx.workItem.id])).rows[0];
        const ids=(session?.participants||[]).filter(p=>p.handoff_nonce===ctx.data.nonce&&!p.left_at).map(p=>p.participant_id);
        if(ids.length){await patch(tx,ctx,{cleanupParticipants:ids});return 'kick_video_target';}
      } else {
        const target=await targetLeg(tx,ctx);
        if(target&&!target.ended_at){await patch(tx,ctx,{cleanupCallId:target.provider_call_id});return 'hangup_target';}
        // A timeout is not evidence of absence. Keep the durable fence until a
        // signed event binds the unknown leg, then clean up that exact leg.
        const unknown=!target&&(await tx.query(`SELECT 1 FROM acd_commands WHERE saga_id=$1 AND operation='device_handoff_dial'
          AND status IN ('sent','ambiguous','accepted')`,[ctx.saga.id])).rowCount;
        if(unknown)return 'await_late_target';
      }
      return 'cancelled_move';
    }},
    await_late_target:{run:async(tx,ctx)=>{
      if(await targetLeg(tx,ctx))return 'cleanup_target';return null;
    },deadlineMs:60000,onDeadline:'cleanup_target'},
    hangup_target:{cmd:ctx=>({operation:'device_handoff_cancel_target',endpoint:`/calls/${encodeURIComponent(ctx.data.cleanupCallId)}/actions/hangup`,request:{}}),
      on:{accepted:'cancelled_move','leg.ended:handoff_transport':'cancelled_move','leg.ended:handoff_target':'cancelled_move'},deadlineMs:10000,onDeadline:'cleanup_target',onFailure:'cleanup_target'},
    kick_video_target:{cmd:ctx=>({operation:'device_handoff_cancel_video',endpoint:`/room_sessions/${encodeURIComponent(ctx.data.roomSessionId)}/actions/kick`,request:{participants:ctx.data.cleanupParticipants}}),
      on:{accepted:'cancelled_move'},deadlineMs:10000,onDeadline:'cleanup_target',onFailure:'cancelled_move'},
    cancelled_move:{run:async(tx,ctx)=>{await clear(tx,ctx);await publish(tx,ctx,'device_handoff_cancelled');
      if(ctx.data.channel==='voice') {
        const ended=await tx.query(`SELECT 1 FROM acd_legs WHERE id=ANY($1::uuid[]) AND role='agent_device' AND ended_at IS NOT NULL`,[ctx.data.sourceLegIds]);
        if(ended.rowCount)await tx.query(`UPDATE acd_sagas SET step=CASE WHEN type='connect' THEN 'hangup_customer' ELSE 'cleanup_customer' END,
          step_sequence=step_sequence+1,deadline_at=now(),lease_owner=NULL,lease_expires_at=NULL
          WHERE id=$1 AND state='running'`,[ctx.data.parentId]);
      }
      return 'cancelled';}}
  }
});
