/**
 * WS5-T1 — Outbound attempt dial-state machine (Appendix C).
 *
 *   pending ─dial─▶ dialing ─▶ ringing
 *   ringing ─▶ human | machine | no_answer | busy | failed
 *   human ─reserveAgent─▶ connecting ─bridge─▶ connected ─hangup─▶ wrapup ─▶ disposed
 *   human ─(no agent within threshold)─▶ abandoned
 *   machine ─▶ voicemail_action ─▶ disposed
 *   no_answer | busy | failed ─▶ retry | exhausted
 *
 * The dial_state column is ADDITIVE: it does not replace the existing
 * outbound_attempt_ledger.status field that the live agentless runner uses.
 * status keeps its coarse lifecycle (claimed/dialing/answered/completed/...)
 * while dial_state carries the fine-grained Appendix C lifecycle that the
 * WS5-T3 Power pacer and WS6 predictive controller require.
 *
 * Transitions are validated against the allowed map and persisted with a
 * compare-and-swap guard (WHERE dial_state matches the expected source set),
 * making each Telnyx webhook map to exactly one applied transition even under
 * replay/concurrency (acceptance WS5-T1). Replays are additionally suppressed
 * upstream by WS4 webhook idempotency.
 */

import { outboundErrorPayload, runnerLogger } from "./logging.mjs";

export const DIAL_STATES = Object.freeze({
  PENDING: "pending",
  DIALING: "dialing",
  RINGING: "ringing",
  HUMAN: "human",
  MACHINE: "machine",
  NO_ANSWER: "no_answer",
  BUSY: "busy",
  FAILED: "failed",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  WRAPUP: "wrapup",
  DISPOSED: "disposed",
  ABANDONED: "abandoned",
  VOICEMAIL_ACTION: "voicemail_action",
  RETRY: "retry",
  EXHAUSTED: "exhausted",
});

/** Allowed transitions: target ← set of valid sources. */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [DIAL_STATES.DIALING]: [DIAL_STATES.PENDING, DIAL_STATES.RETRY],
  [DIAL_STATES.RINGING]: [DIAL_STATES.DIALING],
  // Detection outcomes can arrive without an observed ringing event
  // (fast answer, AMD races), so dialing is also a valid source.
  [DIAL_STATES.HUMAN]: [DIAL_STATES.RINGING, DIAL_STATES.DIALING, DIAL_STATES.MACHINE],
  [DIAL_STATES.MACHINE]: [DIAL_STATES.RINGING, DIAL_STATES.DIALING, DIAL_STATES.HUMAN],
  [DIAL_STATES.NO_ANSWER]: [DIAL_STATES.RINGING, DIAL_STATES.DIALING],
  [DIAL_STATES.BUSY]: [DIAL_STATES.RINGING, DIAL_STATES.DIALING],
  [DIAL_STATES.FAILED]: [
    DIAL_STATES.PENDING,
    DIAL_STATES.DIALING,
    DIAL_STATES.RINGING,
    DIAL_STATES.CONNECTING,
  ],
  [DIAL_STATES.CONNECTING]: [DIAL_STATES.HUMAN],
  [DIAL_STATES.CONNECTED]: [DIAL_STATES.CONNECTING],
  [DIAL_STATES.WRAPUP]: [DIAL_STATES.CONNECTED],
  [DIAL_STATES.DISPOSED]: [DIAL_STATES.WRAPUP, DIAL_STATES.VOICEMAIL_ACTION],
  [DIAL_STATES.ABANDONED]: [DIAL_STATES.HUMAN, DIAL_STATES.CONNECTING],
  [DIAL_STATES.VOICEMAIL_ACTION]: [DIAL_STATES.MACHINE],
  [DIAL_STATES.RETRY]: [
    DIAL_STATES.NO_ANSWER,
    DIAL_STATES.BUSY,
    DIAL_STATES.FAILED,
  ],
  [DIAL_STATES.EXHAUSTED]: [
    DIAL_STATES.NO_ANSWER,
    DIAL_STATES.BUSY,
    DIAL_STATES.FAILED,
  ],
});

export const TERMINAL_DIAL_STATES = Object.freeze(
  new Set([
    DIAL_STATES.DISPOSED,
    DIAL_STATES.ABANDONED,
    DIAL_STATES.EXHAUSTED,
  ]),
);

export function isValidTransition(fromState, toState) {
  const sources = ALLOWED_TRANSITIONS[toState];
  if (!sources) return false;
  return sources.includes(fromState || DIAL_STATES.PENDING);
}

/**
 * Atomically apply a dial-state transition with a compare-and-swap guard.
 * Returns the updated row when the transition applied, or
 * { applied: false, reason } when it was invalid/stale (replay-safe no-op).
 */
export async function transitionDialState(pool, ledgerId, toState, meta = {}) {
  if (!pool || !ledgerId) return { applied: false, reason: "missing_args" };
  const sources = ALLOWED_TRANSITIONS[toState];
  if (!sources) return { applied: false, reason: `unknown_target_state:${toState}` };

  const historyEntry = {
    to: toState,
    at: new Date().toISOString(),
    ...(meta.event ? { event: meta.event } : {}),
    ...(meta.reason ? { reason: meta.reason } : {}),
  };

  try {
    const { rows } = await pool.query(
      `UPDATE outbound_attempt_ledger
          SET dial_state = $1,
              metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object(
                     'dial_state_history',
                     COALESCE(metadata->'dial_state_history', '[]'::jsonb) || $2::jsonb
                   ),
              updated_at = NOW()
        WHERE id = $3
          AND COALESCE(dial_state, 'pending') = ANY($4::text[])
        RETURNING *`,
      [toState, JSON.stringify([historyEntry]), ledgerId, sources],
    );
    if (rows.length === 0) {
      return { applied: false, reason: "invalid_or_stale_source_state" };
    }
    return { applied: true, row: rows[0] };
  } catch (err) {
    runnerLogger.warn("outbound_dial_state_transition_failed", {
      ...outboundErrorPayload(err),
      ledgerId,
      toState,
    });
    return { applied: false, reason: "db_error" };
  }
}

/**
 * Map a Telnyx outbound webhook event (+ context) to a dial-state target.
 * Returns null when the event does not drive the dial-state machine.
 */
export function dialStateForWebhookEvent(eventType, ctx = {}) {
  switch (eventType) {
    case "call.initiated":
      return DIAL_STATES.DIALING;
    case "call.ringing":
      return DIAL_STATES.RINGING;
    case "call.answered":
      // Until AMD reports, an answered call is presumed human; AMD machine
      // detection (below) can still re-route human → machine.
      return DIAL_STATES.HUMAN;
    case "call.machine.detection.ended":
    case "call.machine.premium.detection.ended": {
      const result = String(ctx.amdResult || "").toLowerCase();
      if (result === "human" || result === "human_residence" || result === "human_business") {
        return DIAL_STATES.HUMAN;
      }
      if (result) return DIAL_STATES.MACHINE;
      return null;
    }
    case "call.machine.greeting.ended":
    case "call.machine.premium.greeting.ended":
      return DIAL_STATES.MACHINE;
    case "call.hangup": {
      const cause = String(ctx.hangupCause || "").toLowerCase();
      const sip = String(ctx.sipHangupCause || "");
      if (ctx.wasConnected) return DIAL_STATES.WRAPUP;
      if (cause === "user_busy" || sip === "486") return DIAL_STATES.BUSY;
      if (
        cause === "no_answer" ||
        cause === "timeout" ||
        cause === "originator_cancel" ||
        sip === "480" ||
        sip === "408" ||
        sip === "487"
      ) {
        return DIAL_STATES.NO_ANSWER;
      }
      if (cause === "call_rejected" || cause === "unallocated_number" || sip === "503") {
        return DIAL_STATES.FAILED;
      }
      // Normal clearing before connect (e.g. machine voicemail action done).
      return null;
    }
    default:
      return null;
  }
}

/**
 * Decide the post-failure path: retry (per retry policy) or exhausted.
 * Pure function; the caller persists the resulting transition.
 */
export function nextStateAfterFailure({ attemptCount, maxAttempts, retryEligible }) {
  if (!retryEligible) return DIAL_STATES.EXHAUSTED;
  const attempts = Number(attemptCount) || 0;
  const max = Number(maxAttempts) || 1;
  return attempts < max ? DIAL_STATES.RETRY : DIAL_STATES.EXHAUSTED;
}
