import { getPostgresPool } from "../postgres.mjs";

const VALID_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);
const VALID_ROTATION_MODES = new Set(["daily", "startup"]);
const CACHE_TTL_MS = 5000;

export const DEFAULT_TOPIC_LEVELS = Object.freeze({
  app: "info",
  admin: "info",
  api: "info",
  auth: "info",
  db: "warn",
  "telnyx": "info",
  "telnyx.webhook": "info",
  "telnyx.streaming": "info",
  "telnyx.stt": "info",
  "telnyx.stt.media": "warn",
  "telnyx.call-control": "info",
  "agent-assist": "info",
  "voice-flow": "info",
  webrtc: "info",
  monitor: "info",
  "outbound-dialer": "info",
  scheduler: "info",
});

export const DEFAULT_TOPIC_ENABLED = Object.freeze(
  Object.fromEntries(Object.keys(DEFAULT_TOPIC_LEVELS).map((topic) => [topic, true])),
);

export const DEFAULT_LOGGING_CONFIG = Object.freeze({
  enabled: true,
  globalLevel: "info",
  consoleEnabled: true,
  consolePretty: false,
  fileEnabled: false,
  logDir: "/app/logs",
  rotationMode: "daily",
  retentionDays: 14,
  topicLevels: DEFAULT_TOPIC_LEVELS,
  topicEnabled: DEFAULT_TOPIC_ENABLED,
  redactionEnabled: true,
  expiresAt: null,
  updatedAt: null,
  updatedBy: null,
});

let cachedConfig = null;
let cachedAtMs = 0;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeLevel(value, fallback = "info") {
  const level = String(value || "").toLowerCase();
  return VALID_LEVELS.has(level) ? level : fallback;
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeRetentionDays(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 365 ? parsed : DEFAULT_LOGGING_CONFIG.retentionDays;
}

function normalizeRotationMode(value) {
  const mode = String(value || "").toLowerCase();
  return VALID_ROTATION_MODES.has(mode) ? mode : DEFAULT_LOGGING_CONFIG.rotationMode;
}

function normalizeTopicLevels(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = { ...DEFAULT_TOPIC_LEVELS };
  for (const [topic, level] of Object.entries(source)) {
    if (typeof topic !== "string" || topic.length > 120) continue;
    const normalized = normalizeLevel(level, null);
    if (normalized) result[topic] = normalized;
  }
  return result;
}

function normalizeTopicEnabled(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = { ...DEFAULT_TOPIC_ENABLED };
  for (const [topic, enabled] of Object.entries(source)) {
    if (typeof topic !== "string" || topic.length > 120) continue;
    if (typeof enabled === "boolean") result[topic] = enabled;
  }
  return result;
}

function normalizeLogDir(value) {
  const text = String(value || "").trim();
  if (!text) return DEFAULT_LOGGING_CONFIG.logDir;
  if (text.includes("\0") || text.length > 512) return DEFAULT_LOGGING_CONFIG.logDir;
  return text;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function normalizeRuntimeLoggingConfig(input = {}, { now = new Date() } = {}) {
  const config = {
    ...cloneJson(DEFAULT_LOGGING_CONFIG),
    enabled: normalizeBoolean(input.enabled, DEFAULT_LOGGING_CONFIG.enabled),
    globalLevel: normalizeLevel(input.globalLevel ?? input.global_level, DEFAULT_LOGGING_CONFIG.globalLevel),
    consoleEnabled: normalizeBoolean(input.consoleEnabled ?? input.console_enabled, DEFAULT_LOGGING_CONFIG.consoleEnabled),
    consolePretty: normalizeBoolean(input.consolePretty ?? input.console_pretty, DEFAULT_LOGGING_CONFIG.consolePretty),
    fileEnabled: normalizeBoolean(input.fileEnabled ?? input.file_enabled, DEFAULT_LOGGING_CONFIG.fileEnabled),
    logDir: normalizeLogDir(input.logDir ?? input.log_dir),
    rotationMode: normalizeRotationMode(input.rotationMode ?? input.rotation_mode),
    retentionDays: normalizeRetentionDays(input.retentionDays ?? input.retention_days),
    topicLevels: normalizeTopicLevels(input.topicLevels ?? input.topic_levels),
    topicEnabled: normalizeTopicEnabled(input.topicEnabled ?? input.topic_enabled),
    redactionEnabled: true,
    expiresAt: toIsoOrNull(input.expiresAt ?? input.expires_at),
    updatedAt: toIsoOrNull(input.updatedAt ?? input.updated_at),
    updatedBy: input.updatedBy ?? input.updated_by ?? null,
  };

  if (config.expiresAt && new Date(config.expiresAt).getTime() <= now.getTime()) {
    return cloneJson(DEFAULT_LOGGING_CONFIG);
  }

  return config;
}

export function resetRuntimeLoggingConfigCache() {
  cachedConfig = null;
  cachedAtMs = 0;
}

export function getCachedRuntimeLoggingConfig({ now = new Date() } = {}) {
  if (!cachedConfig) return null;
  const config = normalizeRuntimeLoggingConfig(cachedConfig, { now });
  if (config.expiresAt !== cachedConfig.expiresAt) {
    cachedConfig = config;
    cachedAtMs = now.getTime();
  }
  return cloneJson(config);
}

export function setCachedRuntimeLoggingConfig(config, { now = new Date() } = {}) {
  cachedConfig = normalizeRuntimeLoggingConfig(config, { now });
  cachedAtMs = now.getTime();
  return cloneJson(cachedConfig);
}

async function withClient(pool, fn) {
  if (!pool) throw new Error("Database connection failed");
  if (typeof pool.connect === "function") {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release?.();
    }
  }
  return fn(pool);
}

export async function ensureLoggingConfigSchema(pool = getPostgresPool()) {
  await withClient(pool, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_logging_config (
        id text PRIMARY KEY DEFAULT 'default',
        enabled boolean NOT NULL DEFAULT true,
        global_level text NOT NULL DEFAULT 'info',
        console_enabled boolean NOT NULL DEFAULT true,
        console_pretty boolean NOT NULL DEFAULT false,
        file_enabled boolean NOT NULL DEFAULT false,
        log_dir text NOT NULL DEFAULT '/app/logs',
        rotation_mode text NOT NULL DEFAULT 'daily',
        retention_days integer NOT NULL DEFAULT 14,
        topic_levels jsonb NOT NULL DEFAULT '{}'::jsonb,
        topic_enabled jsonb NOT NULL DEFAULT '{}'::jsonb,
        redaction_enabled boolean NOT NULL DEFAULT true,
        expires_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_logging_config_audit (
        id bigserial PRIMARY KEY,
        changed_by text,
        previous_config jsonb,
        next_config jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });
}

export async function getRuntimeLoggingConfig({ pool = getPostgresPool(), forceRefresh = false, now = new Date() } = {}) {
  const nowMs = now.getTime();
  if (!forceRefresh && cachedConfig && nowMs - cachedAtMs < CACHE_TTL_MS) return cloneJson(cachedConfig);

  await ensureLoggingConfigSchema(pool);
  const row = await withClient(pool, async (client) => {
    const result = await client.query("SELECT * FROM app_logging_config WHERE id = 'default' LIMIT 1");
    return result.rows?.[0] || null;
  });
  const config = normalizeRuntimeLoggingConfig(row || {}, { now });
  cachedConfig = config;
  cachedAtMs = nowMs;
  return cloneJson(config);
}

function toDbParams(config, updatedBy, now) {
  return [
    "default",
    config.enabled,
    config.globalLevel,
    config.consoleEnabled,
    config.consolePretty,
    config.fileEnabled,
    config.logDir,
    config.rotationMode,
    config.retentionDays,
    JSON.stringify(config.topicLevels),
    JSON.stringify(config.topicEnabled),
    config.redactionEnabled,
    config.expiresAt,
    updatedBy || "system",
    now,
  ];
}

export async function saveRuntimeLoggingConfig({ pool = getPostgresPool(), config = {}, updatedBy = "system", now = new Date() } = {}) {
  await ensureLoggingConfigSchema(pool);
  const previous = await getRuntimeLoggingConfig({ pool, forceRefresh: true, now });
  const normalized = normalizeRuntimeLoggingConfig({ ...previous, ...config, updatedBy, updatedAt: now.toISOString() }, { now });
  await withClient(pool, async (client) => {
    await client.query(
      `INSERT INTO app_logging_config (
        id, enabled, global_level, console_enabled, console_pretty, file_enabled, log_dir,
        rotation_mode, retention_days, topic_levels, topic_enabled, redaction_enabled,
        expires_at, updated_by, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        global_level = EXCLUDED.global_level,
        console_enabled = EXCLUDED.console_enabled,
        console_pretty = EXCLUDED.console_pretty,
        file_enabled = EXCLUDED.file_enabled,
        log_dir = EXCLUDED.log_dir,
        rotation_mode = EXCLUDED.rotation_mode,
        retention_days = EXCLUDED.retention_days,
        topic_levels = EXCLUDED.topic_levels,
        topic_enabled = EXCLUDED.topic_enabled,
        redaction_enabled = EXCLUDED.redaction_enabled,
        expires_at = EXCLUDED.expires_at,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at`,
      toDbParams(normalized, updatedBy, now),
    );
    await client.query(
      `INSERT INTO app_logging_config_audit (changed_by, previous_config, next_config, created_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
      [updatedBy || "system", JSON.stringify(previous), JSON.stringify(normalized), now],
    );
  });
  setCachedRuntimeLoggingConfig(normalized, { now });
  return cloneJson(normalized);
}

function addMinutes(now, minutes) {
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

export function buildLoggingPresetConfig(preset, { ttlMinutes = null, now = new Date() } = {}) {
  const ttl = Number.parseInt(String(ttlMinutes ?? ""), 10);
  const expiresAt = Number.isFinite(ttl) && ttl > 0 ? addMinutes(now, ttl) : null;
  if (preset === "debug-telnyx-stt") {
    return {
      ...cloneJson(DEFAULT_LOGGING_CONFIG),
      globalLevel: "debug",
      fileEnabled: true,
      topicLevels: {
        ...DEFAULT_TOPIC_LEVELS,
        "telnyx.stt": "trace",
        "telnyx.stt.media": "debug",
        "telnyx.streaming": "debug",
        "agent-assist": "debug",
      },
      topicEnabled: {
        ...DEFAULT_TOPIC_ENABLED,
        "telnyx.stt": true,
        "telnyx.stt.media": true,
        "telnyx.streaming": true,
        "agent-assist": true,
      },
      expiresAt,
    };
  }
  if (preset === "errors-only") {
    return {
      ...cloneJson(DEFAULT_LOGGING_CONFIG),
      globalLevel: "error",
      topicLevels: Object.fromEntries(Object.keys(DEFAULT_TOPIC_LEVELS).map((topic) => [topic, "error"])),
      expiresAt,
    };
  }
  if (preset === "normal-production") {
    return cloneJson(DEFAULT_LOGGING_CONFIG);
  }
  throw new Error(`Unknown logging preset: ${preset}`);
}

export async function applyLoggingPreset({ pool = getPostgresPool(), preset, ttlMinutes = null, updatedBy = "system", now = new Date() } = {}) {
  const config = buildLoggingPresetConfig(preset, { ttlMinutes, now });
  return saveRuntimeLoggingConfig({ pool, config, updatedBy, now });
}
