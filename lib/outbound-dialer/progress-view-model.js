function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isRetryEligibleAttempt(attempt = {}) {
  const metadata = attempt?.metadata && typeof attempt.metadata === "object" ? attempt.metadata : {};
  const value = metadata.retry_eligible ?? metadata.retryEligible;
  return value === true || String(value || "").toLowerCase() === "true";
}

function retryableContactCount(executionDebug = {}) {
  const attempts = Array.isArray(executionDebug?.recent_attempts) ? executionDebug.recent_attempts : [];
  const retryableContacts = new Set();
  let anonymousRetryable = 0;

  for (const attempt of attempts) {
    if (!isRetryEligibleAttempt(attempt)) continue;
    const contactId = attempt?.contact_record_id;
    if (contactId) retryableContacts.add(contactId);
    else anonymousRetryable += 1;
  }

  return retryableContacts.size + anonymousRetryable;
}

export function campaignContactProgress(campaign, contactLists = [], executionDebug = null) {
  const list = contactLists.find((item) => item.id === campaign?.contact_list_id);
  const metadata = campaign?.metadata || {};
  const summary = executionDebug?.summary || {};
  const total = numberOrZero(metadata.total_records ?? metadata.totalRecords ?? list?.record_count ?? list?.valid_phone_count ?? 0);
  const processedFromLedger = numberOrZero(summary.processed_records || 0);
  const completedFromLedger = numberOrZero(summary.completed_records || 0);
  const retryable = Math.min(total, retryableContactCount(executionDebug || {}));
  const terminalFromLedger = Math.max(processedFromLedger - retryable, completedFromLedger, 0);
  const completed = Math.min(total, terminalFromLedger || numberOrZero(metadata.completed_records ?? metadata.completedRecords ?? 0));
  const remaining = Math.max(total - completed, 0);
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
  return {
    total,
    completed,
    remaining,
    progress,
    retryable,
    source: processedFromLedger || completedFromLedger ? "execution ledger" : (total > 0 ? (metadata.total_records || metadata.totalRecords ? "campaign metadata" : "contact list records") : "no contact records yet"),
  };
}

export function campaignInventoryDisplayState(campaign = {}, contactLists = [], executionDebug = null) {
  const status = String(campaign?.status || "draft").toLowerCase();
  if (status !== "running") return status;

  const progress = campaignContactProgress(campaign, contactLists, executionDebug);
  const summary = executionDebug?.summary || {};
  const active = numberOrZero(summary.active_now || 0);
  const ringing = numberOrZero(summary.dialing_now || 0);
  const retryable = numberOrZero(progress.retryable || 0);
  if (progress.total > 0 && progress.remaining === 0 && retryable === 0 && active === 0 && ringing === 0) return "stopped";
  return status;
}
