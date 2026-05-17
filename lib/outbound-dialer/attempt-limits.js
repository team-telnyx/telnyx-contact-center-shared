export const DEFAULT_GLOBAL_MAX_ATTEMPTS = 5;
export const MAX_GLOBAL_MAX_ATTEMPTS = 100;

function toInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeGlobalMaxAttempts(value, fallback = DEFAULT_GLOBAL_MAX_ATTEMPTS) {
  const parsed = toInteger(value, fallback);
  if (parsed <= 0) return fallback;
  return Math.max(1, Math.min(MAX_GLOBAL_MAX_ATTEMPTS, parsed));
}

export function normalizeAttemptCount(value, fallback = 0, globalMaxAttempts = DEFAULT_GLOBAL_MAX_ATTEMPTS) {
  const max = normalizeGlobalMaxAttempts(globalMaxAttempts);
  const parsed = toInteger(value, fallback);
  return Math.max(0, Math.min(max, parsed));
}

export function normalizeDelayMinutes(value, fallback = 0) {
  return Math.max(0, Math.min(525600, toInteger(value, fallback)));
}

export function normalizeAttemptRules(rules = [], globalMaxAttempts = DEFAULT_GLOBAL_MAX_ATTEMPTS) {
  return (Array.isArray(rules) ? rules : []).map((rule = {}) => ({
    outcome: String(rule.outcome || "busy"),
    attempts: normalizeAttemptCount(rule.attempts, 1, globalMaxAttempts),
    minutes_between_attempts: normalizeDelayMinutes(
      rule.minutes_between_attempts ?? rule.minutesBetweenAttempts,
      30,
    ),
  }));
}

export function normalizePhoneTypeRules(groups = [], globalMaxAttempts = DEFAULT_GLOBAL_MAX_ATTEMPTS) {
  return (Array.isArray(groups) ? groups : []).map((group = {}) => ({
    phone_type: String(group.phone_type || group.phoneType || "mobile"),
    rules: normalizeAttemptRules(group.rules, globalMaxAttempts),
  }));
}

export function normalizeAttemptControlLimits(control = {}, globalMaxAttempts = DEFAULT_GLOBAL_MAX_ATTEMPTS) {
  const max = normalizeGlobalMaxAttempts(globalMaxAttempts);
  return {
    ...control,
    max_attempts_per_contact: normalizeAttemptCount(
      control.max_attempts_per_contact ?? control.maxAttemptsPerContact,
      4,
      max,
    ),
    max_attempts_per_number: normalizeAttemptCount(
      control.max_attempts_per_number ?? control.maxAttemptsPerNumber,
      2,
      max,
    ),
    recall_rules: normalizeAttemptRules(control.recall_rules ?? control.recallRules, max),
    phone_type_rules: normalizePhoneTypeRules(control.phone_type_rules ?? control.phoneTypeRules, max),
  };
}
