import { Pool } from "pg";
import { createLogger } from "./logger/index.mjs";
import { getCachedRuntimeLoggingConfig } from "./logger/runtime-config.mjs";

function getDbRuntimeLoggingConfig() {
  const runtimeConfig = getCachedRuntimeLoggingConfig();
  if (!runtimeConfig) return null;
  return {
    ...runtimeConfig,
    topicLevels: {
      ...(runtimeConfig.topicLevels || {}),
      db: process.env.LOG_DB_LEVEL || "info",
    },
  };
}

// Global cached pool + status across reloads in dev
const dbLogger = createLogger({
  topic: "db",
  config: {
    globalLevel: process.env.LOG_LEVEL || "info",
    consoleEnabled: true,
    consolePretty: ["1", "true", "yes", "on"].includes(String(process.env.LOG_CONSOLE_PRETTY || "").toLowerCase()),
    fileEnabled: ["1", "true", "yes", "on"].includes(String(process.env.LOG_FILE_ENABLED || "").toLowerCase()) || Boolean(process.env.LOG_FILE_PATH),
    logDir: process.env.LOG_DIR || process.env.LOG_FILE_DIR || (process.env.NODE_ENV === "production" ? "/app/logs" : `${process.cwd()}/logs`),
    logFilePath: process.env.LOG_FILE_PATH || "",
    rotationMode: process.env.LOG_ROTATION_MODE || "daily",
    redactionEnabled: true,
    topicLevels: { db: process.env.LOG_DB_LEVEL || "info" },
    topicEnabled: { db: true },
  },
  getConfig: getDbRuntimeLoggingConfig,
});

let cached = global.__pg_pool;
if (!cached) {
  cached = global.__pg_pool = {
    pool: null,
    status: "disconnected",
    listenersAttached: false,
  };
}

function readConfigFromEnv() {
  const host = process.env.POSTGRES_HOST || "";
  const port = Number(process.env.POSTGRES_PORT || 5432);
  const database = process.env.POSTGRES_DB || "";
  const user = process.env.POSTGRES_USER || "";
  const password = process.env.POSTGRES_PASSWORD || "";
  const configured = Boolean(host && database && user);
  return {
    configured,
    config: { host, port, database, user, password },
  };
}

function redactConfig(config) {
  if (!config) return "<not-configured>";
  const host = config.host || "?";
  const port = config.port || "?";
  const db = config.database || "?";
  return `${host}:${port}/${db}`;
}

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPoolMax() {
  // Next dev/build can create multiple Node processes/workers. A per-process
  // pool of 20 can easily exhaust a local Postgres max_connections=100.
  // Keep the default conservative and allow explicit override when needed.
  return readPositiveInt(
    process.env.POSTGRES_POOL_MAX || process.env.PGPOOL_MAX,
    5
  );
}

function attachLoggingOnce(pool) {
  if (cached.listenersAttached) return;
  cached.listenersAttached = true;

  pool.on("connect", () => {
    cached.status = "connected";
    dbLogger.info({ status: cached.status }, "postgres_connected");
  });
  pool.on("acquire", () => {
    // Acquisition implies activity; keep status as-is or connecting
    if (cached.status !== "connected") cached.status = "connecting";
  });
  pool.on("remove", () => {
    dbLogger.debug({ status: cached.status }, "postgres_client_removed");
  });
  pool.on("error", (err) => {
    cached.status = "disconnected";
    dbLogger.error({ error: err?.message || String(err) }, "postgres_pool_error");
  });
}

export function getPostgresPool() {
  if (cached.pool) return cached.pool;
  const { configured, config } = readConfigFromEnv();
  if (!configured) {
    dbLogger.warn({ missing: ["POSTGRES_HOST", "POSTGRES_DB", "POSTGRES_USER"] }, "postgres_not_configured");
    cached.status = "disconnected";
    return null;
  }
  const pool = new Pool({
    ...config,
    allowExitOnIdle: true,
    ssl: false,
    max: readPoolMax(), // Maximum number of clients per process/worker
    idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 10000, // Return an error after 10 seconds if connection could not be established
    statement_timeout: 30000, // Timeout for queries (30 seconds)
    application_name: process.env.POSTGRES_APPLICATION_NAME || "telnyx-contact-center",
  });
  attachLoggingOnce(pool);
  cached.pool = pool;
  dbLogger.info({ target: redactConfig(config), max: readPoolMax() }, "postgres_pool_created");
  return pool;
}

export async function checkPostgresStatus() {
  try {
    const pool = getPostgresPool();
    if (!pool) return { status: "disconnected", ready: false };
    cached.status = "connecting";
    await pool.query("SELECT 1 AS ok");
    cached.status = "connected";
    dbLogger.info({ status: cached.status }, "postgres_status_check_ok");
    return { status: "connected", ready: true };
  } catch (err) {
    cached.status = "disconnected";
    dbLogger.error({ status: cached.status, error: err?.message || String(err) }, "postgres_status_check_failed");
    return {
      status: "disconnected",
      ready: false,
      error: err?.message || String(err),
    };
  }
}

export function getPostgresReadyState() {
  const status = cached.status || "disconnected";
  const map = {
    disconnected: 0,
    connected: 1,
    connecting: 2,
    disconnecting: 3,
  };
  const readyState = map[status] ?? 0;
  return { readyState, status };
}
