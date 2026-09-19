export const DEFAULT_CONSULT_HOLD_SETTINGS = Object.freeze({
  media_name: null,
  announcement_enabled: true,
  announcement_text:
    "Please stay on the line while we connect your call.",
  announcement_voice: "AWS.Polly.Joanna",
  announcement_language: "en-US",
  announcement_voice_api_key_ref: null,
  announcement_interval_seconds: 60,
});

export const DEFAULT_AGENT_HOLD_SETTINGS = Object.freeze({
  media_name: null,
  announcement_enabled: false,
  announcement_text: "Please stay on the line. Your call is on hold.",
  announcement_voice: "AWS.Polly.Joanna",
  announcement_language: "en-US",
  announcement_voice_api_key_ref: null,
  announcement_interval_seconds: 60,
});

const clean = (value) => String(value || "").trim();

function normalizeHoldSettings(value = {}, defaults) {
  const source = value && typeof value === "object" ? value : {};
  const seconds = Number(source.announcement_interval_seconds);
  const text =
    clean(source.announcement_text).slice(0, 3000) ||
    defaults.announcement_text;
  const voice =
    clean(source.announcement_voice) ||
    defaults.announcement_voice;
  return {
    media_name: clean(source.media_name) || null,
    announcement_enabled:
      typeof source.announcement_enabled === "boolean"
        ? source.announcement_enabled
        : defaults.announcement_enabled,
    announcement_text: text,
    announcement_voice: voice,
    announcement_language:
      clean(source.announcement_language) ||
      defaults.announcement_language,
    announcement_voice_api_key_ref:
      clean(source.announcement_voice_api_key_ref) || null,
    announcement_interval_seconds: Number.isFinite(seconds)
      ? Math.min(300, Math.max(10, Math.round(seconds)))
      : defaults.announcement_interval_seconds,
  };
}

export function normalizeConsultHoldSettings(value = {}) {
  return normalizeHoldSettings(value, DEFAULT_CONSULT_HOLD_SETTINGS);
}

export function normalizeAgentHoldSettings(value = {}) {
  return normalizeHoldSettings(value, DEFAULT_AGENT_HOLD_SETTINGS);
}

export function consultHoldFromAppSettings(settings = {}) {
  const root = settings && typeof settings === "object" ? settings : {};
  return normalizeConsultHoldSettings(root.consult_hold);
}

export function agentHoldFromAppSettings(settings = {}) {
  const root = settings && typeof settings === "object" ? settings : {};
  return normalizeAgentHoldSettings(root.agent_hold);
}

export async function loadConsultHoldSettings(db) {
  const result = await db.query(
    `SELECT cc_settings FROM app_settings WHERE id = 'default' LIMIT 1`,
  );
  return consultHoldFromAppSettings(result.rows[0]?.cc_settings);
}

export async function loadAgentHoldSettings(db) {
  const result = await db.query(
    `SELECT cc_settings FROM app_settings WHERE id = 'default' LIMIT 1`,
  );
  return agentHoldFromAppSettings(result.rows[0]?.cc_settings);
}
