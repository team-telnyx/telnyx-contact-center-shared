import assert from "node:assert/strict";
import test from "node:test";

const moduleUrl = new URL("../lib/logger/runtime-config.mjs", import.meta.url).href;

async function freshModule() {
  return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

function createFakePool({ rows = [] } = {}) {
  const queries = [];
  const client = {
    query: async (text, params = []) => {
      queries.push({ text: String(text), params });
      if (/SELECT \* FROM app_logging_config/i.test(String(text))) {
        return { rows };
      }
      if (/INSERT INTO app_logging_config/i.test(String(text))) {
        return { rows: [{ ...(params[0] || {}) }] };
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

test("getRuntimeLoggingConfig seeds schema and returns safe defaults when no row exists", async () => {
  const { getRuntimeLoggingConfig, resetRuntimeLoggingConfigCache } = await freshModule();
  resetRuntimeLoggingConfigCache();
  const pool = createFakePool({ rows: [] });

  const config = await getRuntimeLoggingConfig({ pool, forceRefresh: true, now: new Date("2026-06-06T10:00:00Z") });

  assert.equal(config.enabled, true);
  assert.equal(config.globalLevel, "info");
  assert.equal(config.consoleEnabled, true);
  assert.equal(config.consolePretty, false);
  assert.equal(config.consoleFriendly, false);
  assert.equal(config.fileEnabled, true);
  assert.match(config.logDir, /\/logs$/);
  assert.equal(config.rotationMode, "daily");
  assert.equal(config.retentionDays, 14);
  assert.equal(config.redactionEnabled, true);
  assert.equal(config.topicLevels["telnyx.stt"], "info");
  assert.equal(config.topicEnabled["telnyx.stt"], true);
  assert.ok(pool.queries.some((q) => /CREATE TABLE IF NOT EXISTS app_logging_config/i.test(q.text)));
  assert.ok(pool.queries.some((q) => /CREATE TABLE IF NOT EXISTS app_logging_config_audit/i.test(q.text)));
});

test("getRuntimeLoggingConfig normalizes DB rows and honors cache TTL", async () => {
  const { getRuntimeLoggingConfig, resetRuntimeLoggingConfigCache } = await freshModule();
  resetRuntimeLoggingConfigCache();
  const row = {
    enabled: false,
    global_level: "verbose",
    console_enabled: true,
    console_pretty: true,
    console_friendly: true,
    file_enabled: true,
    log_dir: "/var/log/cc",
    rotation_mode: "startup",
    retention_days: 0,
    topic_levels: { "telnyx.stt": "debug", db: "trace", bad: "loud" },
    topic_enabled: { "telnyx.stt": true, db: false },
    redaction_enabled: true,
    expires_at: null,
    updated_at: "2026-06-06T09:00:00Z",
  };
  const pool = createFakePool({ rows: [row] });

  const first = await getRuntimeLoggingConfig({ pool, forceRefresh: true, now: new Date("2026-06-06T10:00:00Z") });
  const second = await getRuntimeLoggingConfig({ pool, now: new Date("2026-06-06T10:00:03Z") });

  assert.equal(first.globalLevel, "info");
  assert.equal(first.rotationMode, "startup");
  assert.equal(first.retentionDays, 14);
  assert.equal(first.topicLevels["telnyx.stt"], "debug");
  assert.equal(first.topicLevels.db, "trace");
  assert.equal(first.topicLevels.bad, undefined);
  assert.deepEqual(second, first);
  const selectCount = pool.queries.filter((q) => /SELECT \* FROM app_logging_config/i.test(q.text)).length;
  assert.equal(selectCount, 1);
});


test("environment overrides win over persisted runtime sink and console settings", async () => {
  const previousLogDir = process.env.LOG_DIR;
  const previousPretty = process.env.LOG_CONSOLE_PRETTY;
  const previousFriendly = process.env.LOG_CONSOLE_FRIENDLY;
  const previousFile = process.env.LOG_FILE_ENABLED;
  process.env.LOG_DIR = "/tmp/contact-center-dev-logs";
  process.env.LOG_CONSOLE_PRETTY = "1";
  process.env.LOG_CONSOLE_FRIENDLY = "1";
  process.env.LOG_FILE_ENABLED = "1";
  try {
    const { getRuntimeLoggingConfig, resetRuntimeLoggingConfigCache } = await freshModule();
    resetRuntimeLoggingConfigCache();
    const pool = createFakePool({ rows: [{ console_pretty: false, file_enabled: false, log_dir: "/app/logs" }] });

    const config = await getRuntimeLoggingConfig({ pool, forceRefresh: true, now: new Date("2026-06-06T10:00:00Z") });

    assert.equal(config.consolePretty, true);
    assert.equal(config.consoleFriendly, true);
    assert.equal(config.fileEnabled, true);
    assert.equal(config.logDir, "/tmp/contact-center-dev-logs");
  } finally {
    if (previousLogDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = previousLogDir;
    if (previousPretty === undefined) delete process.env.LOG_CONSOLE_PRETTY;
    else process.env.LOG_CONSOLE_PRETTY = previousPretty;
    if (previousFriendly === undefined) delete process.env.LOG_CONSOLE_FRIENDLY;
    else process.env.LOG_CONSOLE_FRIENDLY = previousFriendly;
    if (previousFile === undefined) delete process.env.LOG_FILE_ENABLED;
    else process.env.LOG_FILE_ENABLED = previousFile;
  }
});

test("saveRuntimeLoggingConfig validates input, upserts config, writes audit, and resets cache", async () => {
  const { saveRuntimeLoggingConfig, getRuntimeLoggingConfig, resetRuntimeLoggingConfigCache } = await freshModule();
  resetRuntimeLoggingConfigCache();
  const pool = createFakePool({ rows: [] });

  const saved = await saveRuntimeLoggingConfig({
    pool,
    updatedBy: "admin-user",
    now: new Date("2026-06-06T10:00:00Z"),
    config: {
      globalLevel: "debug",
      consolePretty: true,
      consoleFriendly: true,
      fileEnabled: true,
      logDir: "/app/logs",
      rotationMode: "daily",
      retentionDays: 7,
      topicLevels: { "telnyx.stt": "trace", db: "warn" },
      topicEnabled: { "telnyx.stt": true, db: false },
    },
  });

  assert.equal(saved.globalLevel, "debug");
  assert.equal(saved.consolePretty, true);
  assert.equal(saved.consoleFriendly, true);
  assert.equal(saved.fileEnabled, true);
  assert.equal(saved.topicLevels["telnyx.stt"], "trace");
  assert.ok(pool.queries.some((q) => /INSERT INTO app_logging_config/i.test(q.text) && /ON CONFLICT/i.test(q.text)));
  assert.ok(pool.queries.some((q) => /INSERT INTO app_logging_config_audit/i.test(q.text)));

  const beforeCachedReadSelectCount = pool.queries.filter((q) => /SELECT \* FROM app_logging_config/i.test(q.text)).length;
  const cached = await getRuntimeLoggingConfig({ pool, now: new Date("2026-06-06T10:00:01Z") });
  const afterCachedReadSelectCount = pool.queries.filter((q) => /SELECT \* FROM app_logging_config/i.test(q.text)).length;
  assert.equal(afterCachedReadSelectCount, beforeCachedReadSelectCount, "saved config should be available from local runtime cache without DB reload");
  assert.equal(cached.globalLevel, "debug");
});

test("saveRuntimeLoggingConfig keeps redaction enabled even if request tries to disable it", async () => {
  const { saveRuntimeLoggingConfig, resetRuntimeLoggingConfigCache } = await freshModule();
  resetRuntimeLoggingConfigCache();
  const pool = createFakePool({ rows: [] });

  const saved = await saveRuntimeLoggingConfig({
    pool,
    updatedBy: "admin-user",
    now: new Date("2026-06-06T10:00:00Z"),
    config: { redactionEnabled: false, globalLevel: "debug" },
  });

  assert.equal(saved.globalLevel, "debug");
  assert.equal(saved.redactionEnabled, true);
});

test("applyLoggingPreset supports time-limited STT debug and normal production presets", async () => {
  const { applyLoggingPreset, resetRuntimeLoggingConfigCache } = await freshModule();
  resetRuntimeLoggingConfigCache();
  const pool = createFakePool({ rows: [] });

  const debug = await applyLoggingPreset({
    pool,
    preset: "debug-telnyx-stt",
    ttlMinutes: 30,
    updatedBy: "admin-user",
    now: new Date("2026-06-06T10:00:00Z"),
  });

  assert.equal(debug.globalLevel, "debug");
  assert.equal(debug.topicLevels["telnyx.stt"], "trace");
  assert.equal(debug.topicEnabled["telnyx.stt.media"], true);
  assert.equal(debug.expiresAt, "2026-06-06T10:30:00.000Z");

  const normal = await applyLoggingPreset({
    pool,
    preset: "normal-production",
    updatedBy: "admin-user",
    now: new Date("2026-06-06T11:00:00Z"),
  });

  assert.equal(normal.globalLevel, "info");
  assert.equal(normal.consolePretty, false);
  assert.equal(normal.expiresAt, null);
});

test("expired preset automatically falls back to normal production config", async () => {
  const { getRuntimeLoggingConfig, resetRuntimeLoggingConfigCache } = await freshModule();
  resetRuntimeLoggingConfigCache();
  const pool = createFakePool({ rows: [{
    global_level: "debug",
    topic_levels: { "telnyx.stt": "trace" },
    topic_enabled: { "telnyx.stt": true, "telnyx.stt.media": true },
    expires_at: "2026-06-06T10:30:00.000Z",
  }] });

  const config = await getRuntimeLoggingConfig({ pool, forceRefresh: true, now: new Date("2026-06-06T10:31:00Z") });

  assert.equal(config.globalLevel, "info");
  assert.equal(config.topicLevels["telnyx.stt"], "info");
  assert.equal(config.expiresAt, null);
});

test("synchronous runtime config getter revalidates cached preset expiry", async () => {
  const {
    getCachedRuntimeLoggingConfig,
    resetRuntimeLoggingConfigCache,
    setCachedRuntimeLoggingConfig,
  } = await freshModule();
  resetRuntimeLoggingConfigCache();

  setCachedRuntimeLoggingConfig({
    globalLevel: "debug",
    topicLevels: { "telnyx.stt": "trace" },
    topicEnabled: { "telnyx.stt": true, "telnyx.stt.media": true },
    expiresAt: "2026-06-06T10:30:00.000Z",
  }, { now: new Date("2026-06-06T10:00:00Z") });

  const active = getCachedRuntimeLoggingConfig({ now: new Date("2026-06-06T10:29:59Z") });
  const expired = getCachedRuntimeLoggingConfig({ now: new Date("2026-06-06T10:30:00Z") });

  assert.equal(active.globalLevel, "debug");
  assert.equal(active.topicLevels["telnyx.stt"], "trace");
  assert.equal(expired.globalLevel, "info");
  assert.equal(expired.topicLevels["telnyx.stt"], "info");
  assert.equal(expired.expiresAt, null);
});
