// A customer hangup or a successful hangup command does not prove that an
// agent's device stopped. Scope evidence to this assignment, not the current
// customer topology (which may already belong to another agent after transfer).
export async function agentMediaEvidence(tx, reservation) {
  if (reservation.channel !== 'voice' || !reservation.work_item_id) return { ended: true, leg: null };
  const legs = (await tx.query(`SELECT l.* FROM acd_legs l
    WHERE l.work_item_id = $1 AND l.role IN ('agent_device','consult_target','transfer_target','supervisor')
      AND (l.agent_id IS NULL OR l.agent_id = $3)
      AND ((l.owner_saga_id = $2 AND $2 IS NOT NULL)
        OR (l.owner_saga_id IS NULL AND l.agent_id = $3)
        OR EXISTS (SELECT 1 FROM acd_leg_intents i WHERE i.reservation_id = $4
          AND i.offer_generation = l.offer_generation AND l.role = 'agent_device'))
    ORDER BY l.created_at`, [reservation.work_item_id, reservation.owner_saga_id, reservation.agent_id, reservation.id])).rows;
  if (legs.length) return { ended: legs.every(leg => Boolean(leg.ended_at)), leg: legs.find(leg => !leg.ended_at) || null };
  const command = (await tx.query(`SELECT status FROM acd_commands WHERE saga_id = $1
    AND operation IN ('transfer_to_agent','outbound_agent_dial','consult_dial','blind_transfer') ORDER BY created_at DESC LIMIT 1`, [reservation.owner_saga_id])).rows[0];
  if (!command || command.status === 'failed' || command.status === 'planned') return { ended: true, leg: null };
  // A standalone agent Dial that ended before answer cannot carry customer
  // media. Require its signed terminal event and no bound or live sibling.
  const dialEnded=(await tx.query(`SELECT t.id FROM acd_leg_intents i
    JOIN acd_commands c ON c.command_id=i.command_id AND c.saga_id=$2
      AND c.operation='outbound_agent_dial' AND c.status IN ('accepted','confirmed')
    JOIN acd_legs t ON t.provider_call_id=i.transport_call_id AND t.owner_saga_id=$2
    JOIN acd_webhook_events e ON e.payload->>'call_control_id'=t.provider_call_id
      AND e.event_type='call.hangup' AND e.status IN ('applied','noop')
    WHERE i.reservation_id=$1 AND i.state='cancelled' AND i.bound_leg_id IS NULL
      AND t.ended_at IS NOT NULL AND t.answered_at IS NULL AND t.bridged_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM acd_legs sibling WHERE sibling.owner_saga_id=$2 AND sibling.ended_at IS NULL)
    LIMIT 1`,[reservation.id,reservation.owner_saga_id])).rows[0];
  if(dialEnded)return {ended:true,leg:null,proof:{kind:'unanswered_agent_dial_ended',transportLegId:dialEnded.id}};
  // A positively cancelled, never-answered transfer is different from losing
  // one sibling of an established call. Telnyx may cancel the outbound INVITE
  // before it creates a device leg. Require the exact assignment and its
  // persisted hangup event; a generic transport end remains insufficient.
  //
  // The customer's own fate is deliberately NOT part of this proof. A no-answer
  // offer requeues its live customer, so demanding an abandoned work item and a
  // dead customer leg left that agent holding a reservation no evidence could
  // ever release. Everything that proves the AGENT's media never existed is
  // kept: the cancelled intent, no bound device leg, an unanswered/unbridged
  // transport ended by our own cancellation, its signed hangup event, and no
  // surviving leg of this assignment.
  const cancelled = (await tx.query(`SELECT i.id AS intent_id,t.id AS transport_leg_id,e.event_id
    FROM acd_leg_intents i
    JOIN acd_legs t ON t.provider_call_id=i.transport_call_id
      AND t.work_item_id=i.work_item_id AND t.offer_generation=i.offer_generation
      AND t.owner_saga_id=$2 AND t.role='agent_transport'
    JOIN acd_commands c ON c.command_id=i.command_id AND c.saga_id=$2
      AND c.operation='transfer_to_agent' AND c.status IN ('accepted','confirmed')
    JOIN acd_webhook_events e ON e.payload->>'call_control_id'=t.provider_call_id
      AND e.event_type='call.hangup' AND e.status IN ('applied','noop')
      AND e.payload->>'hangup_cause'='originator_cancel'
    WHERE i.reservation_id=$1 AND i.state='cancelled' AND i.bound_leg_id IS NULL
      AND t.ended_at IS NOT NULL AND t.ended_reason='originator_cancel'
      AND t.answered_at IS NULL AND t.bridged_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM acd_legs sibling WHERE sibling.work_item_id=i.work_item_id
        AND sibling.owner_saga_id=$2 AND sibling.ended_at IS NULL)
    LIMIT 1`, [reservation.id,reservation.owner_saga_id])).rows[0];
  if (cancelled) return { ended: true, leg: null, proof: {kind:'cancelled_unanswered_transfer',...cancelled} };
  // Same scoping rule as above: a provider-confirmed absence is evidence about
  // this assignment's agent media, so it must not be withheld because the
  // customer of a requeued call is still live.
  const absence=(await tx.query(`SELECT e.id AS evidence_event_id,e.payload->>'probe_command_id' AS probe_command_id
    FROM acd_events e
    JOIN acd_leg_intents i ON i.reservation_id=$1 AND i.work_item_id=e.work_item_id
      AND i.state='cancelled' AND i.bound_leg_id IS NULL
    WHERE e.work_item_id=$2 AND e.type='agent_media_absence_verified'
      AND e.payload->>'reservation_id'=$1::text AND e.payload->>'owner_saga_id'=$3::text
      AND NOT EXISTS(SELECT 1 FROM acd_legs l WHERE l.work_item_id=e.work_item_id
        AND l.owner_saga_id=$3::uuid AND l.ended_at IS NULL)
    ORDER BY e.id DESC LIMIT 1`,[reservation.id,reservation.work_item_id,reservation.owner_saga_id])).rows[0];
  if(absence)return {ended:true,leg:null,proof:{kind:'provider_confirmed_absence',...absence}};
  const transport = (await tx.query(`SELECT l.* FROM acd_legs l WHERE l.work_item_id = $1 AND l.ended_at IS NULL
    AND (l.agent_id IS NULL OR l.agent_id = $4)
    AND l.role IN ('agent_transport','consult_transport','transfer_transport')
    AND (l.owner_saga_id = $2 OR EXISTS (SELECT 1 FROM acd_leg_intents i
      WHERE i.reservation_id = $3 AND i.offer_generation = l.offer_generation)) ORDER BY l.created_at LIMIT 1`,
  [reservation.work_item_id, reservation.owner_saga_id, reservation.id, reservation.agent_id])).rows[0];
  // An accepted or ambiguous dial with no device event yet remains unknown.
  return { ended: false, leg: transport || null };
}
