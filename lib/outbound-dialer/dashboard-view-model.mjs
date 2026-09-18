const numberValue = (value) => Number(value || 0) || 0;
const percent = (part, total) => total > 0 ? `${Math.round((part / total) * 100)}%` : "0%";
const formatNumber = (value) => numberValue(value).toLocaleString();

export const DASHBOARD_CAMPAIGN_STATUSES = ["running", "paused", "stopped", "ready", "recycled", "completed", "exhausted"];
export const DEFAULT_DASHBOARD_CAMPAIGN_STATUSES = ["running", "paused"];

export function restoreDashboardCampaignStatuses(serialized) {
  try {
    const saved = JSON.parse(serialized);
    if (Array.isArray(saved)) {
      const statuses = DASHBOARD_CAMPAIGN_STATUSES.filter((status) => saved.includes(status));
      if (statuses.length || saved.length === 0) return statuses;
    }
  } catch {
    // Invalid or unavailable browser storage falls back to the default view.
  }
  return [...DEFAULT_DASHBOARD_CAMPAIGN_STATUSES];
}

const MESSAGING_CHANNELS = ["sms", "whatsapp", "email"];

// Messaging campaigns show delivery outcomes instead of line and call tiles.
function buildMessagingCampaignExpandedStats({ progress = {}, summary = {} } = {}) {
  const totalContacts = numberValue(progress.total);
  const processedContacts = numberValue(progress.completed);
  const sent = numberValue(summary.messages_sent);
  const delivered = numberValue(summary.messages_delivered);
  const replied = numberValue(summary.messages_replied);
  const queued = numberValue(summary.messages_queued) + numberValue(summary.messages_in_flight);
  return {
    contactStats: [
      { label: "Contacts", value: `${formatNumber(processedContacts)} / ${formatNumber(totalContacts)}`, tone: "blue", icon: "database" },
      { label: "Sent", value: formatNumber(sent), tone: "emerald", icon: "check" },
      { label: "Delivered", value: percent(delivered, sent), tone: "violet", icon: "shield" },
      { label: "Replied", value: formatNumber(replied), tone: "sky", icon: "activity" },
      { label: "Callable", value: percent(numberValue(progress.remaining), totalContacts), tone: "amber", icon: "clock" },
    ],
    callProcessingStats: [
      { label: "Queued", value: formatNumber(queued), tone: "blue", icon: "clock" },
      { label: "Delivered", value: formatNumber(delivered), tone: "emerald", icon: "check" },
      { label: "Failed", value: formatNumber(summary.messages_failed), tone: "amber", icon: "x" },
      { label: "Unconfirmed", value: formatNumber(summary.messages_unconfirmed), tone: "violet", icon: "shield" },
      { label: "Suppressed", value: formatNumber(summary.suppressed_total), tone: "rose", icon: "x" },
    ],
  };
}

export function buildDashboardCampaignExpandedStats({ progress = {}, live = {}, summary = {}, maxLines = 0, channel = "voice" } = {}) {
  if (MESSAGING_CHANNELS.includes(String(channel || "").toLowerCase())) return buildMessagingCampaignExpandedStats({ progress, summary });
  const totalContacts = numberValue(progress.total);
  const processedContacts = numberValue(progress.completed);
  const callableContacts = numberValue(progress.remaining);
  const attempts = numberValue(summary.attempts_total ?? summary.attemptsTotal ?? summary.total_attempts ?? summary.totalAttempts ?? summary.attempts_last_15m);
  const connectedContacts = numberValue(summary.connected_records ?? summary.connectedRecords ?? summary.answered_records ?? summary.answeredRecords);
  const activeCalls = numberValue(summary.active_now ?? summary.activeNow ?? live.active);
  const ringingCalls = numberValue(summary.dialing_now ?? summary.dialingNow ?? live.ringing);
  const answeredCalls = numberValue(summary.answered_total ?? summary.answeredTotal ?? summary.connected_total ?? summary.connectedTotal ?? live.answered);
  const failedCalls = numberValue(summary.calls_failed_total ?? summary.callsFailedTotal ?? summary.failed_total ?? summary.failedTotal ?? live.failed);
  const machineCalls = numberValue(summary.machine_total ?? summary.machineTotal ?? live.machine);
  const configuredLines = numberValue(maxLines);
  const displayedActiveCalls = configuredLines > 0 ? Math.min(activeCalls, configuredLines) : activeCalls;

  return {
    contactStats: [
      { label: "Contacts", value: `${formatNumber(processedContacts)} / ${formatNumber(totalContacts)}`, tone: "blue", icon: "database" },
      { label: "Attempts", value: formatNumber(attempts), tone: "emerald", icon: "check" },
      { label: "Callable", value: percent(callableContacts, totalContacts), tone: "amber", icon: "clock" },
      { label: "Connected", value: percent(connectedContacts, totalContacts), tone: "violet", icon: "shield" },
      { label: "Lines", value: `${formatNumber(displayedActiveCalls)} / ${configuredLines ? formatNumber(configuredLines) : "—"}`, tone: "sky", icon: "phone" },
    ],
    callProcessingStats: [
      { label: "Active", value: formatNumber(activeCalls), tone: "blue", icon: "activity" },
      { label: "Ringing", value: formatNumber(ringingCalls), tone: "violet", icon: "phone" },
      { label: "Answered", value: formatNumber(answeredCalls), tone: "emerald", icon: "check" },
      { label: "Failed", value: formatNumber(failedCalls), tone: "amber", icon: "x" },
      { label: "Machine", value: formatNumber(machineCalls), tone: "rose", icon: "shield" },
    ],
  };
}

export function buildDashboardCampaignTrafficStats(args = {}) {
  return buildDashboardCampaignExpandedStats(args).contactStats;
}
