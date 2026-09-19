function timestampMs(value) {
  if (!value) return null;
  const valueMs = new Date(value).getTime();
  return Number.isFinite(valueMs) ? valueMs : null;
}

function secondsBetween(start, end) {
  const startMs = timestampMs(start);
  const endMs = timestampMs(end);
  if (startMs == null || endMs == null) return null;
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}

/**
 * Resolve the customer-facing duration of one interaction.
 *
 * Core-owned calls use the durable customer leg/work-item boundaries, which
 * remain unchanged while agent and queue segments are replaced by transfers.
 * Transfers replace queue and agent segments while the work item's stable
 * created_at timestamp remains the beginning of the complete customer journey.
 */
export function resolveInteractionDurationSeconds(interaction = {}) {
  const terminalAt =
    interaction.customer_ended_at ||
    interaction.completed_at ||
    interaction.abandoned_at ||
    null;

  const coreDuration = secondsBetween(
    interaction.customer_started_at,
    terminalAt,
  );
  if (coreDuration != null) return coreDuration;

  if (Number(interaction.transfer_count || 0) > 0) {
    const transferredDuration = secondsBetween(
      interaction.created_at,
      terminalAt,
    );
    if (transferredDuration != null) return transferredDuration;
  }

  const handleTimeSeconds = Number(interaction.handle_time_seconds);
  if (Number.isFinite(handleTimeSeconds) && handleTimeSeconds > 0) {
    return Math.floor(handleTimeSeconds);
  }

  const startedAt =
    interaction.answered_at ||
    interaction.assigned_at ||
    interaction.enqueued_at ||
    interaction.created_at ||
    null;
  return secondsBetween(startedAt, terminalAt);
}
