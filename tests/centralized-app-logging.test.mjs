import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeConfigUrl = new URL("../lib/logger/runtime-config.mjs", import.meta.url).href;
const loggerUrl = new URL("../lib/logger/index.mjs", import.meta.url).href;
const liveStoreUrl = new URL("../lib/logger/live-store.mjs", import.meta.url).href;
const pagePath = new URL("../app/(portal)/admin/logging/page.jsx", import.meta.url);
const configRoutePath = new URL("../app/api/admin/logging/config/route.js", import.meta.url);

async function fresh(url) {
  return import(`${url}?t=${Date.now()}-${Math.random()}`);
}

function fakePool({ rows = [] } = {}) {
  const queries = [];
  const client = {
    query: async (text, params = []) => {
      queries.push({ text: String(text), params });
      if (/SELECT \* FROM app_logging_config/i.test(String(text))) return { rows };
      if (/INSERT INTO app_logging_config/i.test(String(text))) return { rows: [] };
      if (/INSERT INTO app_log_live_events/i.test(String(text))) return { rows: [{ id: "1" }] };
      return { rows: [] };
    },
    release: () => queries.push({ text: "__release__", params: [] }),
  };
  return { queries, connect: async () => client, query: client.query };
}

test("runtime logging config exposes centralized app logging settings with live TTL clamped to 5-30 minutes", async () => {
  const previous = { ...process.env };
  process.env.APP_ENV = "cc-ha";
  process.env.AWS_ACCOUNT_ID = "260957529682";
  try {
    const { normalizeRuntimeLoggingConfig } = await fresh(runtimeConfigUrl);

    const low = normalizeRuntimeLoggingConfig({ liveEnabled: true, liveTtlMinutes: 2, archiveEnabled: true, archiveProvider: "s3", archiveBucket: "custom-logs", archivePrefix: "logs/cc-ha", spoolEnabled: true, spoolDir: "/tmp/spool" });
    const high = normalizeRuntimeLoggingConfig({ live_ttl_minutes: 90, archive_provider: "azure_blob" });
    const valid = normalizeRuntimeLoggingConfig({ liveTtlMinutes: 17, archiveProvider: "s3" });

    assert.equal(low.liveEnabled, true);
    assert.equal(low.liveTtlMinutes, 5);
    assert.equal(low.archiveEnabled, true);
    assert.equal(low.archiveProvider, "s3");
    assert.equal(low.archiveBucket, "cc-ha-logs-260957529682");
    assert.equal(low.managedArchiveBucket, "cc-ha-logs-260957529682");
    assert.equal(low.archiveBucketManaged, true);
    assert.equal(low.archivePrefix, "logs/cc-ha");
    assert.equal(low.spoolEnabled, true);
    assert.equal(low.spoolDir, "/tmp/spool");
    assert.equal(high.liveTtlMinutes, 30);
    assert.equal(high.archiveProvider, "s3");
    assert.equal(valid.liveTtlMinutes, 17);
    assert.equal(valid.archiveProvider, "s3");
    assert.equal(valid.archiveBucket, "cc-ha-logs-260957529682");
  } finally {
    process.env = previous;
  }
});

test("managed archive bucket is derived from APP_ENV and account env", async () => {
  const previous = { ...process.env };
  process.env.APP_ENV = "cc-prod";
  process.env.LOG_ARCHIVE_ACCOUNT_ID = "260957529682";
  try {
    const { managedArchiveBucketName, normalizeRuntimeLoggingConfig } = await fresh(runtimeConfigUrl);
    assert.equal(managedArchiveBucketName(), "cc-prod-logs-260957529682");
    assert.equal(normalizeRuntimeLoggingConfig({ archiveBucket: "operator-picked-bucket" }).archiveBucket, "cc-prod-logs-260957529682");
  } finally {
    process.env = previous;
  }
});

test("logging config schema persists centralized app logging settings", async () => {
  const { ensureLoggingConfigSchema, saveRuntimeLoggingConfig, resetRuntimeLoggingConfigCache } = await fresh(runtimeConfigUrl);
  resetRuntimeLoggingConfigCache();
  const pool = fakePool({ rows: [{ id: "default" }] });

  await ensureLoggingConfigSchema(pool);
  await saveRuntimeLoggingConfig({ pool, config: { liveEnabled: true, liveTtlMinutes: 11, archiveEnabled: true, archiveProvider: "s3", archiveBucket: "cc-prod-logs", archivePrefix: "logs/cc-prod", spoolEnabled: true, spoolDir: "/app/log-spool" }, updatedBy: "test" });

  const ddl = pool.queries.map((q) => q.text).join("\n");
  assert.match(ddl, /live_enabled/);
  assert.match(ddl, /live_ttl_minutes/);
  assert.match(ddl, /archive_enabled/);
  assert.match(ddl, /archive_provider/);
  assert.match(ddl, /archive_bucket/);
  assert.match(ddl, /archive_prefix/);
  assert.match(ddl, /spool_enabled/);
  assert.match(ddl, /spool_dir/);
  const insert = pool.queries.find((q) => /INSERT INTO app_logging_config/i.test(q.text));
  assert.match(insert.text, /live_enabled/);
  assert.ok(insert.params.includes(11));
  assert.ok(insert.params.includes("cc-prod-logs"));
});

test("live store creates TTL-indexed table, inserts node-tagged events, and prunes by configured TTL", async () => {
  const { ensureLiveLoggingSchema, writeLiveLogEvent, pruneLiveLogEvents } = await fresh(liveStoreUrl);
  const pool = fakePool();
  const event = { time: "2026-06-18T10:00:00.000Z", level: "info", topic: "platform.app", msg: "started", env: "cc-ha", nodeName: "cc-ha-app-0", nodeId: "i-node", runId: "run-1" };

  await ensureLiveLoggingSchema(pool);
  await writeLiveLogEvent({ pool, event, now: new Date("2026-06-18T10:00:01Z") });
  await pruneLiveLogEvents({ pool, ttlMinutes: 17, now: new Date("2026-06-18T10:17:02Z") });

  const sql = pool.queries.map((q) => q.text).join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS app_log_live_events/);
  assert.match(sql, /node_name/);
  assert.match(sql, /payload jsonb/);
  const insert = pool.queries.find((q) => /INSERT INTO app_log_live_events/i.test(q.text));
  assert.deepEqual(insert.params.slice(1, 7), ["info", "platform.app", "started", "cc-ha", "i-node", "cc-ha-app-0"]);
  const prune = pool.queries.find((q) => /DELETE FROM app_log_live_events/i.test(q.text));
  assert.equal(prune.params[0], 17);
});

test("createLogger enriches application logs with env/node metadata and fans out to configured sinks", async () => {
  const previous = { ...process.env };
  process.env.APP_ENV = "cc-ha";
  process.env.APP_NODE_ID = "i-abc";
  process.env.APP_NODE_NAME = "cc-ha-app-0";
  process.env.APP_CONTAINER_NAME = "cc-ha-app";
  try {
    const captured = [];
    const { createLogger } = await fresh(loggerUrl);
    const logger = createLogger({
      topic: "platform.app",
      runId: "run-123",
      config: { globalLevel: "info", consoleEnabled: true, fileEnabled: false, liveEnabled: true, archiveEnabled: true, spoolEnabled: true },
      stdout: () => {},
      sinkWriter: (entry, config) => captured.push({ entry, config }),
    });

    logger.info({ requestId: "req-1" }, "central_log_event");

    assert.equal(captured.length, 1);
    assert.equal(captured[0].entry.env, "cc-ha");
    assert.equal(captured[0].entry.nodeId, "i-abc");
    assert.equal(captured[0].entry.nodeName, "cc-ha-app-0");
    assert.equal(captured[0].entry.containerName, "cc-ha-app");
    assert.equal(captured[0].entry.runId, "run-123");
    assert.equal(captured[0].entry.topic, "platform.app");
    assert.equal(captured[0].config.liveEnabled, true);
  } finally {
    process.env = previous;
  }
});

test("Admin Logging settings expose live TTL and managed centralized archive controls", async () => {
  const page = await readFile(pagePath, "utf8");
  const route = await readFile(configRoutePath, "utf8");

  assert.match(page, /Live buffer TTL/);
  assert.match(page, /min=\"5\"/);
  assert.match(page, /max=\"30\"/);
  assert.match(page, /Archive provider/);
  assert.match(page, /Managed archive bucket/);
  assert.match(page, /managedArchiveBucket/);
  assert.doesNotMatch(page, /updateConfig\(\{ archiveBucket/);
  assert.match(route, /liveTtlMinutes/);
  assert.match(route, /archiveProvider/);
  assert.match(route, /spoolEnabled/);
  assert.doesNotMatch(route, /\"archiveBucket\",/);
});
