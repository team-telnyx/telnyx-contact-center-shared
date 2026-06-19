import { Pool } from "pg";
import { readPostgresSslConfig } from "../postgres-ssl.mjs";
import { getPostgresPool } from "../postgres.mjs";
import {
  canonicalTopicFor,
  defaultTopicEnabledFromCatalog,
  defaultTopicLevelsFromCatalog,
} from "./topic-catalog.mjs";

const VALID_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);
const VALID_ROTATION_MODES = new Set(["daily", "startup"]);
const VALID_ARCHIVE_PROVIDERS = new Set(["s3"]);
const CACHE_TTL_MS = 5000;

function safeEnvSegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function accountIdFromEnv() {
  return String(process.env.LOG_ARCHIVE_ACCOUNT_ID || process.env.AWS_ACCOUNT_ID || process.env.AWS_ACCOUNT || "")
    .trim()
    .replace(/[^0-9]/g, "");
}

export function managedArchiveBucketName({ env = process.env.DEPLOY_GROUP || process.env.APP_ENV || process.env.NODE_ENV, accountId = accountIdFromEnv() } = {}) {
  const cleanEnv = safeEnvSegment(env);
  const cleanAccount = String(accountId || "").trim().replace(/[^0-9]/g, "");
  if (!cleanEnv || !cleanAccount) return "";
  return `${cleanEnv}-logs-${cleanAccount}`;
}

function defaultLogDir() {
  if (process.env.LOG_DIR || process.env.LOG_FILE_DIR) return process.env.LOG_DIR || process.env.LOG_FILE_DIR;
  return process.env.NODE_ENV === "production" ? "/app/logs" : `${process.cwd()}/logs`;
}

export const DEFAULT_TOPIC_LEVELS = defaultTopicLevelsFromCatalog();

export const DEFAULT_TOPIC_ENABLED = defaultTopicEnabledFromCatalog();

export const DEFAULT_LOGGING_CONFIG = Object.freeze({
  enabled: true,
  globalLevel: "info",
  consoleEnabled: true,
  consolePretty: false,
  consoleFriendly: false,
  fileEnabled: true,
  logDir: defaultLogDir(),
  rotationMode: "daily",
  retentionDays: 14,
  liveEnabled: false,
  liveTtlMinutes: 15,
  archiveEnabled: false,
  archiveProvider: "s3",
  archiveBucket: "",
  archivePrefix: "logs",
  spoolEnabled: false,
  spoolDir: process.env.LOG_SPOOL_DIR || "/app/log-spool",
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

function readEnvBoolean(name) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = String(raw).toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

function normalizeRetentionDays(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 365 ? parsed : DEFAULT_LOGGING_CONFIG.retentionDays;
}

function normalizeRotationMode(value) {
  const mode = String(value || "").toLowerCase();
  return VALID_ROTATION_MODES.has(mode) ? mode : DEFAULT_LOGGING_CONFIG.rotationMode;
}

function normalizeLiveTtlMinutes(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LOGGING_CONFIG.liveTtlMinutes;
  return Math.max(5, Math.min(30, parsed));
}

function normalizeArchiveProvider(value) {
  const provider = String(value || "").toLowerCase();
  return VALID_ARCHIVE_PROVIDERS.has(provider) ? provider : DEFAULT_LOGGING_CONFIG.archiveProvider;
}

function normalizeStorageText(value, fallback = "") {
  const text = String(value || "").trim();
  if (text.includes("\0") || text.length > 512) return fallback;
  return text;
}

function isKnownLoggingTopic(topic) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_TOPIC_LEVELS, topic)
    || Object.prototype.hasOwnProperty.call(DEFAULT_TOPIC_ENABLED, topic);
}

function normalizeTopicLevels(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = { ...DEFAULT_TOPIC_LEVELS };
  for (const [topic, level] of Object.entries(source)) {
    if (typeof topic !== "string" || topic.length > 120) continue;
    const canonicalTopic = canonicalTopicFor(topic);
    if (typeof canonicalTopic !== "string" || canonicalTopic.length > 120 || !isKnownLoggingTopic(canonicalTopic)) continue;
    const normalized = normalizeLevel(level, null);
    if (normalized) result[canonicalTopic] = normalized;
  }
  return result;
}

function normalizeTopicEnabled(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = { ...DEFAULT_TOPIC_ENABLED };
  for (const [topic, enabled] of Object.entries(source)) {
    if (typeof topic !== "string" || topic.length > 120) continue;
    const canonicalTopic = canonicalTopicFor(topic);
    if (typeof canonicalTopic !== "string" || canonicalTopic.length > 120 || !isKnownLoggingTopic(canonicalTopic)) continue;
    if (typeof enabled === "boolean") result[canonicalTopic] = enabled;
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
  const managedArchiveBucket = managedArchiveBucketName();
  const config = {
    ...cloneJson(DEFAULT_LOGGING_CONFIG),
    enabled: normalizeBoolean(input.enabled, DEFAULT_LOGGING_CONFIG.enabled),
    globalLevel: normalizeLevel(input.globalLevel ?? input.global_level, DEFAULT_LOGGING_CONFIG.globalLevel),
    consoleEnabled: normalizeBoolean(readEnvBoolean("LOG_CONSOLE_ENABLED") ?? input.consoleEnabled ?? input.console_enabled, DEFAULT_LOGGING_CONFIG.consoleEnabled),
    consolePretty: normalizeBoolean(input.consolePretty ?? input.console_pretty, readEnvBoolean("LOG_CONSOLE_PRETTY") ?? DEFAULT_LOGGING_CONFIG.consolePretty),
    consoleFriendly: normalizeBoolean(input.consoleFriendly ?? input.console_friendly, readEnvBoolean("LOG_CONSOLE_FRIENDLY") ?? DEFAULT_LOGGING_CONFIG.consoleFriendly),
    fileEnabled: normalizeBoolean(readEnvBoolean("LOG_FILE_ENABLED") ?? input.fileEnabled ?? input.file_enabled, DEFAULT_LOGGING_CONFIG.fileEnabled),
    logDir: normalizeLogDir(process.env.LOG_DIR || process.env.LOG_FILE_DIR || input.logDir || input.log_dir),
    rotationMode: normalizeRotationMode(input.rotationMode ?? input.rotation_mode),
    retentionDays: normalizeRetentionDays(input.retentionDays ?? input.retention_days),
    liveEnabled: normalizeBoolean(input.liveEnabled ?? input.live_enabled, DEFAULT_LOGGING_CONFIG.liveEnabled),
    liveTtlMinutes: normalizeLiveTtlMinutes(input.liveTtlMinutes ?? input.live_ttl_minutes),
    archiveEnabled: normalizeBoolean(input.archiveEnabled ?? input.archive_enabled, DEFAULT_LOGGING_CONFIG.archiveEnabled),
    archiveProvider: normalizeArchiveProvider(input.archiveProvider ?? input.archive_provider),
    archiveBucket: managedArchiveBucket || normalizeStorageText(input.archiveBucket ?? input.archive_bucket, DEFAULT_LOGGING_CONFIG.archiveBucket),
    managedArchiveBucket,
    archiveBucketManaged: Boolean(managedArchiveBucket),
    archivePrefix: normalizeStorageText(input.archivePrefix ?? input.archive_prefix, DEFAULT_LOGGING_CONFIG.archivePrefix).replace(/^\/+|\/+$/g, "") || DEFAULT_LOGGING_CONFIG.archivePrefix,
    spoolEnabled: normalizeBoolean(input.spoolEnabled ?? input.spool_enabled, DEFAULT_LOGGING_CONFIG.spoolEnabled),
    spoolDir: normalizeLogDir(process.env.LOG_SPOOL_DIR || input.spoolDir || input.spool_dir || DEFAULT_LOGGING_CONFIG.spoolDir),
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

function readSilentPostgresConfigFromEnv() {
  const host = process.env.POSTGRES_HOST || "";
  const database = process.env.POSTGRES_DB || "";
  const user = process.env.POSTGRES_USER || "";
  if (!host || !database || !user) return null;
  return {
    host,
    port: Number(process.env.POSTGRES_PORT || 5432),
    database,
    user,
    password: process.env.POSTGRES_PASSWORD || "",
    ssl: readPostgresSslConfig(),
    max: 1,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 1000,
    statement_timeout: 2000,
    application_name: process.env.POSTGRES_APPLICATION_NAME || "telnyx-contact-center-logging-bootstrap",
  };
}

export async function tryLoadRuntimeLoggingConfigEarly({ now = new Date() } = {}) {
  const pgConfig = readSilentPostgresConfigFromEnv();
  if (!pgConfig) return null;
  const pool = new Pool(pgConfig);
  try {
    const result = await pool.query("SELECT * FROM app_logging_config WHERE id = 'default' LIMIT 1");
    const row = result.rows?.[0] || null;
    if (!row) return null;
    return setCachedRuntimeLoggingConfig(row, { now });
  } catch {
    return null;
  } finally {
    await pool.end().catch(() => {});
  }
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
        console_friendly boolean NOT NULL DEFAULT false,
        file_enabled boolean NOT NULL DEFAULT false,
        log_dir text NOT NULL DEFAULT '/app/logs',
        rotation_mode text NOT NULL DEFAULT 'daily',
        retention_days integer NOT NULL DEFAULT 14,
        live_enabled boolean NOT NULL DEFAULT false,
        live_ttl_minutes integer NOT NULL DEFAULT 15,
        archive_enabled boolean NOT NULL DEFAULT false,
        archive_provider text NOT NULL DEFAULT 's3',
        archive_bucket text NOT NULL DEFAULT '',
        archive_prefix text NOT NULL DEFAULT 'logs',
        spool_enabled boolean NOT NULL DEFAULT false,
        spool_dir text NOT NULL DEFAULT '/app/log-spool',
        topic_levels jsonb NOT NULL DEFAULT '{}'::jsonb,
        topic_enabled jsonb NOT NULL DEFAULT '{}'::jsonb,
        redaction_enabled boolean NOT NULL DEFAULT true,
        expires_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      )
    `);
    await client.query(`
      ALTER TABLE app_logging_config
      ADD COLUMN IF NOT EXISTS console_friendly boolean NOT NULL DEFAULT false
    `);
    await client.query(`
      ALTER TABLE app_logging_config
      ADD COLUMN IF NOT EXISTS live_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS live_ttl_minutes integer NOT NULL DEFAULT 15,
      ADD COLUMN IF NOT EXISTS archive_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS archive_provider text NOT NULL DEFAULT 's3',
      ADD COLUMN IF NOT EXISTS archive_bucket text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS archive_prefix text NOT NULL DEFAULT 'logs',
      ADD COLUMN IF NOT EXISTS spool_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS spool_dir text NOT NULL DEFAULT '/app/log-spool'
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
    config.consoleFriendly,
    config.fileEnabled,
    config.logDir,
    config.rotationMode,
    config.retentionDays,
    config.liveEnabled,
    config.liveTtlMinutes,
    config.archiveEnabled,
    config.archiveProvider,
    config.archiveBucket,
    config.archivePrefix,
    config.spoolEnabled,
    config.spoolDir,
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
        id, enabled, global_level, console_enabled, console_pretty, console_friendly, file_enabled, log_dir,
        rotation_mode, retention_days, live_enabled, live_ttl_minutes, archive_enabled,
        archive_provider, archive_bucket, archive_prefix, spool_enabled, spool_dir,
        topic_levels, topic_enabled, redaction_enabled,
        expires_at, updated_by, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,$21,$22,$23,$24)
      ON CONFLICT (id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        global_level = EXCLUDED.global_level,
        console_enabled = EXCLUDED.console_enabled,
        console_pretty = EXCLUDED.console_pretty,
        console_friendly = EXCLUDED.console_friendly,
        file_enabled = EXCLUDED.file_enabled,
        log_dir = EXCLUDED.log_dir,
        rotation_mode = EXCLUDED.rotation_mode,
        retention_days = EXCLUDED.retention_days,
        live_enabled = EXCLUDED.live_enabled,
        live_ttl_minutes = EXCLUDED.live_ttl_minutes,
        archive_enabled = EXCLUDED.archive_enabled,
        archive_provider = EXCLUDED.archive_provider,
        archive_bucket = EXCLUDED.archive_bucket,
        archive_prefix = EXCLUDED.archive_prefix,
        spool_enabled = EXCLUDED.spool_enabled,
        spool_dir = EXCLUDED.spool_dir,
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
        "telnyx.media": "debug",
        "telnyx.stt.media": "debug",
        "telnyx.streaming": "debug",
        "agent-assist.workflow": "debug",
        "agent-assist": "debug",
      },
      topicEnabled: {
        ...DEFAULT_TOPIC_ENABLED,
        "telnyx.stt": true,
        "telnyx.media": true,
        "telnyx.stt.media": true,
        "telnyx.streaming": true,
        "agent-assist.workflow": true,
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
