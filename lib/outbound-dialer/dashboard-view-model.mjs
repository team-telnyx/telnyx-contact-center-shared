const numberValue = (value) => Number(value || 0) || 0;
const percent = (part, total) => total > 0 ? `${Math.round((part / total) * 100)}%` : "0%";
const formatNumber = (value) => numberValue(value).toLocaleString();

export function buildDashboardCampaignExpandedStats({ progress = {}, live = {}, summary = {}, maxLines = 0 } = {}) {
  const totalContacts = numberValue(progress.total);
  const processedContacts = numberValue(progress.completed);
  const callableContacts = numberValue(progress.remaining);
  const attempts = numberValue(summary.attempts_total ?? summary.attemptsTotal ?? summary.total_attempts ?? summary.totalAttempts ?? summary.attempts_last_15m);
  const connectedContacts = numberValue(summary.connected_records ?? summary.connectedRecords ?? summary.answered_records ?? summary.answeredRecords);
  const activeCalls = numberValue(summary.active_now ?? summary.activeNow ?? live.active);
  const ringingCalls = numberValue(summary.dialing_now ?? summary.dialingNow ?? live.ringing);
  const answeredCalls = numberValue(summary.connected_total ?? summary.connectedTotal ?? summary.answered_total ?? summary.answeredTotal ?? live.answered);
  const failedCalls = numberValue(summary.calls_failed_total ?? summary.callsFailedTotal ?? summary.failed_total ?? summary.failedTotal ?? live.failed);
  const machineCalls = numberValue(summary.machine_total ?? summary.machineTotal ?? live.machine);
  const configuredLines = numberValue(maxLines);

  return {
    contactStats: [
      { label: "Contacts", value: `${formatNumber(processedContacts)} / ${formatNumber(totalContacts)}`, tone: "blue", icon: "database" },
      { label: "Attempts", value: formatNumber(attempts), tone: "emerald", icon: "check" },
      { label: "Callable", value: percent(callableContacts, totalContacts), tone: "amber", icon: "clock" },
      { label: "Connected", value: percent(connectedContacts, totalContacts), tone: "violet", icon: "shield" },
      { label: "Lines", value: `${formatNumber(activeCalls)} / ${configuredLines ? formatNumber(configuredLines) : "—"}`, tone: "sky", icon: "phone" },
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
