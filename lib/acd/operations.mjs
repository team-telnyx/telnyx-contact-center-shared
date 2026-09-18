import { appendEvent } from "./events.mjs";
import "./sagas/index.mjs";
import { getSagaDefinition } from "./saga-engine.mjs";
import { agentMediaEvidence } from './agent-media-evidence.mjs';
import { releaseReservation } from './reservations.mjs';
import { closeOpenSegment, applyTransition } from './lifecycle.mjs';
import { setWorkflowState } from './agent-state.mjs';
import { NATIVE_LIFECYCLE_CHANNELS } from './channel-registry.mjs';

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
export async function readAcdOperations(pool, { channel = null } = {}) {
  // The channel filter narrows the native table in SQL (before the limit);
  // Voice has no native reservations, so that filter lists none.
  const nativeChannels = !channel ? NATIVE_LIFECYCLE_CHANNELS : NATIVE_LIFECYCLE_CHANNELS.includes(channel) ? [channel] : [];
  const [inbox, sagas, alarms, lag, voiceCapacity, nativeCapacity] = await Promise.all([
    pool.query(`SELECT event_id, event_type, status, attempt_count, last_error, received_at, next_attempt_at
      FROM acd_webhook_events WHERE status IN ('dead', 'unmatched', 'retryable_failed')
      ORDER BY received_at LIMIT 100`),
    pool.query(`SELECT id, type, work_item_id, state, step, deadline_at, last_error FROM acd_sagas
      WHERE state = 'failed' OR (state IN ('running', 'compensating') AND deadline_at < now())
      ORDER BY created_at DESC LIMIT 100`),
    pool.query(`SELECT id, work_item_id, agent_id, type, payload, occurred_at FROM acd_events
      WHERE type IN ('manual_intervention_required', 'invariant_violation', 'reconciler_corrected')
      ORDER BY id DESC LIMIT 50`),
    pool.query(`SELECT COUNT(*)::int AS pending, MIN(o.created_at) AS oldest_pending
      FROM acd_outbox o WHERE NOT EXISTS (SELECT 1 FROM acd_stream_events s WHERE s.outbox_seq = o.seq)`),
    pool.query(`SELECT r.id AS reservation_id, r.agent_id, r.work_item_id, r.state AS reservation_state,
        r.purpose, r.created_at, r.last_provider_event_at, r.release_requested_at,
        r.release_requested_reason, w.direction, w.state AS work_state, w.terminal_at,
        ast.workflow_state, ast.manual_status, u.username, u.first_name, u.last_name,
        leg.id AS leg_id, leg.role AS leg_role, leg.provider_call_id,
        leg.state AS leg_state, leg.created_at AS leg_created_at,
        cleanup.id AS cleanup_saga_id, cleanup.state AS cleanup_state,
        cleanup.step AS cleanup_step, cleanup.deadline_at AS cleanup_deadline_at,
        cleanup.last_error AS cleanup_error,
        EXTRACT(EPOCH FROM (now() - r.created_at))::int AS age_seconds,
        (r.release_requested_at IS NOT NULL OR w.terminal_at IS NOT NULL
          OR cleanup.state = 'failed'
          OR (cleanup.state IN ('running','compensating') AND cleanup.deadline_at < now())) AS needs_attention,
        last_action.result AS last_recovery_result,
        last_action.created_at AS last_recovery_at
      FROM acd_reservations r
      LEFT JOIN acd_work_items w ON w.id = r.work_item_id
      LEFT JOIN acd_agent_state ast ON ast.agent_id = r.agent_id
      LEFT JOIN users u ON u.id = r.agent_id
      LEFT JOIN LATERAL (
        SELECT l.* FROM acd_legs l
        WHERE l.work_item_id = r.work_item_id AND l.ended_at IS NULL
          AND l.role IN ('agent_device','consult_target','transfer_target','supervisor')
          AND ((l.owner_saga_id = r.owner_saga_id AND r.owner_saga_id IS NOT NULL)
            OR (l.owner_saga_id IS NULL AND l.agent_id = r.agent_id)
            OR EXISTS (SELECT 1 FROM acd_leg_intents i WHERE i.reservation_id = r.id
              AND i.offer_generation = l.offer_generation AND l.role = 'agent_device'))
        ORDER BY l.created_at LIMIT 1
      ) leg ON true
      LEFT JOIN LATERAL (
        SELECT s.id, s.state, s.step, s.deadline_at, s.last_error
        FROM acd_sagas s WHERE s.work_item_id = r.work_item_id
          AND s.type = 'reservation_cleanup'
          AND s.data->>'reservationId' = r.id::text
        ORDER BY s.created_at DESC LIMIT 1
      ) cleanup ON true
      LEFT JOIN LATERAL (
        SELECT a.result, a.created_at FROM acd_operator_actions a
        WHERE a.action = 'recover_voice_capacity' AND a.target_id = r.id::text
        ORDER BY a.created_at DESC LIMIT 1
      ) last_action ON true
      WHERE r.channel = 'voice' AND r.state <> 'released'
        AND (r.state = 'active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at > now())
      ORDER BY needs_attention DESC NULLS LAST, r.created_at
      LIMIT 100`),
    // Chat, messaging and video capacity: owned by an offer or a text
    // assignment. A reservation with neither, or whose work item already
    // ended, keeps the agent Busy for nothing and is safe to release.
    pool.query(`SELECT r.id AS reservation_id, r.agent_id, r.work_item_id, r.channel, r.state AS reservation_state,
        r.purpose, r.created_at, w.state AS work_state, w.terminal_at,
        ast.workflow_state, ast.manual_status, u.username, u.first_name, u.last_name,
        offer.state AS offer_state, assignment.state AS assignment_state, owner.state AS owner_saga_state,
        EXTRACT(EPOCH FROM (now() - r.created_at))::int AS age_seconds,
        (w.terminal_at IS NOT NULL OR (offer.id IS NULL AND assignment.reservation_id IS NULL)) AS needs_attention,
        last_action.result AS last_recovery_result, last_action.created_at AS last_recovery_at
      FROM acd_reservations r
      LEFT JOIN acd_work_items w ON w.id = r.work_item_id
      LEFT JOIN acd_agent_state ast ON ast.agent_id = r.agent_id
      LEFT JOIN users u ON u.id = r.agent_id
      LEFT JOIN LATERAL (
        SELECT o.id, o.state FROM acd_offers o
        WHERE o.work_item_id = r.work_item_id AND o.agent_id = r.agent_id AND o.state IN ('created','ringing','accepted')
        ORDER BY o.generation DESC LIMIT 1
      ) offer ON true
      LEFT JOIN acd_text_assignments assignment ON assignment.reservation_id = r.id AND assignment.state <> 'completed'
      LEFT JOIN acd_sagas owner ON owner.id = r.owner_saga_id
      LEFT JOIN LATERAL (
        SELECT a.result, a.created_at FROM acd_operator_actions a
        WHERE a.action = 'release_native_capacity' AND a.target_id = r.id::text
        ORDER BY a.created_at DESC LIMIT 1
      ) last_action ON true
      WHERE r.channel = ANY($1::text[]) AND r.state <> 'released'
        AND (r.state = 'active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at > now())
      ORDER BY needs_attention DESC NULLS LAST, r.created_at
      LIMIT 100`, [nativeChannels]),
  ]);
  const ids=[...new Set([...sagas.rows,...alarms.rows].map(row=>row.work_item_id).filter(Boolean))];
  const types=ids.length?(await pool.query('SELECT id,channel FROM acd_work_items WHERE id=ANY($1::uuid[])',[ids])).rows:[];
  const scopeRows=rows=>rows.map(row=>({...row,channel:types.find(w=>w.id===row.work_item_id)?.channel||null})).filter(row=>!channel||row.channel===channel);
  const health=(await pool.query(`SELECT channel,state,COUNT(*)::int AS total,MIN(created_at) AS oldest
    FROM acd_work_items WHERE terminal_at IS NULL AND ($1::text IS NULL OR channel=$1) GROUP BY channel,state ORDER BY channel,state`,[channel])).rows;
  const email=(await pool.query(`SELECT e.status,COUNT(*)::int AS total FROM cc_email_messages e JOIN acd_messages m ON m.id=e.message_id
    WHERE m.created_at>=now()-interval '24 hours' AND m.sender_role='agent' GROUP BY e.status`)).rows;
  return { inbox: inbox.rows, sagas: scopeRows(sagas.rows), alarms: scopeRows(alarms.rows),channelHealth:health,
    emailHealth: !channel||channel==='email'?email:[],outbox: lag.rows[0], voiceCapacity: voiceCapacity.rows,
    nativeCapacity: nativeCapacity.rows };
}

// Recovery requires provider end evidence before releasing any reservation.
export async function executeAcdOperation(pool, { actorId, requestId, action, targetId, reason, provider = null }) {
  if (!actorId || !/^[0-9a-f-]{36}$/i.test(requestId || "") || typeof reason !== "string" || reason.trim().length < 5 || reason.length > 1000) {
    fail("Request id and a reason of 5–1000 characters are required", 400);
  }
  if (!["retry_inbox", "retry_saga", "reconcile_ended_work", "recover_voice_capacity", "release_native_capacity"].includes(action)) fail("Unsupported recovery action", 400);
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [requestId]);
    const prior = (await tx.query(`SELECT * FROM acd_operator_actions WHERE request_id = $1`, [requestId])).rows[0];
    if (prior) {
      if (prior.actor_id !== actorId || prior.action !== action || prior.target_id !== targetId || prior.reason !== reason.trim()) fail("Request id already used");
      await tx.query("COMMIT"); return prior.result;
    }
    let result = { accepted: true, action, targetId };
    if (action === "retry_inbox") {
      const changed = await tx.query(`UPDATE acd_webhook_events SET status = 'received', attempt_count = 0,
        next_attempt_at = now(), processed_at = NULL, last_error = NULL
        WHERE event_id = $1 AND status IN ('dead', 'unmatched', 'retryable_failed') RETURNING event_id`, [targetId]);
      if (!changed.rowCount) fail("Inbox event is not available for retry");
    } else if (action === "retry_saga") {
      if (!/^[0-9a-f-]{36}$/i.test(targetId || "")) fail("Invalid saga id", 400);
      const saga = (await tx.query(`SELECT * FROM acd_sagas WHERE id = $1 FOR UPDATE`, [targetId])).rows[0];
      if (!saga || !["failed", "running", "compensating"].includes(saga.state)) fail("Saga cannot be resumed");
      const work=(await tx.query(`SELECT terminal_at FROM acd_work_items WHERE id=$1`,[saga.work_item_id])).rows[0];
      if (!['reservation_cleanup','target_cleanup','media_cleanup'].includes(saga.type) && (!work || work.terminal_at)) fail('Execution no longer owns an active Core work item');
      const competing=await tx.query(`SELECT 1 FROM acd_sagas WHERE work_item_id=$1 AND conflict_key=$2 AND id<>$3 AND state IN ('running','compensating') LIMIT 1`,[saga.work_item_id,saga.conflict_key,saga.id]);
      if(competing.rowCount) fail('Another execution owns this operation');
      if (saga.lease_owner && new Date(saga.lease_expires_at) > new Date()) fail("Another worker owns this execution");
      const unresolved = await tx.query(`SELECT 1 FROM acd_commands WHERE saga_id = $1 AND status IN ('sent', 'ambiguous')`, [targetId]);
      if (unresolved.rowCount) fail("Provider outcome is unknown; retain capacity and wait for evidence");
      if (!getSagaDefinition(saga.type).steps[saga.step]) fail("No safe recovery step");
      // A rejected command may be retried only through this audited intent,
      // using a new step sequence. Accepted commands keep their old identity.
      const rejected = await tx.query(`SELECT 1 FROM acd_commands WHERE saga_id = $1 AND step_sequence = $2 AND status = 'failed'`, [targetId, saga.step_sequence]);
      await tx.query(`UPDATE acd_sagas SET state = 'running', terminal_at = NULL,
        lease_owner = NULL, lease_expires_at = NULL, deadline_at = now() + interval '30 seconds',
        step_sequence = step_sequence + $2 WHERE id = $1`, [targetId, rejected.rowCount ? 1 : 0]);
    } else if (action === 'recover_voice_capacity') {
      if (!/^[0-9a-f-]{36}$/i.test(targetId || '')) fail('Invalid reservation id', 400);
      const reservation = (await tx.query(`SELECT * FROM acd_reservations
        WHERE id=$1 AND channel='voice' AND state<>'released' FOR UPDATE`, [targetId])).rows[0];
      if (!reservation) fail('Voice reservation is no longer consuming capacity');
      const directIntent = (await tx.query(`SELECT * FROM acd_direct_intents
        WHERE reservation_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [targetId])).rows[0];
      const localEvidence = await agentMediaEvidence(tx, reservation);
      const directEndedLeg = directIntent?.provider_call_id
        ? (await tx.query(`SELECT 1 FROM acd_legs WHERE provider_call_id=$1 AND ended_at IS NOT NULL`,
          [directIntent.provider_call_id])).rowCount > 0
        : false;
      const directEndKnown = !directIntent || Boolean(directIntent.ended_at) || directEndedLeg;
      if (localEvidence.ended && directEndKnown) {
        const released = await releaseReservation(tx, reservation.id, 'operator_verified_end', { actor: `supervisor:${actorId}` });
        result = { ...result, recovered: true, state: 'released', evidence: localEvidence.proof?.kind || 'local_end_evidence',
          agentId: reservation.agent_id, workItemId: reservation.work_item_id, providerChecked: false,
          released: Boolean(released) };
      } else if (!(localEvidence.leg?.provider_call_id || directIntent?.provider_call_id)) {
        result = { ...result, recovered: false, state: 'retained', evidence: 'provider_call_unknown',
          agentId: reservation.agent_id, workItemId: reservation.work_item_id, providerChecked: false };
      } else if (!provider?.send) {
        result = { ...result, recovered: false, state: 'retained', evidence: 'provider_unavailable',
          agentId: reservation.agent_id, workItemId: reservation.work_item_id, providerChecked: false };
      } else {
        const callControlId = localEvidence.leg?.provider_call_id || directIntent.provider_call_id;
        const check = await provider.send({
          operation: 'verify_agent_leg_end',
          endpoint: '/provider-evidence/call',
          request: { callControlId },
          commandId: `operator:${requestId}`,
        });
        const evidence = check?.response?.data;
        const ended = check?.outcome === 'accepted' && evidence?.ended === true
          && evidence?.isAlive === false && evidence?.callControlId === callControlId;
        if (!ended) {
          result = { ...result, recovered: false, state: 'retained',
            evidence: evidence?.isAlive === true ? 'provider_call_active' : 'provider_check_inconclusive',
            agentId: reservation.agent_id, workItemId: reservation.work_item_id,
            providerChecked: true, callControlId };
        } else {
          const endedLeg = (await tx.query(`UPDATE acd_legs
            SET state='ended', ended_at=COALESCE(ended_at,now()),
                ended_reason=COALESCE(ended_reason,'operator_provider_verified_ended')
            WHERE provider_call_id=$1 AND ended_at IS NULL
            RETURNING id`, [callControlId])).rows[0];
          if (directIntent) await tx.query(`UPDATE acd_direct_intents
            SET state='ended', ended_at=COALESCE(ended_at,now()) WHERE id=$1`, [directIntent.id]);
          if (endedLeg) await appendEvent(tx, {
            workItemId: reservation.work_item_id, agentId: reservation.agent_id,
            type: 'agent_media_end_verified', actor: `supervisor:${actorId}`,
            payload: { reservation_id: reservation.id, leg_id: endedLeg.id,
              call_control_id: callControlId, request_id: requestId,
              checked_at: evidence.checkedAt, source: 'operator_recovery' },
          });
          const released = await releaseReservation(tx, reservation.id, 'operator_provider_verified_end', { actor: `supervisor:${actorId}` });
          result = { ...result, recovered: !released?.pending, state: released?.pending ? 'pending' : 'released',
            evidence: 'provider_call_ended', agentId: reservation.agent_id,
            workItemId: reservation.work_item_id, providerChecked: true, callControlId };
        }
      }
    } else if (action === 'release_native_capacity') {
      // Chat, messaging and video reservations carry no provider media: the
      // only proof that capacity is still in use is a live offer or an open
      // text assignment. Without either (or once the work item ended) the
      // reservation is stale and only keeps the agent Busy.
      if (!/^[0-9a-f-]{36}$/i.test(targetId || '')) fail('Invalid reservation id', 400);
      await tx.query('SELECT pg_advisory_xact_lock(741901,5)');
      const reservation = (await tx.query(`SELECT * FROM acd_reservations
        WHERE id=$1 AND channel = ANY($2::text[]) AND state<>'released' FOR UPDATE`, [targetId, NATIVE_LIFECYCLE_CHANNELS])).rows[0];
      if (!reservation) fail('Reservation is no longer consuming capacity');
      const work = reservation.work_item_id
        ? (await tx.query('SELECT * FROM acd_work_items WHERE id=$1 FOR UPDATE', [reservation.work_item_id])).rows[0] : null;
      const liveOffer = reservation.work_item_id ? (await tx.query(`SELECT 1 FROM acd_offers WHERE work_item_id=$1 AND agent_id=$2
        AND state IN ('created','ringing','accepted') LIMIT 1`, [reservation.work_item_id, reservation.agent_id])).rowCount > 0 : false;
      const openAssignment = (await tx.query(`SELECT 1 FROM acd_text_assignments WHERE reservation_id=$1 AND state<>'completed'`, [targetId])).rowCount > 0;
      const running = reservation.work_item_id ? (await tx.query(`SELECT 1 FROM acd_sagas WHERE work_item_id=$1 AND state IN ('running','compensating') LIMIT 1`, [reservation.work_item_id])).rowCount > 0 : false;
      const workEnded = !work || Boolean(work.terminal_at);
      if (!workEnded && (liveOffer || openAssignment || running)) fail('Capacity is still owned by a live offer, assignment or execution');
      // An ended work item must not keep an open assignment behind: the desktop
      // would still list the interaction and accept actions on it while the
      // agent is already free for new work. Close it with the reservation.
      let assignmentClosed = false;
      if (workEnded && openAssignment) {
        const assignment = (await tx.query(`UPDATE acd_text_assignments SET state='completed',completed_at=now(),typing_until=NULL
          WHERE reservation_id=$1 AND state<>'completed' RETURNING segment_id, agent_id`, [targetId])).rows[0];
        if (assignment?.segment_id) await tx.query(`UPDATE acd_segments SET ended_at=COALESCE(ended_at,now()),
          outcome=COALESCE(outcome,'abandoned'), wrapup_ended_at=COALESCE(wrapup_ended_at,now()) WHERE id=$1`, [assignment.segment_id]);
        await tx.query(`UPDATE acd_offers SET state='cancelled', terminal_at=now() WHERE work_item_id=$1 AND agent_id=$2 AND state IN ('created','ringing','accepted')`,
          [reservation.work_item_id, reservation.agent_id]);
        assignmentClosed = true;
      }
      const released = await releaseReservation(tx, reservation.id, 'operator_released_stale', { actor: `supervisor:${actorId}` });
      const stillBusy = (await tx.query(`SELECT 1 FROM acd_reservations WHERE agent_id=$1 AND state<>'released'
        AND (state='active' OR owner_saga_id IS NOT NULL OR lease_expires_at>now()) LIMIT 1`, [reservation.agent_id])).rowCount > 0;
      const agentState = (await tx.query('SELECT workflow_state, workflow_work_item_id FROM acd_agent_state WHERE agent_id=$1 FOR UPDATE', [reservation.agent_id])).rows[0];
      let agentReleased = false;
      const ownsWrapup = agentState?.workflow_state === 'wrapup' && String(agentState.workflow_work_item_id) === String(reservation.work_item_id);
      if (!stillBusy && agentState && agentState.workflow_state !== 'idle' && (agentState.workflow_state !== 'wrapup' || (assignmentClosed && ownsWrapup))) {
        await setWorkflowState(tx, reservation.agent_id, 'idle', { actor: `supervisor:${actorId}`,
          workItemId: reservation.work_item_id, reason: 'operator_released_stale_capacity' });
        agentReleased = true;
      }
      result = { ...result, recovered: true, state: 'released', evidence: workEnded ? 'work_item_ended' : 'no_live_offer_or_assignment',
        channel: reservation.channel, agentId: reservation.agent_id, workItemId: reservation.work_item_id,
        released: Boolean(released), agentReleased, assignmentClosed };
    } else if (action === 'reconcile_ended_work') {
      if (!/^[0-9a-f-]{36}$/i.test(targetId || '')) fail('Invalid work item id', 400);
      const work = (await tx.query('SELECT * FROM acd_work_items WHERE id=$1 FOR UPDATE', [targetId])).rows[0];
      if (!work || work.channel !== 'voice' || work.direction !== 'inbound'
        || !['open', 'queued'].includes(work.state) || work.terminal_at) fail('Only a waiting inbound Core work item can be reconciled');
      const customers = (await tx.query("SELECT * FROM acd_legs WHERE work_item_id=$1 AND role='customer'", [targetId])).rows;
      if (!customers.length || customers.some(l => !l.ended_at)) fail('Customer end evidence is missing');
      for (const leg of customers) {
        const end = await tx.query(`SELECT 1 FROM acd_webhook_events WHERE event_type='call.hangup'
          AND status='applied' AND payload->>'call_control_id'=$1`, [leg.provider_call_id]);
        if (!end.rowCount) fail('Processed provider hangup evidence is missing');
      }
      const executions = await tx.query(`SELECT 1 FROM acd_sagas WHERE work_item_id=$1 AND state IN ('running','compensating')
        AND type NOT IN ('reservation_cleanup','target_cleanup','media_cleanup')`, [targetId]);
      const openLegs = await tx.query('SELECT 1 FROM acd_legs WHERE work_item_id=$1 AND ended_at IS NULL', [targetId]);
      if (executions.rowCount || openLegs.rowCount) fail('An execution or media leg still owns the work item');
      const reservations = (await tx.query("SELECT * FROM acd_reservations WHERE work_item_id=$1 AND state<>'released' FOR UPDATE", [targetId])).rows;
      for (const reservation of reservations) if (!(await agentMediaEvidence(tx, reservation)).ended) fail('Agent device end evidence is missing');
      for (const reservation of reservations) await releaseReservation(tx, reservation.id, 'operator_confirmed_end', { actor: `supervisor:${actorId}` });
      await closeOpenSegment(tx, targetId, { outcome: 'abandoned' });
      await applyTransition(tx, { workItemId: targetId, to: 'abandoned', eventType: 'work_item_abandoned',
        actor: `supervisor:${actorId}`, payload: { reason: 'operator_confirmed_customer_end', request_id: requestId },
        patch: { terminalReason: 'operator_confirmed_customer_end' } });
      result = { ...result, state: 'abandoned', providerEndVerified: true };
    }
    await tx.query(`INSERT INTO acd_operator_actions (request_id, actor_id, action, target_id, reason, result)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [requestId, actorId, action, targetId, reason.trim(), JSON.stringify(result)]);
    await appendEvent(tx, { type: "operator_action", actor: `supervisor:${actorId}`, payload: { ...result, request_id: requestId, reason: reason.trim() } });
    await tx.query(`SELECT pg_notify('acd_events', '{}')`);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    if (error.code === "23505") error.status = 409;
    throw error;
  } finally { tx.release(); }
}
