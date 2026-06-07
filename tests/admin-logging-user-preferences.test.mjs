import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const prefsModuleUrl = new URL("../lib/logger/user-preferences.mjs", import.meta.url).href;
const pageUrl = new URL("../app/(portal)/admin/logging/page.jsx", import.meta.url);
const schemaUrl = new URL("../lib/postgres-schema.mjs", import.meta.url);
const routeUrl = new URL("../app/api/admin/logging/preferences/route.js", import.meta.url);

async function freshPrefsModule() {
  return import(`${prefsModuleUrl}?t=${Date.now()}-${Math.random()}`);
}

function createFakePool({ rows = [] } = {}) {
  const queries = [];
  const client = {
    query: async (text, params = []) => {
      queries.push({ text: String(text), params });
      if (/SELECT log_filters FROM app_logging_user_preferences/i.test(String(text))) return { rows };
      if (/INSERT INTO app_logging_user_preferences/i.test(String(text))) {
        return { rows: [{ user_id: params[0], log_filters: params[1] }] };
      }
      return { rows: [] };
    },
    release: () => queries.push({ text: "__release__", params: [] }),
  };
  return {
    queries,
    connect: async () => client,
    query: async (text, params = []) => client.query(text, params),
  };
}

test("logging user preferences schema stores per-admin log topic filters", async () => {
  const schema = await readFile(schemaUrl, "utf8");

  assert.match(schema, /CREATE TABLE IF NOT EXISTS app_logging_user_preferences/);
  assert.match(schema, /user_id TEXT PRIMARY KEY REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(schema, /log_filters JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_app_logging_user_preferences_updated_at/);
});

test("logging user preferences normalize and upsert only safe topic filter state", async () => {
  const { getLoggingUserPreferences, saveLoggingUserPreferences } = await freshPrefsModule();
  const pool = createFakePool({ rows: [{ log_filters: { topics: ["telnyx.stt", "db", "frontend.admin", "telnyx.stt", "unknown.topic"] } }] });

  const loaded = await getLoggingUserPreferences({ pool, userId: "admin-1" });
  assert.deepEqual(loaded.filters.topics, ["telnyx.stt", "platform.db"]);

  const saved = await saveLoggingUserPreferences({
    pool,
    userId: "admin-1",
    filters: { topics: ["voice.webhooks", "db", "bad.topic", "voice.webhooks"] },
  });

  assert.deepEqual(saved.filters.topics, ["voice.webhooks", "platform.db"]);
  assert.ok(pool.queries.some((q) => /CREATE TABLE IF NOT EXISTS app_logging_user_preferences/i.test(q.text)));
  const upsert = pool.queries.find((q) => /INSERT INTO app_logging_user_preferences/i.test(q.text));
  assert.ok(upsert, "save must upsert per-user preferences");
  assert.equal(upsert.params[0], "admin-1");
  assert.deepEqual(JSON.parse(upsert.params[1]), { topics: ["voice.webhooks", "platform.db"] });
});

test("Admin logging page hydrates topic filters from per-admin preferences and preserves app state locally", async () => {
  const page = await readFile(pageUrl, "utf8");

  assert.match(page, /LOGGING_FILTER_STATE_STORAGE_KEY/);
  assert.match(page, /localStorage\.getItem\(LOGGING_FILTER_STATE_STORAGE_KEY\)/);
  assert.match(page, /localStorage\.setItem\(LOGGING_FILTER_STATE_STORAGE_KEY, JSON\.stringify\(next\)\)/);
  assert.match(page, /fetch\("\/api\/admin\/logging\/preferences", \{ cache: "no-store" \}\)/);
  assert.match(page, /const next = \{ \.\.\.prev, topics: data\.preferences\.filters\.topics \|\| \[\] \}/);
  assert.match(page, /persistLogFilters\(next\)/);
  assert.match(page, /fetch\("\/api\/admin\/logging\/preferences", \{[\s\S]*method: "PUT"[\s\S]*filters: \{ topics: selectedTopics\(next\) \}/);
});

test("admin logging preferences API is admin-only and reads/writes the current user's saved filters", async () => {
  const route = await readFile(routeUrl, "utf8");

  assert.match(route, /async function requireAdmin\(\)/);
  assert.match(route, /getLoggingUserPreferences/);
  assert.match(route, /saveLoggingUserPreferences/);
  assert.match(route, /export async function GET\(\)/);
  assert.match(route, /export async function PUT\(request\)/);
  assert.match(route, /user\.id \|\| user\.email \|\| user\.username/);
  assert.match(route, /filters: body\?\.filters \|\| body\?\.preferences\?\.filters \|\| \{\}/);
});
