// Browser-safe classification of provider outcomes for messaging campaigns.
// Every outcome maps to a message state, an optional retry delay and whether
// the whole campaign must pause (a sender-level problem no retry can fix).
// Telnyx SMS error codes: https://support.telnyx.com/en/articles/6505121-telnyx-messaging-error-codes
const SMS_CODES = {
  throttled: ["40011", "40318"],
  failed_transient: ["40014", "40016", "40018", "40002"],
  opted_out: ["40300"],
  undeliverable: ["40001", "40012", "40004", "40008", "40009", "40019"],
  sender_problem: ["40010", "40305", "40040", "40015", "40017", "40150", "40329", "40303"],
};

const WHATSAPP_CODES = {
  throttled: ["130429", "131056", "80007"],
  frequency_capped: ["131049"],
  failed_transient: ["131000", "131016", "131057"],
  undeliverable: ["131026", "131047", "131053"],
  opted_out: ["131050"],
  sender_problem: ["131031", "131037", "131042", "131045", "132000", "132001", "132012", "132015", "132016", "40008"],
};

const EMAIL_CODES = {
  throttled: ["10011", "429"],
  sender_problem: ["reputation_suspended", "10015"],
};

const CODE_MAPS = { sms: SMS_CODES, whatsapp: WHATSAPP_CODES, email: EMAIL_CODES };

export const OUTCOME_STATES = Object.freeze({
  throttled: "throttled", frequency_capped: "failed_transient", failed_transient: "failed_transient", opted_out: "failed_permanent",
  undeliverable: "undeliverable", sender_problem: "failed_permanent", failed_permanent: "failed_permanent", unconfirmed: "unconfirmed",
});

function codeCategory(channel, code) {
  const map = CODE_MAPS[channel] || {};
  const value = String(code || "").trim();
  if (!value) return null;
  for (const [category, codes] of Object.entries(map)) if (codes.includes(value)) return category;
  return null;
}

/**
 * `sent` is true once the provider accepted the message. A failure reported
 * after that point describes a message the customer may already have received,
 * so it never pauses the campaign for throttling and never schedules a resend:
 * the retry fields are stripped rather than left for the claim query to act on.
 */
export function classifyMessagingOutcome(channel, options = {}, settings = {}) {
  const classified = classifyProviderOutcome(channel, options, settings);
  if (!options?.sent) return classified;
  const { retry_minutes: _retryMinutes, retry_eligible: _retryEligible, throttled: _throttled, ...delivered } = classified;
  return { ...delivered, retry_minutes: null };
}

function classifyProviderOutcome(channel, { outcome = "failed", httpStatus = null, code = null, sent = false } = {}, settings = {}) {
  const attempts = settings?.attempts || {};
  const category = codeCategory(channel, code) || (httpStatus === 429 && !sent ? "throttled" : null);
  const base = { reason_code: category || (outcome === "ambiguous" ? "provider_uncertain" : "provider_rejected"), provider_code: code ? String(code) : null, pause_campaign: false, retry_minutes: null };
  if (category === "throttled") return { ...base, state: "throttled", retry_minutes: attempts.throttled_retry_minutes || 5, throttled: true };
  if (category === "frequency_capped") return { ...base, state: "failed_transient", retry_minutes: (attempts.frequency_cap_retry_hours || 24) * 60, retry_eligible: true };
  if (category === "failed_transient") return { ...base, state: "failed_transient", retry_minutes: attempts.transient_retry_minutes || 30, retry_eligible: true };
  if (category === "opted_out") return { ...base, state: "failed_permanent", reason_code: "opted_out", opted_out: true };
  if (category === "undeliverable") return { ...base, state: "undeliverable", reason_code: "undeliverable" };
  if (category === "sender_problem") return { ...base, state: "failed_permanent", reason_code: "sender_problem", pause_campaign: true };
  if (outcome === "ambiguous" && !sent) {
    // No idempotency key on the messaging API: a lost response is never resent.
    if ([401, 403].includes(httpStatus)) return { ...base, state: "failed_permanent", reason_code: "sender_problem", pause_campaign: true };
    return { ...base, state: "unconfirmed", reason_code: "provider_uncertain" };
  }
  if ([401, 403].includes(httpStatus)) return { ...base, state: "failed_permanent", reason_code: "sender_problem", pause_campaign: true };
  return { ...base, state: "failed_permanent" };
}

// Provider delivery statuses (webhooks / message resource) → message state.
const DELIVERY_STATES = {
  queued: "accepted", accepted: "accepted", sending: "accepted", sent: "sent", delivered: "delivered", read: "read",
  delivery_unconfirmed: "unconfirmed", sending_failed: "failed", delivery_failed: "failed", failed: "failed", undeliverable: "failed", rejected: "failed", finalized: "sent",
  // Email vocabulary: a deferred message is still in flight; a bounce, an
  // expiry, a gateway rejection or a suppression is a delivery failure.
  deferred: "accepted", bounced: "failed", expired: "failed", suppressed: "failed", gw_reject: "failed", injection_timeout: "failed",
};
const RANK = { queued: 0, rendered: 0, pending: 0, sending: 1, accepted: 1, sent: 2, delivered: 3, read: 4, replied: 5 };

export function deliveryStateFor(channel, { status, code = null } = {}, settings = {}) {
  const mapped = DELIVERY_STATES[String(status || "").toLowerCase()] || null;
  if (!mapped) return null;
  if (mapped !== "failed") return { state: mapped, reason_code: null, retry_minutes: null };
  const classified = classifyMessagingOutcome(channel, { outcome: "failed", code, sent: true }, settings);
  return { ...classified, state: classified.state === "throttled" ? "failed_transient" : classified.state, retry_minutes: null };
}

// Late or duplicated evidence must never move a message backwards.
export function deliveryAdvances(currentState, nextState) {
  if (!nextState) return false;
  if (["replied", "failed_permanent", "undeliverable", "unconfirmed", "suppressed", "skipped", "cancelled", "throttled", "failed_transient"].includes(currentState)) return false;
  if (!(nextState in RANK)) return true;
  return (RANK[nextState] ?? 0) > (RANK[currentState] ?? 0);
}
