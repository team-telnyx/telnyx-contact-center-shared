import { applySagaEvent } from './saga-engine.mjs';
import { bindOutboundCustomer } from './sagas/outbound-connect.mjs';
import { notifyOutboundLiveCallsChanged } from '../outbound-dialer/live-calls-events.mjs';
import { liveCallsLogger, outboundErrorPayload } from '../outbound-dialer/logging.mjs';

export function outboundEnvelope(payload = {}) {
  let state = {};
  try { state = JSON.parse(Buffer.from(payload.client_state || '', 'base64').toString('utf8')); } catch { /* not our envelope */ }
  return state && typeof state === 'object' ? state : {};
}

// Correlate against an actual journaled origination; an arbitrary SIP header
// cannot attach itself to a work item or acknowledge a different command.
export async function applyOutboundVoiceEvent(pool, provider, event, { node = 'outbound-inbox' } = {}) {
  const p = event.payload || {};
  if (!p.call_control_id || event.eventType === 'call.enqueued') return null;
  const state = outboundEnvelope(p);
  const tx = await pool.connect();
  let saga, leg;
  try {
    await tx.query('BEGIN');
    const found = await tx.query(`SELECT s.* FROM acd_sagas s JOIN acd_work_items w ON w.id = s.work_item_id
      WHERE s.type = 'outbound_connect' AND (
        EXISTS (SELECT 1 FROM acd_legs l WHERE l.work_item_id = w.id AND l.role = 'customer' AND l.provider_call_id = $1)
        OR (w.id::text = $2 AND w.outbound_attempt_id = $3 AND $4 = 'customer')
      ) ORDER BY s.created_at DESC LIMIT 1 FOR UPDATE OF s`, [p.call_control_id, state.acdWorkItemId || null, state.attemptId || null, state.acdRole || null]);
    saga = found.rows[0];
    if (!saga) { await tx.query('COMMIT'); return null; }
    const existing = (await tx.query(`SELECT * FROM acd_legs WHERE work_item_id = $1 AND role = 'customer'`, [saga.work_item_id])).rows[0];
    if (existing && existing.provider_call_id !== p.call_control_id) { await tx.query('COMMIT'); return null; }
    if (!existing) {
      const journal = await tx.query(`SELECT 1 FROM acd_commands WHERE saga_id = $1 AND operation = 'outbound_dial' AND status IN ('planned', 'sent', 'accepted', 'ambiguous', 'confirmed')`, [saga.id]);
      if (!journal.rowCount || p.direction !== 'outgoing' || p.to !== saga.data.dialPayload?.to) { await tx.query('COMMIT'); return null; }
      await bindOutboundCustomer(tx, saga, p);
    }
    const ended = event.eventType === 'call.hangup';
    const answered = ['call.answered', 'call.bridged'].includes(event.eventType);
    leg = (await tx.query(`UPDATE acd_legs SET
      state = CASE WHEN ended_at IS NOT NULL OR $2 THEN 'ended' WHEN $5 THEN 'bridged' WHEN $3 AND state <> 'bridged' THEN 'answered' ELSE state END,
      ended_at = CASE WHEN $2 THEN COALESCE(ended_at, now()) ELSE ended_at END,
      ended_reason = CASE WHEN $2 THEN COALESCE(ended_reason, $4) ELSE ended_reason END,
      answered_at = CASE WHEN $3 AND ended_at IS NULL THEN COALESCE(answered_at, now()) ELSE answered_at END,
      bridged_at = CASE WHEN $5 AND ended_at IS NULL THEN COALESCE(bridged_at,now()) ELSE bridged_at END,
      bridged_peer_call_id = CASE WHEN $5 AND ended_at IS NULL THEN $6 ELSE bridged_peer_call_id END,
      bridged_event_id = CASE WHEN $5 AND ended_at IS NULL THEN $7 ELSE bridged_event_id END
      WHERE provider_call_id = $1 RETURNING *`, [p.call_control_id, ended, answered, p.hangup_cause || 'normal_clearing', event.eventType === 'call.bridged',p.bridged_call_control_id||null,event.eventId])).rows[0];
    // Standard AMD may finish greeting analysis with `not_sure` when it does
    // not find a reliable beep or silence boundary before the configured
    // greeting deadline. Telnyx still emits this as greeting-ended evidence;
    // once the same call is already classified as a machine, a configured
    // voicemail action must continue instead of waiting for a second event
    // that will never arrive.
    const greeting = ['call.machine.greeting.ended','call.machine.premium.greeting.ended'].includes(event.eventType)
      && ['beep_detected','ended','not_sure'].includes(p.result);
    if (greeting) await tx.query(`UPDATE acd_work_items SET attributes = attributes || '{"outbound_greeting_ended":true}'::jsonb
      || CASE WHEN NOT attributes ? 'outbound_amd_result' THEN '{"outbound_amd_result":"machine"}'::jsonb ELSE '{}'::jsonb END WHERE id = $1`, [saga.work_item_id]);
    const amd = ['call.machine.detection.ended', 'call.machine.premium.detection.ended'].includes(event.eventType);
    await tx.query(`UPDATE acd_work_items SET attributes = attributes || jsonb_build_object('outbound_last_event_id', $2::text)
      || CASE WHEN $3 AND NOT attributes ? 'outbound_amd_result' THEN jsonb_build_object('outbound_amd_result', $4::text) ELSE '{}'::jsonb END
      || CASE WHEN $3 AND NOT attributes ? 'outbound_amd_detected_at'
        THEN jsonb_build_object('outbound_amd_detected_at', COALESCE($5::timestamptz, now())::text) ELSE '{}'::jsonb END
      WHERE id = $1`,
      [saga.work_item_id, event.eventId, amd, p.result || 'unknown', event.occurredAt || null]);
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
  let name = { 'call.initiated': 'leg.initiated', 'call.answered': 'leg.answered', 'call.bridged': 'leg.bridged', 'call.hangup': 'leg.ended',
    'call.machine.detection.ended': 'outbound.amd', 'call.machine.premium.detection.ended': 'outbound.amd',
    'call.speak.started': 'outbound.speak_started', 'call.speak.ended': 'outbound.speak_ended',
    'call.machine.greeting.ended': 'outbound.greeting', 'call.machine.premium.greeting.ended': 'outbound.greeting' }[event.eventType];
  if (leg.ended_at && event.eventType !== 'call.hangup') name = null;
  if (name) await applySagaEvent(pool, { workItemId: saga.work_item_id, name, role: 'customer',
    payload: { event_id: event.eventId, provider_call_id: p.call_control_id }, provider, node, actor: 'provider' });
  const work = (await pool.query(`SELECT state, attributes FROM acd_work_items WHERE id = $1`, [saga.work_item_id])).rows[0];
  const attributes = work.attributes;
  await notifyOutboundLiveCallsChanged(pool, {
    event_type: event.eventType,
    call_control_id: p.call_control_id,
    work_item_id: saga.work_item_id,
  }).catch((error) => liveCallsLogger.warn('live_calls_wakeup_failed', {
    ...outboundErrorPayload(error),
    eventType: event.eventType,
    callControlId: p.call_control_id,
  }));
  const flow = saga.data.mode === 'agentless_flow';
  // Only an admitted, still-active Flow may execute adapter continuations.
  // Gather/Speak events must retain their type after the initial synthesized
  // answer; otherwise the verified adapter acknowledges them without routing
  // the next node. Duplicate answers and terminal calls must not restart it.
  const activeFlow = flow && work.state === 'active' && !leg.ended_at
    && Boolean(attributes.outbound_flow_start_event_id);
  const startsFlow = activeFlow && attributes.outbound_flow_start_event_id === event.eventId;
  const continuesFlow = activeFlow && event.eventType !== 'call.answered';
  return { handled: true, outcome: 'applied', outboundCore: true,
    skipAdapterEffects: (!flow && Boolean(name)) || (event.eventType === 'call.answered' && !startsFlow),
    adapterEventType: startsFlow ? 'call.answered' : continuesFlow ? event.eventType : null };
}
