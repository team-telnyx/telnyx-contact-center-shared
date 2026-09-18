import { defineSaga, startSaga } from '../saga-engine.mjs';
import { agentMediaEvidence } from '../agent-media-evidence.mjs';
import { releaseReservation } from '../reservations.mjs';
import { appendEvent } from '../events.mjs';

export async function startReservationCleanup(tx, reservation) {
  const conflictKey = `reservation-cleanup:${reservation.id}`;
  const existing = await tx.query(`SELECT 1 FROM acd_sagas WHERE work_item_id=$1 AND conflict_key=$2 AND state IN ('running','compensating')`, [reservation.work_item_id, conflictKey]);
  if (!existing.rowCount) await startSaga(tx, { type: 'reservation_cleanup', workItemId: reservation.work_item_id, conflictKey,
    data: { reservationId: reservation.id, ownerSagaId: reservation.owner_saga_id, agentId: reservation.agent_id } });
}

async function verify(tx, ctx) {
  const reservation = (await tx.query(`SELECT * FROM acd_reservations WHERE id=$1 FOR UPDATE`, [ctx.data.reservationId])).rows[0];
  if (!reservation || reservation.state === 'released') return 'succeeded';
  const evidence = await agentMediaEvidence(tx, reservation);
  if (evidence.ended) {
    await releaseReservation(tx, reservation.id, reservation.release_requested_reason, { actor: 'saga:reservation_cleanup' });
    return 'succeeded';
  }
  // Persist which leg has already received our cleanup command. Redelivery or
  // a worker restart must not send a new hangup for the same unresolved effect.
  if (evidence.leg && !(ctx.data.sentLegIds || []).includes(evidence.leg.id)) {
    await tx.query(`UPDATE acd_sagas SET data=data || jsonb_build_object('legId',$2::text,'callId',$3::text) WHERE id=$1`, [ctx.saga.id,evidence.leg.id,evidence.leg.provider_call_id]);
    return 'hangup';
  }
  // Telnyx may accept Hangup but lose or delay call.hangup delivery. Once the
  // exact leg has received our command, query that call directly. This closes
  // the projection only from explicit provider evidence and avoids both an
  // infinite Busy state and an unsafe time-based capacity release.
  if (evidence.leg && (ctx.data.sentLegIds || []).includes(evidence.leg.id)) {
    await tx.query(`UPDATE acd_sagas SET data=data || jsonb_build_object('legId',$2::text,'callId',$3::text) WHERE id=$1`, [ctx.saga.id,evidence.leg.id,evidence.leg.provider_call_id]);
    return 'verify_leg_end';
  }
  if(!evidence.leg&&!ctx.data.absenceChecked) {
    // A standalone agent Dial may time out without returning any leg ID.
    // After cancellation, reconcile that unknown effect using the same
    // complete provider inventories; never retry Dial or release by age.
    // The probe needs the connection that carried this assignment, which the
    // customer leg's own hangup event supplies. The customer does not have to
    // be gone: a requeued caller stays live while this agent's cancelled offer
    // still needs proof, so only legs owned by this assignment may block it.
    const candidate=(await tx.query(`SELECT i.command_id,s.data->>'connectionId' AS credential_id,
      l.provider_call_id AS customer_call_id,e.payload->>'connection_id' AS source_connection_id
      FROM acd_leg_intents i JOIN acd_sagas s ON s.id=$2
      JOIN acd_commands c ON c.command_id=i.command_id
      JOIN acd_legs l ON l.work_item_id=i.work_item_id AND l.role='customer'
      JOIN acd_webhook_events e ON e.payload->>'call_control_id'=l.provider_call_id
        AND e.event_type IN ('call.hangup','call.answered','call.enqueued')
        AND e.status='applied' AND e.payload->>'connection_id' IS NOT NULL
      WHERE i.reservation_id=$1 AND i.state='cancelled' AND i.bound_leg_id IS NULL
        AND i.deadline_at<now()
        AND ((c.operation='transfer_to_agent' AND c.status IN ('accepted','confirmed'))
          OR (c.operation='outbound_agent_dial' AND c.status IN ('accepted','confirmed','ambiguous')))
        AND NOT EXISTS(SELECT 1 FROM acd_legs live WHERE live.work_item_id=i.work_item_id
          AND live.owner_saga_id=$2 AND live.ended_at IS NULL)
      ORDER BY e.received_at DESC
      LIMIT 1`,[reservation.id,ctx.data.ownerSagaId])).rows[0];
    if(candidate?.credential_id&&candidate.source_connection_id) {
      await tx.query(`UPDATE acd_sagas SET data=data || jsonb_build_object('absenceRequest',$2::jsonb) WHERE id=$1`,[ctx.saga.id,JSON.stringify({customerCallId:candidate.customer_call_id,sourceConnectionId:candidate.source_connection_id,credentialId:candidate.credential_id,commandId:candidate.command_id})]);
      return 'verify_absence';
    }
  }
  return null;
}

defineSaga('reservation_cleanup', { initialStep: 'verify', steps: {
  verify: { run: verify, on: { 'leg.ended': 'verify', 'leg.initiated': 'verify' }, deadlineMs: 60000, onDeadline: 'alarm' },
  verify_absence: {
    cmd:ctx=>({operation:'verify_cancelled_agent_absence',endpoint:'/provider-evidence/active-calls',request:ctx.data.absenceRequest}),
    on:{accepted:'apply_absence'},deadlineMs:10000,onDeadline:'apply_absence',onFailure:'apply_absence',
  },
  apply_absence:{run:async(tx,ctx)=>{
    const command=(await tx.query(`SELECT command_id,response FROM acd_commands WHERE saga_id=$1
      AND operation='verify_cancelled_agent_absence' AND status IN ('accepted','confirmed') ORDER BY created_at DESC LIMIT 1`,[ctx.saga.id])).rows[0];
    if(command?.response?.data?.ended===true){
      await appendEvent(tx,{workItemId:ctx.workItem.id,agentId:ctx.data.agentId,type:'agent_media_absence_verified',actor:'saga:reservation_cleanup',
        payload:{reservation_id:ctx.data.reservationId,owner_saga_id:ctx.data.ownerSagaId,probe_command_id:command.command_id,...command.response.data}});
    }
    await tx.query(`UPDATE acd_sagas SET data=data || '{"absenceChecked":true}'::jsonb WHERE id=$1`,[ctx.saga.id]);
    return 'verify';
  }},
  verify_leg_end: {
    cmd: ctx => ({
      operation: 'verify_agent_leg_end',
      endpoint: '/provider-evidence/call',
      request: { callControlId: ctx.data.callId },
    }),
    on: { accepted: 'apply_leg_end', 'leg.ended': 'verify' },
    deadlineMs: 10000,
    onDeadline: 'await_leg_end',
    onFailure: 'await_leg_end',
  },
  apply_leg_end: { run: async (tx, ctx) => {
    const command = (await tx.query(`SELECT command_id,response FROM acd_commands WHERE saga_id=$1
      AND operation='verify_agent_leg_end' AND status IN ('accepted','confirmed') ORDER BY created_at DESC LIMIT 1`, [ctx.saga.id])).rows[0];
    const evidence = command?.response?.data;
    if (evidence?.ended !== true || evidence?.isAlive !== false
      || evidence?.callControlId !== ctx.data.callId) return 'await_leg_end';
    const ended = (await tx.query(`UPDATE acd_legs
      SET state='ended', ended_at=COALESCE(ended_at,now()),
          ended_reason=COALESCE(ended_reason,'provider_verified_ended')
      WHERE id=$1 AND provider_call_id=$2 AND ended_at IS NULL
      RETURNING id,provider_call_id`, [ctx.data.legId,ctx.data.callId])).rows[0];
    if (ended) await appendEvent(tx, {
      workItemId: ctx.workItem.id,
      agentId: ctx.data.agentId,
      type: 'agent_media_end_verified',
      actor: 'saga:reservation_cleanup',
      payload: {
        reservation_id: ctx.data.reservationId,
        owner_saga_id: ctx.data.ownerSagaId,
        leg_id: ended.id,
        call_control_id: ended.provider_call_id,
        probe_command_id: command.command_id,
        checked_at: evidence.checkedAt,
      },
    });
    return 'verify';
  }},
  // An alive, malformed or unavailable provider read is not end evidence.
  // Wait for the normal webhook and poll again only after the alarm interval;
  // this avoids a tight provider-read loop while preserving fail-closed
  // capacity semantics.
  await_leg_end: {
    on: { 'leg.ended': 'verify', 'leg.initiated': 'verify' },
    deadlineMs: 60000,
    onDeadline: 'alarm',
  },
  hangup: {
    prepare: async (tx, ctx) => { await tx.query(`UPDATE acd_sagas SET data=jsonb_set(data,'{sentLegIds}',COALESCE(data->'sentLegIds','[]') || to_jsonb($2::text)) WHERE id=$1`, [ctx.saga.id,ctx.data.legId]); },
    cmd: ctx => ({ operation: 'reservation_cleanup_hangup', targetLegId: ctx.data.legId,
      endpoint: `/calls/${encodeURIComponent(ctx.data.callId)}/actions/hangup`, request: {} }),
    on: { accepted: 'verify', 'leg.ended': 'verify' }, deadlineMs: 10000, onDeadline: 'verify', onFailure: 'verify',
  },
  alarm: { run: async (tx, ctx) => {
    if (!ctx.data.alarmed) {
      await appendEvent(tx, { workItemId: ctx.workItem.id, agentId: ctx.data.agentId, type: 'manual_intervention_required', actor: 'saga:reservation_cleanup',
        payload: { saga_id: ctx.saga.id, reservation_id: ctx.data.reservationId, reason: 'agent_device_end_unconfirmed', reservation_preserved: true } });
      await tx.query(`UPDATE acd_sagas SET data=data || '{"alarmed":true}'::jsonb WHERE id=$1`, [ctx.saga.id]);
    }
    await tx.query(`UPDATE acd_sagas SET data=data || '{"absenceChecked":false}'::jsonb WHERE id=$1`, [ctx.saga.id]);
    return 'verify';
  } },
} });
