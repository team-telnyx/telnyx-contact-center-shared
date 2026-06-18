import { getPostgresPool } from "../postgres.mjs";
import { sanitizeLogPayload } from "./redaction.mjs";

async function withClient(pool, fn) {
  const db = pool || getPostgresPool();
  if (!db) throw new Error("Database connection failed");
  if (typeof db.connect === "function") {
    const client = await db.connect();
    try {
      return await fn(client);
    } finally {
      client.release?.();
    }
  }
  return fn(db);
}

function eventTime(value, now = new Date()) {
  const date = value ? new Date(value) : now;
  return Number.isFinite(date.getTime()) ? date : now;
}

function text(value) {
  return value == null ? null : String(value);
}

function safeLimit(value) {
  const parsed = Number.parseInt(String(value || 100), 10);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(500, parsed));
}

function safeTopics(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 50);
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

let schemaReady = false;

export async function ensureLiveLoggingSchema(pool = getPostgresPool()) {
  if (schemaReady) return;
  await withClient(pool, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_log_live_events (
        id bigserial PRIMARY KEY,
        event_time timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        level text NOT NULL DEFAULT 'info',
        topic text NOT NULL DEFAULT 'app',
        message text,
        env text,
        node_id text,
        node_name text,
        run_id text,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_app_log_live_events_created_at ON app_log_live_events (created_at DESC)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_app_log_live_events_env_node_created ON app_log_live_events (env, node_name, created_at DESC)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_app_log_live_events_topic_created ON app_log_live_events (topic, created_at DESC)");
  });
  schemaReady = true;
}

export async function writeLiveLogEvent({ pool = getPostgresPool(), event, now = new Date() } = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const sanitized = sanitizeLogPayload(event);
  await ensureLiveLoggingSchema(pool);
  return withClient(pool, async (client) => {
    const result = await client.query(
      `INSERT INTO app_log_live_events (
        event_time, level, topic, message, env, node_id, node_name, run_id, payload, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      RETURNING id`,
      [
        eventTime(sanitized.time || sanitized.ts || sanitized.timestamp, now),
        text(sanitized.level) || "info",
        text(sanitized.topic || sanitized.scope) || "app",
        text(sanitized.msg || sanitized.message || sanitized.event),
        text(sanitized.env),
        text(sanitized.nodeId || sanitized.node_id),
        text(sanitized.nodeName || sanitized.node_name),
        text(sanitized.runId || sanitized.run_id),
        JSON.stringify(sanitized),
        now,
      ],
    );
    return result.rows?.[0] || null;
  });
}

export async function pruneLiveLogEvents({ pool = getPostgresPool(), ttlMinutes = 15, now = new Date() } = {}) {
  const ttl = Math.max(5, Math.min(30, Number.parseInt(String(ttlMinutes || 15), 10) || 15));
  await ensureLiveLoggingSchema(pool);
  return withClient(pool, async (client) => client.query(
    "DELETE FROM app_log_live_events WHERE created_at < ($2::timestamptz - ($1::int * interval '1 minute'))",
    [ttl, now],
  ));
}

export async function queryLiveLogEvents({
  pool = getPostgresPool(),
  env,
  nodeName,
  level,
  topic,
  topics,
  runId,
  search,
  from,
  to,
  limit = 100,
} = {}) {
  await ensureLiveLoggingSchema(pool);
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (env) add("env = ?", env);
  if (nodeName) add("node_name = ?", nodeName);
  if (level) add("level = ?", String(level).toLowerCase());
  const selectedTopics = safeTopics(topics);
  if (selectedTopics.length) {
    params.push(selectedTopics);
    where.push(`topic = ANY($${params.length}::text[])`);
  } else if (topic) add("topic = ?", topic);
  if (runId) add("run_id = ?", runId);
  if (search) add("payload::text ILIKE ?", `%${search}%`);
  const fromDate = safeDate(from);
  const toDate = safeDate(to);
  if (fromDate) add("event_time >= ?", fromDate);
  if (toDate) add("event_time <= ?", toDate);
  params.push(safeLimit(limit));
  const sql = `SELECT payload FROM app_log_live_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`;
  return withClient(pool, async (client) => {
    const result = await client.query(sql, params);
    return {
      entries: (result.rows || []).map((row) => row.payload).filter(Boolean),
      source: "postgres-live",
      truncated: false,
      skippedInvalid: 0,
    };
  });
}
