export const ACD_RETENTION_LAYERS = Object.freeze({
  EVENTS: "acd_events",
  OUTBOX: "acd_outbox",
  STREAM: "acd_stream_events",
});

function sequence(value, name) {
  try {
    const parsed = BigInt(value ?? 0);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`${name} must be a non-negative sequence`);
  }
}

export function planAcdStreamRead({
  after = 0,
  minimumRetained = 0,
  current = 0,
  forceSnapshot = false,
} = {}) {
  const cursor = sequence(after, "after");
  const minimum = sequence(minimumRetained, "minimumRetained");
  const latest = sequence(current, "current");
  if (minimum > latest + 1n) {
    throw new RangeError("minimumRetained cannot be ahead of the stream");
  }
  const cursorExpired = minimum > 0n && cursor + 1n < minimum;
  const cursorAhead = cursor > latest;
  if (forceSnapshot || cursorExpired || cursorAhead) {
    return {
      mode: "snapshot",
      reason: cursorExpired
        ? "cursor_expired"
        : cursorAhead
          ? "cursor_reset"
          : "snapshot_requested",
      readAfter: latest.toString(),
      cursor: latest.toString(),
    };
  }
  return {
    mode: "incremental",
    reason: "cursor_valid",
    readAfter: cursor.toString(),
    cursor: cursor.toString(),
  };
}

function timestamp(value, name) {
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a timestamp`);
  return parsed;
}

/**
 * Decide whether one outbox row may be removed. Materialization is mandatory;
 * age alone can never make an unresolved or active-work event disposable.
 */
export function canPruneAcdOutbox({
  createdAt,
  now = new Date(),
  safetyAgeMs,
  materializedStreamSequence = null,
  inboxResolved = true,
  activeWorkEvidence = false,
  requiredUntil = null,
} = {}) {
  if (materializedStreamSequence == null) {
    return { allowed: false, reason: "not_materialized" };
  }
  sequence(materializedStreamSequence, "materializedStreamSequence");
  if (!inboxResolved) return { allowed: false, reason: "unresolved_inbox" };
  if (activeWorkEvidence) return { allowed: false, reason: "active_work_evidence" };
  const age = timestamp(now, "now") - timestamp(createdAt, "createdAt");
  if (!Number.isFinite(safetyAgeMs) || safetyAgeMs < 0) {
    throw new TypeError("safetyAgeMs must be a non-negative number");
  }
  if (age < safetyAgeMs) return { allowed: false, reason: "safety_age" };
  if (requiredUntil && timestamp(now, "now") < timestamp(requiredUntil, "requiredUntil")) {
    return { allowed: false, reason: "history_window" };
  }
  return { allowed: true, reason: "materialized_and_safe" };
}

export function canPruneAcdStreamEvent({
  sequence: eventSequence,
  retainedMinimum,
  protectsUnresolvedEvidence = false,
} = {}) {
  const event = sequence(eventSequence, "sequence");
  const minimum = sequence(retainedMinimum, "retainedMinimum");
  if (protectsUnresolvedEvidence) {
    return { allowed: false, reason: "unresolved_evidence" };
  }
  return event < minimum
    ? { allowed: true, reason: "outside_replay_window" }
    : { allowed: false, reason: "inside_replay_window" };
}
