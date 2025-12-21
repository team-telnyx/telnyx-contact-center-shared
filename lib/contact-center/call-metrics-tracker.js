/**
 * Call Metrics Tracker
 * Tracks hold times, transfer history, and other call metrics
 */

// In-memory store for hold start times
// Key: call_control_id, Value: timestamp
const holdStartTimes = new Map();

/**
 * Record when a call is put on hold
 */
export function recordHoldStart(callControlId) {
  if (callControlId) {
    holdStartTimes.set(callControlId, Date.now());
    console.log(`[CallMetrics] 📞 Hold started for call: ${callControlId}`);
  }
}

/**
 * Calculate hold duration and clear the hold start time
 * @returns {number} Hold duration in seconds, or 0 if no hold was recorded
 */
export function recordHoldEnd(callControlId) {
  if (!callControlId) return 0;

  const startTime = holdStartTimes.get(callControlId);
  if (!startTime) {
    console.warn(
      `[CallMetrics] ⚠️ Hold end recorded but no start time found for: ${callControlId}`
    );
    return 0;
  }

  const duration = Math.floor((Date.now() - startTime) / 1000);
  holdStartTimes.delete(callControlId);
  console.log(
    `[CallMetrics] 📞 Hold ended for call: ${callControlId}, duration: ${duration}s`
  );
  return duration;
}

/**
 * Get current hold duration without clearing (for active holds)
 */
export function getCurrentHoldDuration(callControlId) {
  if (!callControlId) return 0;
  const startTime = holdStartTimes.get(callControlId);
  if (!startTime) return 0;
  return Math.floor((Date.now() - startTime) / 1000);
}

/**
 * Clear hold tracking (e.g., when call ends)
 */
export function clearHoldTracking(callControlId) {
  if (callControlId) {
    holdStartTimes.delete(callControlId);
  }
}

/**
 * Calculate talk time from answered_at to completed_at (or now if still active)
 */
export function calculateTalkTime(answeredAt, completedAt = null) {
  if (!answeredAt) return 0;
  const answered = new Date(answeredAt).getTime();
  const completed = completedAt ? new Date(completedAt).getTime() : Date.now();
  return Math.floor((completed - answered) / 1000);
}

/**
 * Create a transfer history entry
 */
export function createTransferEntry({
  timestamp,
  fromAgent,
  toAgent,
  toQueue,
  toNumber,
  transferType = "agent", // 'agent', 'queue', 'number'
  callControlId,
}) {
  return {
    timestamp: timestamp || new Date().toISOString(),
    from_agent: fromAgent || null,
    to_agent: toAgent || null,
    to_queue: toQueue || null,
    to_number: toNumber || null,
    transfer_type: transferType,
    call_control_id: callControlId || null,
  };
}
