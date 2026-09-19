export const DEFAULT_ANSWERED_WITHOUT_AGENT_POLICY = Object.freeze({
  mode: "announce_and_hangup",
  max_agent_connect_seconds: 2,
  announcement_start_deadline_ms: 500,
  max_announcement_seconds: 8,
  max_abandon_rate_percent: 3,
  abandon_rate_window_hours: 24,
  retry_suppression_hours: 72,
  announcement_message:
    "We're sorry, but no agent is currently available to take your call. We will not keep you waiting. Goodbye.",
  announcement_voice: "Telnyx.Ultra.00967b2f-88a6-4a31-8153-110a92134b9f",
  announcement_language: "en-US",
});

const MODES = new Set(["announce_and_hangup", "immediate_hangup"]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  const result = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, result));
}

function integer(value, fallback, min, max) {
  return Math.round(number(value, fallback, min, max));
}

function first(source, ...keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  return undefined;
}

export function normalizeGlobalAnsweredWithoutAgentPolicy(settings = {}) {
  const root = object(settings);
  const raw = object(
    root.answered_without_agent_policy || root.answeredWithoutAgentPolicy,
  );
  const defaults = DEFAULT_ANSWERED_WITHOUT_AGENT_POLICY;
  const modeValue = String(first(raw, "mode") || defaults.mode);
  return {
    mode: MODES.has(modeValue) ? modeValue : defaults.mode,
    max_agent_connect_seconds: number(
      first(raw, "max_agent_connect_seconds", "maxAgentConnectSeconds") ??
        first(root, "compliance_abandon_threshold_seconds", "complianceAbandonThresholdSeconds"),
      defaults.max_agent_connect_seconds,
      0.1,
      30,
    ),
    announcement_start_deadline_ms: integer(
      first(raw, "announcement_start_deadline_ms", "announcementStartDeadlineMs"),
      defaults.announcement_start_deadline_ms,
      100,
      5000,
    ),
    max_announcement_seconds: number(
      first(raw, "max_announcement_seconds", "maxAnnouncementSeconds"),
      defaults.max_announcement_seconds,
      1,
      30,
    ),
    max_abandon_rate_percent: number(
      first(raw, "max_abandon_rate_percent", "maxAbandonRatePercent"),
      defaults.max_abandon_rate_percent,
      0,
      100,
    ),
    abandon_rate_window_hours: number(
      first(raw, "abandon_rate_window_hours", "abandonRateWindowHours"),
      defaults.abandon_rate_window_hours,
      1,
      168,
    ),
    retry_suppression_hours: number(
      first(raw, "retry_suppression_hours", "retrySuppressionHours"),
      defaults.retry_suppression_hours,
      0,
      8760,
    ),
    announcement_message: String(
      first(raw, "announcement_message", "announcementMessage") || defaults.announcement_message,
    ).trim().slice(0, 1000) || defaults.announcement_message,
    announcement_voice: String(
      first(raw, "announcement_voice", "announcementVoice") || defaults.announcement_voice,
    ).trim().slice(0, 200) || defaults.announcement_voice,
    announcement_language: String(
      first(raw, "announcement_language", "announcementLanguage") || defaults.announcement_language,
    ).trim().slice(0, 20) || defaults.announcement_language,
  };
}

export function campaignAnsweredWithoutAgentOverride(pacingConfig = {}) {
  const pacing = object(pacingConfig);
  const raw = object(
    pacing.answered_without_agent_policy || pacing.answeredWithoutAgentPolicy,
  );
  const override = {};
  const connect = first(raw, "max_agent_connect_seconds", "maxAgentConnectSeconds");
  const rate = first(raw, "max_abandon_rate_percent", "maxAbandonRatePercent");
  const suppression = first(raw, "retry_suppression_hours", "retrySuppressionHours");
  if (connect !== undefined) override.max_agent_connect_seconds = number(connect, 2, 0.1, 30);
  if (rate !== undefined) override.max_abandon_rate_percent = number(rate, 3, 0, 100);
  if (suppression !== undefined) override.retry_suppression_hours = number(suppression, 72, 0, 8760);
  return override;
}

export function validateCampaignAnsweredWithoutAgentPolicy(pacingConfig, globalSettings) {
  const global = normalizeGlobalAnsweredWithoutAgentPolicy(globalSettings);
  const local = campaignAnsweredWithoutAgentOverride(pacingConfig);
  const violations = [];
  if (local.max_agent_connect_seconds > global.max_agent_connect_seconds) {
    violations.push(`agent bridge deadline must be at most ${global.max_agent_connect_seconds} seconds`);
  }
  if (local.max_abandon_rate_percent > global.max_abandon_rate_percent) {
    violations.push(`maximum abandonment rate must be at most ${global.max_abandon_rate_percent}%`);
  }
  if (local.retry_suppression_hours < global.retry_suppression_hours) {
    violations.push(`retry suppression must be at least ${global.retry_suppression_hours} hours`);
  }
  if (violations.length) {
    throw Object.assign(
      new Error(`Campaign answered-without-agent policy is weaker than global settings: ${violations.join("; ")}`),
      { status: 400, code: "OUTBOUND_POLICY_WEAKER_THAN_GLOBAL", violations },
    );
  }
  return local;
}

export function resolveAnsweredWithoutAgentPolicy(globalSettings, campaign = {}) {
  const global = normalizeGlobalAnsweredWithoutAgentPolicy(globalSettings);
  const pacing = object(campaign.pacing_config || campaign.pacingConfig);
  const local = campaignAnsweredWithoutAgentOverride(pacing);
  // Historical abandonTimeoutSecs values remain readable, but they can only
  // tighten the global deadline. A stale, weaker value can never win.
  const legacy = first(pacing, "abandonTimeoutSecs", "abandon_timeout_secs");
  const legacyConnect = legacy === undefined ? null : number(legacy, global.max_agent_connect_seconds, 0.1, 30);
  return {
    ...global,
    max_agent_connect_seconds: Math.min(
      global.max_agent_connect_seconds,
      local.max_agent_connect_seconds ?? global.max_agent_connect_seconds,
      legacyConnect ?? global.max_agent_connect_seconds,
    ),
    max_abandon_rate_percent: Math.min(
      global.max_abandon_rate_percent,
      local.max_abandon_rate_percent ?? global.max_abandon_rate_percent,
    ),
    retry_suppression_hours: Math.max(
      global.retry_suppression_hours,
      local.retry_suppression_hours ?? global.retry_suppression_hours,
    ),
  };
}

export function normalizedCampaignPacingConfig(pacingConfig, globalSettings) {
  const pacing = { ...object(pacingConfig) };
  const local = validateCampaignAnsweredWithoutAgentPolicy(pacing, globalSettings);
  const hadPolicy = Boolean(pacing.answered_without_agent_policy || pacing.answeredWithoutAgentPolicy);
  delete pacing.answeredWithoutAgentPolicy;
  if (hadPolicy || Object.keys(local).length) pacing.answered_without_agent_policy = local;
  return pacing;
}

export async function loadEffectiveAnsweredWithoutAgentPolicy(tx, campaign) {
  const row = (
    await tx.query("SELECT settings FROM outbound_settings WHERE id='default' LIMIT 1")
  ).rows[0];
  return resolveAnsweredWithoutAgentPolicy(row?.settings || {}, campaign);
}

export async function answeredWithoutAgentGuard(tx, campaign) {
  const policy = await loadEffectiveAnsweredWithoutAgentPolicy(tx, campaign);
  const stats = (
    await tx.query(
      `SELECT
         COUNT(*) FILTER (WHERE metadata ? 'human_answered_at')::int AS human_answers,
         COUNT(*) FILTER (WHERE metadata ? 'abandoned_at')::int AS abandons
       FROM outbound_attempt_ledger
       WHERE campaign_id=$1
         AND created_at > now() - ($2::text || ' hours')::interval`,
      [campaign.id, String(policy.abandon_rate_window_hours)],
    )
  ).rows[0] || { human_answers: 0, abandons: 0 };
  const humanAnswers = Number(stats.human_answers || 0);
  const abandons = Number(stats.abandons || 0);
  const ratePercent = humanAnswers ? (abandons / humanAnswers) * 100 : 0;
  return {
    blocked: humanAnswers > 0 && ratePercent > policy.max_abandon_rate_percent,
    humanAnswers,
    abandons,
    ratePercent,
    policy,
  };
}
