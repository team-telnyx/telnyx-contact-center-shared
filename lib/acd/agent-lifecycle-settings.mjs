export const DEFAULT_AGENT_LIFECYCLE_SETTINGS = Object.freeze({
  wrapup_timeout_seconds: 120,
  after_wrapup_status: "available",
  no_answer_status: "agent_not_answering",
  default_answer_timeout_seconds: 30,
  max_call_duration_seconds: 8 * 60 * 60,
});

const AFTER_WRAPUP_STATUSES = new Set(["available", "previous"]);
const NO_ANSWER_STATUSES = new Set(["agent_not_answering", "available"]);

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(maximum, Math.max(minimum, Math.round(number)))
    : fallback;
}

export function normalizeAgentLifecycleSettings(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return {
    wrapup_timeout_seconds: boundedInteger(
      source.wrapup_timeout_seconds,
      DEFAULT_AGENT_LIFECYCLE_SETTINGS.wrapup_timeout_seconds,
      15,
      3600,
    ),
    after_wrapup_status: AFTER_WRAPUP_STATUSES.has(source.after_wrapup_status)
      ? source.after_wrapup_status
      : DEFAULT_AGENT_LIFECYCLE_SETTINGS.after_wrapup_status,
    no_answer_status: NO_ANSWER_STATUSES.has(source.no_answer_status)
      ? source.no_answer_status
      : DEFAULT_AGENT_LIFECYCLE_SETTINGS.no_answer_status,
    default_answer_timeout_seconds: boundedInteger(
      source.default_answer_timeout_seconds,
      DEFAULT_AGENT_LIFECYCLE_SETTINGS.default_answer_timeout_seconds,
      5,
      120,
    ),
    max_call_duration_seconds: boundedInteger(
      source.max_call_duration_seconds,
      DEFAULT_AGENT_LIFECYCLE_SETTINGS.max_call_duration_seconds,
      60,
      12 * 60 * 60,
    ),
  };
}

export function agentLifecycleFromAppSettings(settings = {}) {
  const root = settings && typeof settings === "object" ? settings : {};
  return normalizeAgentLifecycleSettings(root.agent_lifecycle);
}

export async function loadAgentLifecycleSettings(db) {
  // ACD's isolated test/minimal schema intentionally omits the application
  // settings table. Check without aborting an existing transaction.
  const catalog = await db.query(
    `SELECT to_regclass('public.app_settings') AS settings_table`,
  );
  if (!catalog.rows[0]?.settings_table) return normalizeAgentLifecycleSettings();
  const result = await db.query(
    `SELECT cc_settings FROM app_settings WHERE id = 'default' LIMIT 1`,
  );
  return agentLifecycleFromAppSettings(result.rows[0]?.cc_settings);
}
