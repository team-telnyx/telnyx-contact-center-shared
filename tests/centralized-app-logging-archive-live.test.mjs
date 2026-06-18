import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const liveStoreUrl = new URL("../lib/logger/live-store.mjs", import.meta.url).href;
const archiveUrl = new URL("../lib/logger/object-archive.mjs", import.meta.url).href;
const sinksUrl = new URL("../lib/logger/app-log-sinks.mjs", import.meta.url).href;
const sinksPath = new URL("../lib/logger/app-log-sinks.mjs", import.meta.url);
const streamRoutePath = new URL("../app/api/admin/logging/stream/route.js", import.meta.url);
const logsRoutePath = new URL("../app/api/admin/logging/logs/route.js", import.meta.url);
const pagePath = new URL("../app/(portal)/admin/logging/page.jsx", import.meta.url);

async function fresh(url) {
  return import(`${url}?t=${Date.now()}-${Math.random()}`);
}

function fakePool({ liveRows = [] } = {}) {
  const queries = [];
  const client = {
    query: async (text, params = []) => {
      queries.push({ text: String(text), params });
      if (/SELECT payload FROM app_log_live_events/i.test(String(text))) return { rows: liveRows };
      return { rows: [] };
    },
    release: () => queries.push({ text: "__release__", params: [] }),
  };
  return { queries, connect: async () => client, query: client.query };
}

test("queryLiveLogEvents reads global live buffer with node filter and newest-first ordering", async () => {
  const { queryLiveLogEvents } = await fresh(liveStoreUrl);
  const pool = fakePool({ liveRows: [{ payload: { time: "2026-06-18T10:00:00Z", nodeName: "cc-ha-app-0", msg: "ok" } }] });

  const result = await queryLiveLogEvents({ pool, env: "cc-ha", nodeName: "cc-ha-app-0", level: "info", topic: "platform.app", limit: 25 });

  assert.deepEqual(result.entries, [{ time: "2026-06-18T10:00:00Z", nodeName: "cc-ha-app-0", msg: "ok" }]);
  const select = pool.queries.find((q) => /SELECT payload FROM app_log_live_events/i.test(q.text));
  assert.match(select.text, /env =/);
  assert.match(select.text, /node_name =/);
  assert.match(select.text, /ORDER BY created_at DESC/);
  assert.equal(select.params.includes("cc-ha"), true);
  assert.equal(select.params.includes("cc-ha-app-0"), true);
});

test("queryLiveLogEvents honors multi-topic and time-window filters for live Postgres logs", async () => {
  const { queryLiveLogEvents } = await fresh(liveStoreUrl);
  const pool = fakePool();

  await queryLiveLogEvents({
    pool,
    topics: ["platform.app", "telnyx.streaming"],
    from: "2026-06-18T10:00:00Z",
    to: "2026-06-18T10:05:00Z",
    limit: 50,
  });

  const select = pool.queries.find((q) => /SELECT payload FROM app_log_live_events/i.test(q.text));
  assert.match(select.text, /topic = ANY/);
  assert.match(select.text, /event_time >=/);
  assert.match(select.text, /event_time <=/);
  assert.deepEqual(select.params[0], ["platform.app", "telnyx.streaming"]);
});

test("object archive builds provider-agnostic env/date/node/run chunk keys and writes S3-compatible objects", async () => {
  const putCalls = [];
  const { buildArchiveObjectKey, writeArchiveLogEvent } = await fresh(archiveUrl);
  const key = buildArchiveObjectKey({
    prefix: "logs/cc-ha",
    event: { time: "2026-06-18T10:01:02.123Z", nodeName: "cc-ha-app-0", runId: "run:1" },
    sequence: "000001",
  });

  assert.equal(key, "logs/cc-ha/date=2026-06-18/node=cc-ha-app-0/run=run-1/part-000001.jsonl");

  await writeArchiveLogEvent({
    event: { time: "2026-06-18T10:01:02.123Z", nodeName: "cc-ha-app-0", runId: "run:1", msg: "hello", password: "super-secret" },
    config: { archiveEnabled: true, archiveProvider: "s3", archiveBucket: "cc-ha-logs", archivePrefix: "logs/cc-ha" },
    s3Client: { send: async (command) => putCalls.push(command.input) },
    sequence: "000002",
  });

  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0].Bucket, "cc-ha-logs");
  assert.equal(putCalls[0].Key, "logs/cc-ha/date=2026-06-18/node=cc-ha-app-0/run=run-1/part-000002.jsonl");
  assert.match(putCalls[0].Body, /"msg":"hello"/);
  assert.doesNotMatch(putCalls[0].Body, /super-secret/);
  assert.equal(putCalls[0].ContentType, "application/x-ndjson");
});

test("object archive queues bounded batches instead of writing one S3 object per log event", async () => {
  const putCalls = [];
  const { enqueueArchiveLogEvent, flushArchiveBatch } = await fresh(archiveUrl);
  const config = {
    archiveEnabled: true,
    archiveProvider: "s3",
    archiveBucket: "cc-ha-logs",
    archivePrefix: "logs/cc-ha",
    archiveBatchSize: 10,
    archiveFlushMs: 60000,
  };

  enqueueArchiveLogEvent({ event: { time: "2026-06-18T10:01:02.123Z", nodeName: "cc-ha-app-0", runId: "run-1", msg: "one", password: "secret-one" }, config });
  enqueueArchiveLogEvent({ event: { time: "2026-06-18T10:01:03.123Z", nodeName: "cc-ha-app-0", runId: "run-1", msg: "two" }, config });
  await flushArchiveBatch({ s3Client: { send: async (command) => putCalls.push(command.input) } });

  assert.equal(putCalls.length, 1);
  assert.match(putCalls[0].Body, /"msg":"one"/);
  assert.match(putCalls[0].Body, /"msg":"two"/);
  assert.equal(putCalls[0].Body.trim().split("\n").length, 2);
  assert.doesNotMatch(putCalls[0].Body, /secret-one/);
});

test("local spool persists redacted JSONL through backend-owned spool directory", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cc-log-spool-"));
  const previous = process.env.LOG_SPOOL_DIR;
  process.env.LOG_SPOOL_DIR = tmp;
  try {
    const { writeApplicationLogSinks } = await fresh(sinksUrl);
    await writeApplicationLogSinks(
      { time: "2026-06-18T10:01:02.123Z", nodeName: "cc-ha-app-0", msg: "hello", apiKey: "key-secret" },
      { spoolEnabled: true, liveEnabled: false, archiveEnabled: false, spoolDir: "/should-not-win" },
      { pool: fakePool(), now: new Date("2026-06-18T10:01:03Z") },
    );
    const body = await readFile(path.join(tmp, "app-2026-06-18-cc-ha-app-0.jsonl"), "utf8");
    assert.match(body, /"msg":"hello"/);
    assert.doesNotMatch(body, /key-secret/);
  } finally {
    if (previous == null) delete process.env.LOG_SPOOL_DIR;
    else process.env.LOG_SPOOL_DIR = previous;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("archive logging does not force local spool when spool is disabled", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cc-log-spool-disabled-"));
  const previous = process.env.LOG_SPOOL_DIR;
  process.env.LOG_SPOOL_DIR = tmp;
  try {
    const { writeApplicationLogSinks } = await fresh(sinksUrl);
    await writeApplicationLogSinks(
      { time: "2026-06-18T10:01:02.123Z", nodeName: "cc-ha-app-0", msg: "archive-only" },
      { spoolEnabled: false, liveEnabled: false, archiveEnabled: true, archiveProvider: "", archiveBucket: "" },
      { pool: fakePool(), now: new Date("2026-06-18T10:01:03Z") },
    );
    assert.deepEqual(await readdir(tmp), []);
  } finally {
    if (previous == null) delete process.env.LOG_SPOOL_DIR;
    else process.env.LOG_SPOOL_DIR = previous;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("spool filenames derive dates from parsed timestamps instead of raw log text", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cc-log-spool-safe-date-"));
  const previous = process.env.LOG_SPOOL_DIR;
  process.env.LOG_SPOOL_DIR = tmp;
  try {
    const { writeApplicationLogSinks } = await fresh(sinksUrl);
    await writeApplicationLogSinks(
      { time: "../../etc/passwd", nodeName: "cc-ha-app-0", msg: "safe" },
      { spoolEnabled: true, liveEnabled: false, archiveEnabled: false },
      { pool: fakePool(), now: new Date("2026-06-18T10:01:03Z") },
    );
    const files = await readdir(tmp);
    assert.equal(files.length, 1);
    assert.match(files[0], /^app-\d{4}-\d{2}-\d{2}-cc-ha-app-0\.jsonl$/);
    assert.doesNotMatch(files[0], /\.\.|\//);
  } finally {
    if (previous == null) delete process.env.LOG_SPOOL_DIR;
    else process.env.LOG_SPOOL_DIR = previous;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("fire-and-forget application sinks use a bounded queue instead of spawning direct sink writes", async () => {
  const source = await readFile(sinksPath, "utf8");
  assert.match(source, /const DEFAULT_MAX_QUEUE/);
  assert.match(source, /sinkQueue\.push/);
  assert.match(source, /sinkQueue\.splice/);
  assert.match(source, /void drainSinkQueue/);
  assert.doesNotMatch(source, /fireAndForgetApplicationLogSinks[\s\S]*writeApplicationLogSinks\(entry/);
});

test("admin logging APIs prefer Postgres live buffer when live logging is enabled", async () => {
  const streamRoute = await readFile(streamRoutePath, "utf8");
  const logsRoute = await readFile(logsRoutePath, "utf8");
  const page = await readFile(pagePath, "utf8");

  assert.match(streamRoute, /queryLiveLogEvents/);
  assert.match(streamRoute, /config\.liveEnabled/);
  assert.match(streamRoute, /nodeName/);
  assert.match(logsRoute, /mode === "live"/);
  assert.match(logsRoute, /queryLiveLogEvents/);
  assert.match(page, /params\.set\("mode", "live"\)/);
});

test("logging UI exposes node filter and node badge for HA global logs", async () => {
  const page = await readFile(pagePath, "utf8");

  assert.match(page, /Node/);
  assert.match(page, /nodeName/);
  assert.match(page, /All nodes/);
  assert.match(page, /entry\.nodeName/);
});
