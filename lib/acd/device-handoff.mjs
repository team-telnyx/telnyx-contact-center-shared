// A device handoff preserves the handling segment and capacity reservation.
// The authenticated target can pull its own active interaction; ownership changes only after media evidence.
import { randomUUID } from 'node:crypto';
import { authenticateVoiceEndpoint, voiceLockKey } from './voice-endpoints.mjs';
import { startSaga, driveSaga } from './saga-engine.mjs';
import { appendEvent } from './events.mjs';
import { createTelnyxProvider } from './provider.mjs';
import { agentJoinToken } from '../video/lifecycle.mjs';
import './sagas/device-handoff.mjs';
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
const live=s=>s && ['running','compensating'].includes(s.state);
export function handoffPresentation(s,endpointId) {
  if(!s)return null;
  return {id:s.id,channel:s.data.channel,state:s.state,step:s.step,sourceId:s.data.sourceId,targetId:s.data.targetId,
    targetLabel:s.data.targetLabel,isTarget:s.data.targetId===endpointId,deadlineAt:s.deadline_at,
    canCancel:live(s)&&[s.data.sourceId,s.data.targetId].includes(endpointId)&&['dial_target','await_answer','await_video'].includes(s.step),
    canJoin:live(s)&&s.step==='await_video'&&s.data.targetId===endpointId,
    completed:s.state==='succeeded',ownershipCommitted:s.data.ownershipCommitted===true,error:s.presentationError||s.last_error||null};
}
export async function readDeviceHandoff(db,user,request,workItemId) {
  const endpoint=await authenticateVoiceEndpoint(db,user,request.headers.get('x-cc-endpoint-token'));
  const segment=(await db.query(`SELECT s.*,w.channel,w.state,w.terminal_at FROM acd_segments s JOIN acd_work_items w ON w.id=s.work_item_id
    WHERE s.work_item_id=$1 AND s.agent_id=$2 AND s.kind='agent' ORDER BY s.seq DESC LIMIT 1`,[workItemId,String(user.id)])).rows[0];
  if(!segment)throw fail('This interaction is not assigned to you.',403);
  const current=(await db.query(`SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='device_handoff' AND data->>'agentId'=$2
    ORDER BY created_at DESC LIMIT 1`,[workItemId,String(user.id)])).rows[0];
  const targets=(await db.query(`SELECT DISTINCT ON (kind) id,kind,label,expires_at>now() AND (ready OR push_ready) AS reachable,
    expires_at>now() AND video_ready AS video_ready FROM cc_voice_endpoints WHERE agent_id=$1 AND revoked_at IS NULL
    AND id<>$2 AND kind IS DISTINCT FROM (SELECT kind FROM cc_voice_endpoints WHERE id=$2) ORDER BY kind,expires_at>now() DESC,created_at DESC`,[String(user.id),segment.media_endpoint_id || endpoint.id])).rows;
  const source=(await db.query('SELECT kind FROM cc_voice_endpoints WHERE id=$1 AND agent_id=$2',[segment.media_endpoint_id,String(user.id)])).rows[0];
  if(current && current.state!=='succeeded') {
    const rejected=(await db.query(`SELECT operation,http_status FROM acd_commands WHERE saga_id=$1 AND status='failed' ORDER BY created_at DESC LIMIT 1`,[current.id])).rows[0];
    if(rejected) current.presentationError=`The ${rejected.operation==='device_handoff_dial'?'new call':'handoff command'} was rejected by the provider${rejected.http_status?` (HTTP ${rejected.http_status})`:''}. The handoff did not complete.`;
    else if(current.state==='cancelled') current.presentationError=current.data.cancelRequested?'Handoff cancelled.':'Handoff did not complete. The target did not connect in time or the call ended.';
  }
  const active=!segment.ended_at&&!segment.terminal_at&&segment.state==='active'&&['voice','video'].includes(segment.channel);
  const reachable=new Date(endpoint.expires_at)>new Date() && (segment.channel==='video'?endpoint.video_ready:endpoint.ready);
  const canTakeOver=Boolean(active&&source&&source.kind!==endpoint.kind&&segment.media_endpoint_id!==endpoint.id&&reachable&&!live(current));
  return {workItemId,active,currentEndpointId:endpoint.id,channel:segment.channel,canTakeOver,ownerVersion:String(segment.wrapup_owner_version||0),
    ownerLabel:source?.kind==='ios'?'iPhone':'Computer',
    unavailableReason:!active?'Only an active voice or video call can be taken over.':!reachable?'Reconnect this device before taking over the call.':null,
    canStart:active&&endpoint.id===segment.media_endpoint_id&&!live(current),
    ownerId:segment.media_endpoint_id,targets:targets.map(t=>({...t,reachable:segment.channel==='video'?t.video_ready:t.reachable})),
    handoff:handoffPresentation(current,endpoint.id)};
}
export async function commandDeviceHandoff(pool,user,request,workItemId,body,{provider=createTelnyxProvider(),rooms}={}) {
  const db=await pool.connect(); let sagaId, join=false;
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[voiceLockKey(user.id)]);
    await db.query('SELECT pg_advisory_xact_lock(741901,5)');
    const endpoint=await authenticateVoiceEndpoint(db,user,request.headers.get('x-cc-endpoint-token'));
    const work=(await db.query('SELECT * FROM acd_work_items WHERE id=$1 FOR UPDATE',[workItemId])).rows[0];
    const segment=(await db.query(`SELECT * FROM acd_segments WHERE work_item_id=$1 AND agent_id=$2 AND kind='agent'
      ORDER BY seq DESC LIMIT 1 FOR UPDATE`,[workItemId,String(user.id)])).rows[0];
    if(!work||!segment)throw fail('This interaction is not assigned to you.',403);
    if(body.action==='start'||body.action==='take_over') {
      const pull=body.action==='take_over';
      const targetId=pull?endpoint.id:body.targetId;
      if(!/^[0-9a-f-]{36}$/i.test(body.commandId||''))throw fail('A command ID is required.',400);
      const prior=(await db.query(`SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='device_handoff' AND data->>'commandId'=$2`,[workItemId,body.commandId])).rows[0];
      if(prior) {
        if(prior.data.agentId!==String(user.id)||(prior.data.initiatorId||prior.data.sourceId)!==endpoint.id||prior.data.targetId!==targetId||Boolean(prior.data.pull)!==pull)throw fail('Command ID already used.');
        sagaId=prior.id;
      } else {
        if(segment.ended_at||work.terminal_at||work.state!=='active'||!['voice','video'].includes(work.channel))throw fail('Only an active voice or video call can move.');
        if(pull) {
          if(segment.media_endpoint_id===endpoint.id)throw fail('This device already handles the call.');
          if(body.expectedOwnerId!==segment.media_endpoint_id||String(body.expectedVersion)!==String(segment.wrapup_owner_version||0))throw fail('The call moved to another device. Refresh before taking it over.');
        } else if(segment.media_endpoint_id!==endpoint.id)throw fail('Start the move on the device handling this call.');
        const sourceEndpoint=(await db.query('SELECT * FROM cc_voice_endpoints WHERE id=$1 AND agent_id=$2',[segment.media_endpoint_id,String(user.id)])).rows[0];
        if(!sourceEndpoint)throw fail('The current call device could not be identified.');
        if(work.handoff_saga_id)throw fail('A transfer is already in progress.');
        const target=(await db.query(`SELECT * FROM cc_voice_endpoints WHERE id=$1 AND agent_id=$2 AND revoked_at IS NULL AND expires_at>now()`,[targetId,String(user.id)])).rows[0];
        if(!target||target.id===sourceEndpoint.id||target.kind===sourceEndpoint.kind||!(work.channel==='video'?target.video_ready:pull?target.ready:target.ready||target.push_ready))throw fail('Open the other app and reconnect it before moving the call.');
        const occupied=await db.query(`SELECT 1 FROM acd_segments s JOIN acd_work_items w ON w.id=s.work_item_id
          WHERE s.media_endpoint_id=$1 AND s.id<>$2 AND s.ended_at IS NULL AND w.terminal_at IS NULL
          AND w.channel IN ('voice','video') AND w.state='active' LIMIT 1`,[target.id,segment.id]);
        if(occupied.rowCount)throw fail('Finish the other call on this device before taking over.');
        const data={agentId:String(user.id),commandId:body.commandId,channel:work.channel,segmentId:segment.id,sourceId:sourceEndpoint.id,initiatorId:endpoint.id,pull,
          targetId:target.id,targetLabel:target.kind==='ios'?'iPhone':'Computer',targetSip:target.sip_username,
          credentialId:target.credential_id,nonce:randomUUID(),connectionId:process.env.TELNYX_CALL_CONTROL_ID};
        if(work.channel==='voice') {
          const legs=(await db.query(`SELECT * FROM acd_legs WHERE work_item_id=$1 AND ended_at IS NULL`,[workItemId])).rows;
          const customer=legs.find(l=>l.role==='customer');
          const source=legs.find(l=>l.role==='agent_device')||legs.find(l=>l.role==='agent_transport');
          const parent=(await db.query(`SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type IN ('connect','manual_outbound') AND state='running'
            ORDER BY created_at DESC LIMIT 1`,[workItemId])).rows[0];
          if(!data.connectionId)throw fail('Call Control application is not configured for handoff.',503);
          if(!customer||!source||!parent||!data.connectionId||!target.sip_username)throw fail('The current call topology cannot be moved yet.');
          if(legs.some(l=>l.state==='held')||legs.some(l=>['consult_target','transfer_target','supervisor'].includes(l.role)))throw fail('Resume the call and finish consultation or supervision before moving it.');
          Object.assign(data,{customerCallId:customer.provider_call_id,sourceCallId:source.provider_call_id,parentId:parent.id,
            clientState:parent.data.clientState||null,sourceLegIds:legs.filter(l=>['agent_device','agent_transport'].includes(l.role)).map(l=>l.id),
            callerNumber:parent.data.fromNumber||work.customer_address,customerName:work.attributes?.customer_name||'Move current call'});
        } else {
          const video=(await db.query('SELECT * FROM acd_video_sessions WHERE work_item_id=$1',[workItemId])).rows[0];
          if(!video?.room_session_id||video.state!=='active')throw fail('The video room is not connected.');
          if(video.supervision)throw fail('End video supervision before moving the session.');
          const sources=(video.participants||[]).filter(p=>p.role==='agent'&&!p.left_at).map(p=>p.participant_id);
          if(!sources.length)throw fail('Waiting for video participant confirmation. Retry shortly.');
          Object.assign(data,{roomId:video.room_id,roomSessionId:video.room_session_id,sourceParticipants:sources});
        }
        const started=await startSaga(db,{type:'device_handoff',workItemId,conflictKey:'call-control',data,
          initialStep:work.channel==='video'?'await_video':'dial_target'});
        sagaId=started.sagaId;
        await db.query('UPDATE acd_work_items SET handoff_saga_id=$2,version=version+1 WHERE id=$1',[workItemId,sagaId]);
        await appendEvent(db,{workItemId,agentId:String(user.id),type:'device_handoff_requested',actor:`agent:${user.id}`,payload:{saga_id:sagaId,target_endpoint_id:target.id}});
      }
    } else {
      const saga=(await db.query(`SELECT * FROM acd_sagas WHERE id=$1 AND work_item_id=$2 AND type='device_handoff' FOR UPDATE`,[body.id,workItemId])).rows[0];
      if(!saga||saga.data.agentId!==String(user.id)||![saga.data.sourceId,saga.data.targetId].includes(endpoint.id))throw fail('This device cannot manage the handoff.',403);
      sagaId=saga.id;
      if(body.action==='cancel') {
        if(!live(saga)){await db.query('COMMIT');return readDeviceHandoff(pool,user,request,workItemId);}
        if(!['dial_target','await_answer','await_video'].includes(saga.step))throw fail('The media is already switching. Wait for confirmation.');
        await db.query(`UPDATE acd_sagas SET data=data||'{"cancelRequested":true}'::jsonb WHERE id=$1`,[sagaId]);
      } else if(body.action==='join') {
        if(endpoint.id!==saga.data.targetId||saga.step!=='await_video'||!live(saga)||new Date(saga.deadline_at)<=new Date())throw fail('This video move is no longer available.');
        join=saga.data;
      } else if(body.action==='ready') {
        if(saga.state==='succeeded'){await db.query('COMMIT');return readDeviceHandoff(pool,user,request,workItemId);}
        if(endpoint.id!==saga.data.targetId||!live(saga))throw fail('This video move is no longer available.');
        if(['kick_video_source','await_video_departure','commit_video'].includes(saga.step)) {
          await db.query('COMMIT');
          await driveSaga(pool,sagaId,{provider});
          return readDeviceHandoff(pool,user,request,workItemId);
        }
        if(saga.step!=='await_video'||new Date(saga.deadline_at)<=new Date())throw fail('This video move is no longer available.');
        // A UI callback alone is not evidence of joining. The signed room webhook
        // must have recorded the nonce issued exclusively to this target device.
        const video=(await db.query('SELECT participants FROM acd_video_sessions WHERE work_item_id=$1',[workItemId])).rows[0];
        const participant=video?.participants?.find(p=>p.handoff_nonce===saga.data.nonce&&!p.left_at);
        if(!participant)throw fail('Waiting for video connection confirmation. Retry shortly.');
        await db.query(`UPDATE acd_sagas SET data=data||jsonb_build_object('targetParticipant',$2::text) WHERE id=$1`,[sagaId,participant.participant_id]);
      } else throw fail('Unknown handoff command.',400);
    }
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
  if(join) {
    const credentials=await agentJoinToken(pool,{workItemId,agentId:String(user.id),...(rooms?{rooms}:{})});
    return {join:{...credentials,context:{role:'agent',handoffNonce:join.nonce,endpointId:join.targetId}},id:sagaId};
  }
  await driveSaga(pool,sagaId,{provider});
  return readDeviceHandoff(pool,user,request,workItemId);
}
