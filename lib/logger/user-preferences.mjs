import { getPostgresPool } from "../postgres.mjs";
import { canonicalTopicFor, LOGGING_TOPIC_GROUPS } from "./topic-catalog.mjs";

const KNOWN_TOPICS = new Set(LOGGING_TOPIC_GROUPS.flatMap((group) => group.topics.map((topic) => topic.id)));

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

export function normalizeLoggingUserFilters(filters = {}) {
  const topics = [];
  const seen = new Set();
  for (const rawTopic of Array.isArray(filters?.topics) ? filters.topics : []) {
    const topic = canonicalTopicFor(rawTopic);
    if (!topic || !KNOWN_TOPICS.has(topic) || seen.has(topic)) continue;
    seen.add(topic);
    topics.push(topic);
  }
  return { topics };
}

export async function ensureLoggingUserPreferenceSchema(pool = getPostgresPool()) {
  await withClient(pool, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_logging_user_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        log_filters JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_app_logging_user_preferences_updated_at
      ON app_logging_user_preferences (updated_at)
    `);
  });
}

export async function getLoggingUserPreferences({ pool = getPostgresPool(), userId } = {}) {
  if (!userId) throw new Error("userId is required");
  await ensureLoggingUserPreferenceSchema(pool);
  const row = await withClient(pool, async (client) => {
    const result = await client.query(
      "SELECT log_filters FROM app_logging_user_preferences WHERE user_id = $1 LIMIT 1",
      [userId],
    );
    return result.rows?.[0] || null;
  });
  return { filters: normalizeLoggingUserFilters(row?.log_filters || {}) };
}

export async function saveLoggingUserPreferences({ pool = getPostgresPool(), userId, filters = {} } = {}) {
  if (!userId) throw new Error("userId is required");
  const normalizedFilters = normalizeLoggingUserFilters(filters);
  await ensureLoggingUserPreferenceSchema(pool);
  await withClient(pool, async (client) => {
    await client.query(
      `INSERT INTO app_logging_user_preferences (user_id, log_filters, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET
         log_filters = EXCLUDED.log_filters,
         updated_at = now()`,
      [userId, JSON.stringify(normalizedFilters)],
    );
  });
  return { filters: normalizedFilters };
}
