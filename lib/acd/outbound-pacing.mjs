const DEFAULT_POWER_RATIO = 1;
const DEFAULT_ABANDON_TIMEOUT_SECS = 10;
const MAX_DIALS_PER_TICK = 10;
const DEFAULT_PREDICTIVE_MAX_RATIO = 3;
const DEFAULT_ABANDON_TARGET = 0.03;
const DEFAULT_MIN_ANSWER_RATE = 0.1;
const DEFAULT_MIN_SAMPLE_SIZE = 20;
const DEFAULT_STATS_WINDOW_MINUTES = 30;
const MIN_COMPLIANCE_DAMPING = 0.25;

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

export function computePowerDialBudget({ freeAgents, ratio, inFlight, maxLines }) {
  const agents = Math.max(0, Math.floor(Number(freeAgents) || 0));
  const pacingRatio = numberOr(ratio, DEFAULT_POWER_RATIO);
  const dialing = Math.max(0, Math.floor(Number(inFlight) || 0));
  const cap = numberOr(maxLines, Infinity);
  const target = Math.ceil(pacingRatio * agents);
  const budget = Math.max(0, target - dialing);
  const remaining = Math.max(0, (Number.isFinite(cap) ? cap : Infinity) - dialing);
  return Math.min(budget, remaining, MAX_DIALS_PER_TICK);
}

export function powerPacingConfig(campaign = {}) {
  const pacing = parseObject(campaign.pacing_config);
  return {
    ratio: numberOr(pacing.ratio, DEFAULT_POWER_RATIO),
    abandonTimeoutSecs: numberOr(
      pacing.abandonTimeoutSecs ?? pacing.abandon_timeout_secs,
      DEFAULT_ABANDON_TIMEOUT_SECS,
    ),
  };
}

export function predictivePacingConfig(campaign = {}) {
  const pacing = parseObject(campaign.pacing_config);
  const blending =
    parseObject(campaign.metadata)?.blending_config || pacing.blending || {};
  const reservePercent = Number(
    blending.inboundReservePercent ?? blending.inbound_reserve_percent ?? 0,
  );
  return {
    baseRatio: numberOr(pacing.ratio, DEFAULT_POWER_RATIO),
    maxRatio: numberOr(
      pacing.maxRatio ?? pacing.max_ratio,
      DEFAULT_PREDICTIVE_MAX_RATIO,
    ),
    abandonTarget: clamp01(
      numberOr(
        pacing.abandonTarget ?? pacing.abandon_target,
        DEFAULT_ABANDON_TARGET,
      ),
    ),
    minSampleSize: Math.max(
      1,
      Math.floor(
        numberOr(
          pacing.minSampleSize ?? pacing.min_sample_size,
          DEFAULT_MIN_SAMPLE_SIZE,
        ),
      ),
    ),
    statsWindowMinutes: numberOr(
      pacing.statsWindowMinutes ?? pacing.stats_window_minutes,
      DEFAULT_STATS_WINDOW_MINUTES,
    ),
    abandonTimeoutSecs: numberOr(
      pacing.abandonTimeoutSecs ?? pacing.abandon_timeout_secs,
      DEFAULT_ABANDON_TIMEOUT_SECS,
    ),
    inboundReservePercent: clamp01(reservePercent / 100),
  };
}

export function computePredictiveRatio({
  answerRate,
  abandonRate,
  sampleSize,
  baseRatio = DEFAULT_POWER_RATIO,
  maxRatio = DEFAULT_PREDICTIVE_MAX_RATIO,
  abandonTarget = DEFAULT_ABANDON_TARGET,
  minSampleSize = DEFAULT_MIN_SAMPLE_SIZE,
  minAnswerRate = DEFAULT_MIN_ANSWER_RATE,
} = {}) {
  const base = numberOr(baseRatio, DEFAULT_POWER_RATIO);
  const cap = Math.max(1, numberOr(maxRatio, DEFAULT_PREDICTIVE_MAX_RATIO));
  const samples = Math.max(0, Math.floor(Number(sampleSize) || 0));
  if (samples < Math.max(1, Math.floor(Number(minSampleSize) || DEFAULT_MIN_SAMPLE_SIZE))) {
    return Math.min(base, cap);
  }
  const answer = Math.max(
    clamp01(answerRate),
    clamp01(minAnswerRate) || DEFAULT_MIN_ANSWER_RATE,
  );
  const capped = Math.min(base / answer, cap);
  const abandonment = clamp01(abandonRate);
  const target = clamp01(abandonTarget) || DEFAULT_ABANDON_TARGET;
  const damping =
    abandonment <= target
      ? 1
      : Math.max(MIN_COMPLIANCE_DAMPING, target / abandonment);
  return Math.max(MIN_COMPLIANCE_DAMPING, capped * damping);
}

export function computeBlendedFreeAgents({
  freeAgents,
  queuedInbound = 0,
  inboundReservePercent = 0,
} = {}) {
  const agents = Math.max(0, Math.floor(Number(freeAgents) || 0));
  const queued = Math.max(0, Math.floor(Number(queuedInbound) || 0));
  const reserve = Math.min(
    agents,
    queued + Math.ceil(clamp01(inboundReservePercent) * agents),
  );
  return Math.max(0, agents - reserve);
}
