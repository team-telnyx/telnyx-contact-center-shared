const numberValue = (value) => Number(value || 0) || 0;
const percent = (part, total) => total > 0 ? `${Math.round((part / total) * 100)}%` : "0%";
const formatNumber = (value) => numberValue(value).toLocaleString();

export function buildDashboardCampaignTrafficStats({ progress = {}, live = {}, summary = {}, maxLines = 0 } = {}) {
  const totalContacts = numberValue(progress.total);
  const processedContacts = numberValue(progress.completed);
  const callableContacts = numberValue(progress.remaining);
  const attempts = numberValue(summary.attempts_total ?? summary.attemptsTotal ?? summary.total_attempts ?? summary.totalAttempts ?? summary.attempts_last_15m);
  const connected = numberValue(summary.answered_total ?? summary.answeredTotal ?? live.answered);
  const activeLines = numberValue(summary.active_now ?? summary.activeNow ?? live.active);
  const configuredLines = numberValue(maxLines);

  return [
    { label: "Contacts", value: `${formatNumber(processedContacts)} / ${formatNumber(totalContacts)}`, tone: "blue", icon: "database" },
    { label: "Attempts", value: formatNumber(attempts), tone: "emerald", icon: "check" },
    { label: "Callable", value: percent(callableContacts, totalContacts), tone: "amber", icon: "clock" },
    { label: "Connected", value: percent(connected, attempts), tone: "violet", icon: "shield" },
    { label: "Lines", value: `${formatNumber(activeLines)} / ${configuredLines ? formatNumber(configuredLines) : "—"}`, tone: "sky", icon: "phone" },
  ];
}
