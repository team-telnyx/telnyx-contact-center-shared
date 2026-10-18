import { voiceEndpointOptions } from './endpoint-options.mjs';
import { sourceText } from '../i18n/source-text.mjs';

/**
 * What the "Move call" dialog shows, read from the Contact Center's device-handoff
 * answer (readDeviceHandoff in lib/acd/device-handoff.mjs) and
 * from the call in this browser. A pure mapping, the same as the iOS app's
 * DeviceHandoffPhase, so every state the dialog draws is one a test names.
 *
 * The Contact Center keeps a move as a saga: `state` is `running` (or
 * `compensating`) while it moves, then `succeeded` or `cancelled`; `step`
 * walks dial_target, await_answer, bridge_target, verify_bridge and
 * hangup_source, or back through restore_source, verify_restore and
 * cleanup_target when it gives up. The last saga stays in the answer after it
 * ends, so an outcome is shown only for a move this dialog watched.
 */

/** A running move's steps, in order: the stepper and the journey draw them. */
export const HANDOFF_STEPS = ['dialing', 'ringing', 'switching', 'returning'];

/** The Contact Center's last_error for a move someone cancelled. */
export const CANCELLED_ERROR = 'Handoff cancelled.';
/** The Contact Center's presentation of a move whose target never connected or whose call ended while it rang. */
export const NO_ANSWER_ERROR = 'Handoff did not complete. The target did not connect in time or the call ended.';
/** The demo portal's wording of the same outcome, still accepted. */
const NO_ANSWER_ERRORS = [NO_ANSWER_ERROR, 'The target did not connect or the call ended.'];

const stepIndex = step => HANDOFF_STEPS.indexOf(step);
const live = handoff => ['running', 'compensating'].includes(handoff?.state);
const text = value => (typeof value === 'string' && value.trim() ? value : null);

/** The saga's `step`, as the dialog names it. */
export function sagaStep(step) {
  switch (step) {
  case 'dial_target': return 'dialing';
  case 'await_answer': return 'ringing';
  case 'bridge_target': case 'verify_bridge': case 'hangup_source': case 'done': return 'switching';
  default: return 'returning';
  }
}

/**
 * The dialog's state.
 *
 * - value: the Contact Center's last answer, null before the first one.
 * - loading: the first read is on the wire.
 * - readError: why the first read failed, when there is no answer to show.
 * - localCall: this browser's call that belongs to the handoff: none,
 *   ringing, active or ended.
 * - watchedHandoffId: a move this dialog saw running or started; only its
 *   outcome is shown.
 * - tUi(source, values): the translator for the dialog's own words; English without one.
 */
export function resolveHandoffPhase({ value, loading = false, readError = null, localCall = 'none', watchedHandoffId = null, tUi = sourceText } = {}) {
  if (!value) {
    return loading ? { kind: 'loading' } : { kind: 'unavailable', reason: readError || tUi('Could not read where the call is.') };
  }
  const handoff = value.handoff;
  if (live(handoff)) return running(handoff, localCall, tUi);
  if (handoff?.id && watchedHandoffId && String(handoff.id).toLowerCase() === String(watchedHandoffId).toLowerCase()) {
    const ending = outcome(handoff, tUi);
    if (ending) return ending;
  }
  return idle(value, tUi);
}

/** A move in progress, nudged on by what this browser already knows: the Contact Center confirms the media switch only after provider evidence. */
function running(handoff, localCall, tUi) {
  const isTarget = Boolean(handoff.isTarget);
  let step = handoff.state === 'compensating' ? 'returning' : sagaStep(handoff.step);
  if (isTarget && localCall === 'active' && stepIndex(step) < stepIndex('switching')) step = 'switching';
  if (!isTarget && localCall === 'ended' && (handoff.ownershipCommitted || handoff.step === 'hangup_source')) {
    return { kind: 'succeeded', progress: progress(handoff, 'switching', tUi) };
  }
  // The leg ringing here is the browser's own evidence: it is answerable even while the Contact Center still says it is dialing.
  if (isTarget && localCall === 'ringing' && stepIndex(step) <= stepIndex('ringing')) return { kind: 'incoming', progress: progress(handoff, 'ringing', tUi) };
  return { kind: 'moving', progress: progress(handoff, step, tUi) };
}

/** How a watched move ended, if it has. */
function outcome(handoff, tUi) {
  if (handoff.state === 'succeeded' || handoff.completed) return { kind: 'succeeded', progress: progress(handoff, 'switching', tUi) };
  if (handoff.state !== 'cancelled') return null;
  const error = text(handoff.error);
  if (!error || error === CANCELLED_ERROR) return { kind: 'cancelled' };
  if (NO_ANSWER_ERRORS.includes(error)) return { kind: 'timedOut', targetLabel: targetLabel(handoff, tUi) };
  return { kind: 'failed', reason: error };
}

/** Nothing moving: what can be done from here. */
function idle(value, tUi) {
  if (value.canTakeOver) return { kind: 'takeOver', ownerLabel: text(value.ownerLabel) || tUi('another device') };
  const options = handoffTargets(value);
  if (options.length > 1) return { kind: 'chooseTarget', options };
  if (options.length === 1) return { kind: 'ready', option: options[0] };
  return { kind: 'unavailable',
    reason: text(value.unavailableReason) || tUi('To move this call, open it on the other device and choose Take over here.') };
}

function progress(handoff, step, tUi) {
  return { step, handoffId: String(handoff.id || ''), sourceId: handoff.sourceId || null, targetId: handoff.targetId || null,
    targetLabel: targetLabel(handoff, tUi), isTarget: Boolean(handoff.isTarget),
    canCancel: Boolean(handoff.canCancel) && stepIndex(step) <= stepIndex('ringing'), warning: text(handoff.error) };
}

const targetLabel = (handoff, tUi = sourceText) => text(handoff.targetLabel) || tUi('the other device');

/** The devices a call on this device can move to, one per device, while `canStart`. */
export function handoffTargets(value) {
  if (!value?.canStart || live(value.handoff)) return [];
  return voiceEndpointOptions({ endpoints: value.targets || [] }, null);
}

/** A move that is running: the dialog remembers its id so the outcome can be shown when it ends. */
export function runningHandoffId(phase) {
  return ['moving', 'incoming'].includes(phase?.kind) && phase.progress.handoffId ? phase.progress.handoffId : null;
}

/** An ending the dialog shows before it closes (success) or offers a retry (the rest). */
export const isHandoffOutcome = phase => ['succeeded', 'failed', 'cancelled', 'timedOut'].includes(phase?.kind);

/**
 * This browser's call as the handoff sees it: the target leg the Contact Center rang
 * here carries the saga id (X-CC-Saga-Id); otherwise the call the dialog was
 * opened for, whose end confirms a move away.
 *
 * - call: { id, status, direction, sagaId } from the active call store, or null.
 * - handoffId: the saga the Contact Center reports.
 * - sourceCallId: the call in this browser the dialog was opened for.
 */
export function browserHandoffCall({ call, handoffId = null, sourceCallId = null }) {
  if (call?.sagaId && handoffId && String(call.sagaId).toLowerCase() === String(handoffId).toLowerCase()) return callState(call);
  if (!sourceCallId) return 'none';
  return call && call.id === sourceCallId ? callState(call) : 'ended';
}

/** This browser has no call in progress (taking over needs it free). */
export const browserCallIsOver = call => !call || ['idle', 'ended', 'hangup', 'destroy', 'terminated', 'purge'].includes(call.status || 'idle');

function callState(call) {
  if (browserCallIsOver(call)) return 'ended';
  const status = call.status;
  if (status === 'ringing' && ['inbound', 'incoming'].includes(call.direction)) return 'ringing';
  return ['active', 'connected', 'answered', 'held', 'early'].includes(status) ? 'active' : 'none';
}

/** The saga id the Contact Center put on a target leg it rang here (X-CC-Saga-Id), from the SDK call. */
export function callSagaId(call, recoveredHeaders = null) {
  // The SDK keeps inbound headers in more than one place (as the mini phone reads them).
  const headers = [call?.options?.customHeaders, call?.inviteCustomHeaders, call?.invite?.customHeaders, call?.customHeaders, recoveredHeaders]
    .filter(Array.isArray).flat();
  return headers.find(header => String(header?.name).toLowerCase() === 'x-cc-saga-id')?.value || null;
}
