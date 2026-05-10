import { Pool } from "pg";

// Global cached pool + status across reloads in dev
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
    console.log("[Postgres] connected");
  });
  pool.on("acquire", () => {
    // Acquisition implies activity; keep status as-is or connecting
    if (cached.status !== "connected") cached.status = "connecting";
  });
  pool.on("remove", () => {
    console.log("[Postgres] client removed from pool");
  });
  pool.on("error", (err) => {
    cached.status = "disconnected";
    console.error("[Postgres] error:", err?.message || err);
  });
}

export function getPostgresPool() {
  if (cached.pool) return cached.pool;
  const { configured, config } = readConfigFromEnv();
  if (!configured) {
    console.warn(
      "[Postgres] not configured (missing env vars). Expected POSTGRES_*."
    );
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
  console.log("[Postgres] pool created for", redactConfig(config));
  return pool;
}

export async function checkPostgresStatus() {
  try {
    const pool = getPostgresPool();
    if (!pool) return { status: "disconnected", ready: false };
    cached.status = "connecting";
    await pool.query("SELECT 1 AS ok");
    cached.status = "connected";
    console.log("[Postgres] status:", cached.status);
    return { status: "connected", ready: true };
  } catch (err) {
    cached.status = "disconnected";
    console.log(
      "[Postgres] status:",
      cached.status,
      "error:",
      err?.message || String(err)
    );
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
