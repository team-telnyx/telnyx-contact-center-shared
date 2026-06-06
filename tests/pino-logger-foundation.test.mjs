import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const loggerModuleUrl = new URL("../lib/logger/index.mjs", import.meta.url).href;
const diagnosticModuleUrl = new URL("../lib/diagnostic-logger.mjs", import.meta.url).href;

async function freshLoggerModule() {
  return import(`${loggerModuleUrl}?t=${Date.now()}-${Math.random()}`);
}

async function freshDiagnosticModule() {
  return import(`${diagnosticModuleUrl}?t=${Date.now()}-${Math.random()}`);
}

test("buildLogFilePath creates daily JSONL paths with safe timestamped names", async () => {
  const { buildLogFilePath } = await freshLoggerModule();
  const filePath = buildLogFilePath({
    logDir: "/tmp/contact-center-logs",
    rotationMode: "daily",
    now: new Date("2026-06-06T09:32:41.157Z"),
    runId: "20260606T093241Z-pid1234",
  });

  assert.equal(filePath, "/tmp/contact-center-logs/app-2026-06-06.jsonl");

  const perStartPath = buildLogFilePath({
    logDir: "/tmp/contact-center-logs",
    rotationMode: "startup",
    now: new Date("2026-06-06T09:32:41.157Z"),
    runId: "20260606T093241Z-pid1234",
  });

  assert.equal(
    perStartPath,
    "/tmp/contact-center-logs/app-2026-06-06T09-32-41-157Z-20260606T093241Z-pid1234.jsonl",
  );
});

test("createLogger emits pino JSON with topic, runId, and redacted sensitive fields", async () => {
  const lines = [];
  const { createLogger } = await freshLoggerModule();
  const logger = createLogger({
    topic: "telnyx.stt",
    config: {
      globalLevel: "debug",
      consoleEnabled: true,
      fileEnabled: false,
      redactionEnabled: true,
      topicLevels: { "telnyx.stt": "debug" },
      topicEnabled: { "telnyx.stt": true },
    },
    runId: "run-test",
    stdout: (line) => lines.push(line),
  });

  logger.debug({
    authorization: "test-auth-value",
    url: "https://example.com/callback?foo=bar&client_state=abc123",
    media: { payload: "base64-audio-payload" },
  }, "provider_socket_open");

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.topic, "telnyx.stt");
  assert.equal(entry.runId, "run-test");
  assert.equal(entry.level, "debug");
  assert.equal(entry.msg, "provider_socket_open");
  assert.equal(entry.authorization, "[redacted:string:15]");
  assert.doesNotMatch(entry.url, /bar|abc123/);
  assert.equal(entry.media.payload, "[redacted:string:20]");
});

test("sanitizeDiagnosticUrl redacts query, fragments, and URL userinfo", async () => {
  const { sanitizeDiagnosticUrl } = await freshLoggerModule();
  const sanitized = sanitizeDiagnosticUrl("https://user:pass123@example.com/callback?foo=bar#access_token=secret123&state=visible");

  assert.doesNotMatch(sanitized, /user|pass123|bar|secret123|visible/);
  assert.match(sanitized, /example\.com/);
  assert.match(sanitized, /foo=%5BREDACTED_PARAM%5D/);
  assert.match(sanitized, /#\[REDACTED_FRAGMENT\]/);
});

test("createLogger redacts URL userinfo and fragments even without query parameters", async () => {
  const lines = [];
  const { createLogger } = await freshLoggerModule();
  const logger = createLogger({
    topic: "app",
    config: { globalLevel: "debug", consoleEnabled: true, fileEnabled: false },
    stdout: (line) => lines.push(line),
  });

  logger.info({
    url: "https://user:pass123@example.com/callback#access_token=secret123",
    streamUrl: "/streaming/telnyx-stt#client_state=abc123",
  }, "url_no_query");

  const entry = JSON.parse(lines[0]);
  assert.doesNotMatch(entry.url, /user|pass123|secret123/);
  assert.doesNotMatch(entry.streamUrl, /abc123/);
  assert.match(entry.url, /#\[REDACTED_FRAGMENT\]/);
  assert.match(entry.streamUrl, /#\[REDACTED_FRAGMENT\]/);
});

test("createLogger redacts relative URL fragments without leading slash", async () => {
  const lines = [];
  const { createLogger } = await freshLoggerModule();
  const logger = createLogger({
    topic: "app",
    config: { globalLevel: "debug", consoleEnabled: true, fileEnabled: false },
    stdout: (line) => lines.push(line),
  });

  logger.info({
    callbackUrl: "callback/path?client_state=abc#access_token=secret123",
    href: "callback/path#state=visible",
  }, "relative_url_fragment");

  const entry = JSON.parse(lines[0]);
  assert.doesNotMatch(entry.callbackUrl, /abc|secret123/);
  assert.doesNotMatch(entry.href, /visible/);
  assert.match(entry.callbackUrl, /#\[REDACTED_FRAGMENT\]/);
  assert.match(entry.href, /#\[REDACTED_FRAGMENT\]/);
});

test("createLogger suppresses disabled topics and respects per-topic level", async () => {
  const lines = [];
  const { createLogger } = await freshLoggerModule();

  const disabled = createLogger({
    topic: "db.query",
    config: {
      globalLevel: "debug",
      consoleEnabled: true,
      fileEnabled: false,
      topicEnabled: { "db.query": false },
    },
    stdout: (line) => lines.push(line),
  });
  disabled.error({ query: "SELECT 1" }, "should_not_emit");

  const warnOnly = createLogger({
    topic: "telnyx.stt",
    config: {
      globalLevel: "debug",
      consoleEnabled: true,
      fileEnabled: false,
      topicLevels: { "telnyx.stt": "warn" },
      topicEnabled: { "telnyx.stt": true },
    },
    stdout: (line) => lines.push(line),
  });
  warnOnly.debug({}, "debug_ignored");
  warnOnly.warn({}, "warn_emitted");

  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).msg, "warn_emitted");
});

test("createLogger can write JSONL to a daily file sink", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cc-pino-logs-"));
  const { createLogger, buildLogFilePath } = await freshLoggerModule();
  const config = {
    globalLevel: "info",
    consoleEnabled: false,
    fileEnabled: true,
    logDir: dir,
    rotationMode: "daily",
    topicEnabled: { app: true },
  };
  const now = new Date("2026-06-06T09:32:41.157Z");
  const logger = createLogger({ topic: "app", config, now, runId: "run-file" });

  try {
    logger.info({ safe: "ok" }, "file_sink_test");
    await logger.flush?.();
    const filePath = buildLogFilePath({ logDir: dir, rotationMode: "daily", now, runId: "run-file" });
    const contents = await readFile(filePath, "utf8");
    const entry = JSON.parse(contents.trim());
    assert.equal(entry.topic, "app");
    assert.equal(entry.runId, "run-file");
    assert.equal(entry.msg, "file_sink_test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createLogger uses pino-pretty for console output while keeping file JSONL", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cc-pino-pretty-"));
  const lines = [];
  const { createLogger, buildLogFilePath } = await freshLoggerModule();
  const now = new Date("2026-06-06T09:32:41.157Z");
  const logger = createLogger({
    topic: "app",
    config: {
      globalLevel: "info",
      consoleEnabled: true,
      consolePretty: true,
      fileEnabled: true,
      logDir: dir,
      rotationMode: "daily",
    },
    stdout: (line) => lines.push(line),
    now,
    runId: "pretty-run",
  });

  try {
    logger.info({ safe: "ok" }, "pretty_console_test");
    await logger.flush?.();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /pretty_console_test/);
    assert.throws(() => JSON.parse(lines[0]), /Unexpected|JSON/);

    const filePath = buildLogFilePath({ logDir: dir, rotationMode: "daily", now, runId: "pretty-run" });
    const contents = await readFile(filePath, "utf8");
    const entry = JSON.parse(contents.trim());
    assert.equal(entry.msg, "pretty_console_test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createLogger protects metadata fields in payloads and child bindings", async () => {
  const lines = [];
  const { createLogger } = await freshLoggerModule();
  const logger = createLogger({
    topic: "app",
    config: { globalLevel: "debug", consoleEnabled: true, fileEnabled: false },
    stdout: (line) => lines.push(line),
    runId: "safe-run",
  }).child({ topic: "evil", runId: "evil", time: "evil", level: "fatal", msg: "evil" });

  logger.info({ topic: "payload", runId: "payload", time: "payload", level: "error", msg: "payload" }, "safe_message");

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.topic, "app");
  assert.equal(entry.runId, "safe-run");
  assert.equal(entry.level, "info");
  assert.equal(entry.msg, "safe_message");
  assert.notEqual(entry.time, "evil");
});

test("createLogger protects metadata fields even when redaction is disabled", async () => {
  const lines = [];
  const { createLogger } = await freshLoggerModule();
  const logger = createLogger({
    topic: "app",
    config: { globalLevel: "debug", consoleEnabled: true, fileEnabled: false, redactionEnabled: false },
    stdout: (line) => lines.push(line),
    runId: "safe-run",
  }).child({ topic: "evil", runId: "evil", time: "evil", level: "fatal", msg: "evil" });

  logger.info({ topic: "payload", runId: "payload", time: "payload", level: "error", msg: "payload" }, "safe_message");

  const entry = JSON.parse(lines[0]);
  assert.equal(entry.topic, "app");
  assert.equal(entry.runId, "safe-run");
  assert.equal(entry.level, "info");
  assert.equal(entry.msg, "safe_message");
});

test("createLogger bounds very deep payload sanitization so logging cannot throw", async () => {
  const lines = [];
  const { createLogger } = await freshLoggerModule();
  const logger = createLogger({
    topic: "app",
    config: { globalLevel: "debug", consoleEnabled: true, fileEnabled: false },
    stdout: (line) => lines.push(line),
  });

  let deep = { value: "end" };
  for (let i = 0; i < 2000; i += 1) deep = { child: deep };

  assert.doesNotThrow(() => logger.info({ deep, list: Array.from({ length: 500 }, (_, i) => i) }, "deep_payload"));
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.msg, "deep_payload");
  assert.equal(entry.list.length, 100);
});

test("diagnostic logger adapter uses pino foundation while preserving ts/scope/message shape", async () => {
  const lines = [];
  const { createDiagnosticLogger } = await freshDiagnosticModule();
  const logger = createDiagnosticLogger("telnyx.stt", {
    stdout: (line) => lines.push(line),
    config: {
      globalLevel: "debug",
      consoleEnabled: true,
      fileEnabled: false,
      topicEnabled: { "telnyx.stt": true },
      topicLevels: { "telnyx.stt": "debug" },
    },
    runId: "run-diag",
    now: () => new Date("2026-06-06T09:32:41.157Z"),
  });

  logger.info("media_ws_connected", { url: "/streaming?secret=abc&safe=value" });

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.scope, "telnyx.stt");
  assert.equal(entry.topic, "telnyx.stt");
  assert.equal(entry.message, "media_ws_connected");
  assert.equal(entry.msg, "media_ws_connected");
  assert.equal(entry.ts, "2026-06-06T09:32:41.157Z");
  assert.doesNotMatch(entry.url, /abc|value/);
});
