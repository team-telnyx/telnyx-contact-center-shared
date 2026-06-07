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
    plainBearer: `Bearer ${"A".repeat(30)}`,
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
  assert.equal(entry.plainBearer, "[redacted:string:37]");
  assert.doesNotMatch(entry.url, /bar|abc123/);
  assert.equal(entry.media.payload, "[redacted:string:20]");
});

test("createLogger keeps safe contact-center debug identifiers visible while redacting secrets", async () => {
  const lines = [];
  const { createLogger } = await freshLoggerModule();
  const logger = createLogger({
    topic: "contact-center.timeout",
    config: {
      globalLevel: "debug",
      consoleEnabled: true,
      fileEnabled: false,
      redactionEnabled: true,
      topicLevels: { "contact-center.timeout": "debug" },
      topicEnabled: { "contact-center.timeout": true },
    },
    runId: "20260607T090159Z-pid123456789",
    stdout: (line) => lines.push(line),
  });

  logger.info({
    interactionId: "9a9d4b18-9999-4a53-8b0a-72d16f2b2c01",
    callSessionId: "6f8d3a6f-1111-4425-a333-7bba1d5e0a22",
    callControlId: "v3:qxbH4PrvSxNeSbuqSOUPGoee36yCcHj3jKDWBi1e9e0vaMchp74P_w",
    queueId: "7a5c2e0b-2222-4a2e-9f4f-01cc2ed4c912",
    agentUserId: "44df75d9-3333-45b1-91ea-08d3ab39f761",
    authorization: "Bearer secret-token-value",
    clientState: "eyJzdGlsbCI6InNlY3JldCJ9",
  }, "agent_answer_timeout_reenqueue_completed");

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.topic, "contact-center.timeout");
  assert.equal(entry.runId, "20260607T090159Z-pid123456789");
  assert.equal(entry.interactionId, "9a9d4b18-9999-4a53-8b0a-72d16f2b2c01");
  assert.equal(entry.callSessionId, "6f8d3a6f-1111-4425-a333-7bba1d5e0a22");
  assert.equal(entry.callControlId, "v3:qxbH4PrvSxNeSbuqSOUPGoee36yCcHj3jKDWBi1e9e0vaMchp74P_w");
  assert.equal(entry.queueId, "7a5c2e0b-2222-4a2e-9f4f-01cc2ed4c912");
  assert.equal(entry.agentUserId, "44df75d9-3333-45b1-91ea-08d3ab39f761");
  assert.match(entry.authorization, /^\[redacted:/);
  assert.match(entry.clientState, /^\[redacted:/);
});

test("createLogger computes default timestamps for each emitted entry", async () => {
  const lines = [];
  const { createLogger } = await freshLoggerModule();
  const logger = createLogger({
    topic: "app",
    config: { globalLevel: "debug", consoleEnabled: true, fileEnabled: false },
    stdout: (line) => lines.push(line),
  });

  logger.info({}, "first_entry");
  await new Promise((resolve) => setTimeout(resolve, 5));
  logger.info({}, "second_entry");

  assert.equal(lines.length, 2);
  assert.notEqual(JSON.parse(lines[0]).time, JSON.parse(lines[1]).time);
});

test("createLogger redacts bearer-keyed credentials", async () => {
  const lines = [];
  const { createLogger } = await freshLoggerModule();
  const logger = createLogger({
    topic: "app",
    config: { globalLevel: "debug", consoleEnabled: true, fileEnabled: false },
    stdout: (line) => lines.push(line),
  });

  logger.info({ bearer: "short-lived-secret" }, "bearer_redaction");

  assert.equal(JSON.parse(lines[0]).bearer, "[redacted:string:18]");
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

test("renderStructuredLogLineForConsole maps numeric pino levels before filtering and friendly rendering", async () => {
  const { renderStructuredLogLineForConsole } = await freshLoggerModule();
  const line = JSON.stringify({
    level: 50,
    topic: "telnyx.streaming",
    msg: "child_worker_error",
    time: "2026-06-07T12:00:00.000Z",
  });

  const friendly = renderStructuredLogLineForConsole(line, {
    globalLevel: "error",
    consoleEnabled: true,
    consoleFriendly: true,
  });
  assert.match(friendly, /ERROR: Child worker error/);

  const filtered = renderStructuredLogLineForConsole(line, {
    globalLevel: "fatal",
    consoleEnabled: true,
  });
  assert.equal(filtered, null);
});

test("createLogger can apply runtime topic config without recreating logger", async () => {
  const lines = [];
  const { createLogger } = await freshLoggerModule();
  let runtimeConfig = {
    globalLevel: "info",
    consoleEnabled: true,
    fileEnabled: false,
    topicLevels: { "telnyx.stt": "warn" },
    topicEnabled: { "telnyx.stt": true },
  };
  const logger = createLogger({
    topic: "telnyx.stt",
    config: { consoleEnabled: true, fileEnabled: false },
    getConfig: () => runtimeConfig,
    stdout: (line) => lines.push(line),
  });

  logger.debug({}, "debug_ignored_before_runtime_update");
  runtimeConfig = {
    ...runtimeConfig,
    topicLevels: { "telnyx.stt": "debug" },
  };
  logger.debug({}, "debug_emitted_after_runtime_update");
  runtimeConfig = {
    ...runtimeConfig,
    topicEnabled: { "telnyx.stt": false },
  };
  logger.error({}, "error_ignored_after_topic_disabled");

  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).msg, "debug_emitted_after_runtime_update");
});

test("createLogger can apply runtime file sink config without recreating logger", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cc-pino-runtime-file-"));
  const { createLogger, buildLogFilePath } = await freshLoggerModule();
  const now = new Date("2026-06-06T09:32:41.157Z");
  let runtimeConfig = {
    globalLevel: "debug",
    consoleEnabled: false,
    fileEnabled: false,
    logDir: dir,
    rotationMode: "daily",
  };
  const logger = createLogger({
    topic: "app",
    config: { consoleEnabled: false, fileEnabled: false },
    getConfig: () => runtimeConfig,
    now,
    runId: "runtime-file",
  });

  try {
    logger.info({}, "not_written_before_file_enabled");
    runtimeConfig = { ...runtimeConfig, fileEnabled: true };
    logger.info({}, "written_after_file_enabled");
    await logger.flush?.();
    const filePath = buildLogFilePath({ logDir: dir, rotationMode: "daily", now, runId: "runtime-file" });
    const contents = await readFile(filePath, "utf8");
    assert.doesNotMatch(contents, /not_written_before_file_enabled/);
    assert.match(contents, /written_after_file_enabled/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});



test("runtime daily file sink ignores legacy LOG_FILE_PATH diagnostics override", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cc-pino-runtime-daily-"));
  const previous = process.env.LOG_FILE_PATH;
  const diagnosticsPath = path.join(dir, "diagnostics.jsonl");
  process.env.LOG_FILE_PATH = diagnosticsPath;

  try {
    const { createLogger, buildLogFilePath } = await freshLoggerModule();
    const now = new Date("2026-06-06T10:11:12.000Z");
    const runtimeConfig = {
      globalLevel: "debug",
      consoleEnabled: false,
      fileEnabled: true,
      logDir: dir,
      rotationMode: "daily",
    };
    const logger = createLogger({
      topic: "app",
      config: { consoleEnabled: false },
      getConfig: () => runtimeConfig,
      now,
      runId: "runtime-daily-overrides-legacy-path",
    });

    logger.info({}, "runtime_daily_file_sink_entry");
    await logger.flush?.();

    const dailyPath = buildLogFilePath({ logDir: dir, rotationMode: "daily", now, runId: "runtime-daily-overrides-legacy-path" });
    const contents = await readFile(dailyPath, "utf8");
    assert.match(contents, /runtime_daily_file_sink_entry/);
    await assert.rejects(readFile(diagnosticsPath, "utf8"), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.LOG_FILE_PATH;
    else process.env.LOG_FILE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
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
    assert.equal(entry.topic, "platform.app");
    assert.equal(entry.runId, "run-file");
    assert.equal(entry.msg, "file_sink_test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createLogger writes human-readable message alongside technical msg in JSONL files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cc-pino-friendly-message-"));
  const { createLogger, buildLogFilePath } = await freshLoggerModule();
  const now = new Date("2026-06-06T09:32:41.157Z");
  const logger = createLogger({
    topic: "streaming.ws",
    config: {
      globalLevel: "info",
      consoleEnabled: false,
      fileEnabled: true,
      logDir: dir,
      rotationMode: "daily",
    },
    now,
    runId: "friendly-message-run",
  });

  try {
    logger.info({}, "streaming_ws_routes_ready");
    await logger.flush?.();
    const filePath = buildLogFilePath({ logDir: dir, rotationMode: "daily", now, runId: "friendly-message-run" });
    const contents = await readFile(filePath, "utf8");
    const entry = JSON.parse(contents.trim());
    assert.equal(entry.msg, "streaming_ws_routes_ready");
    assert.equal(entry.message, "Streaming WS routes ready");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createLogger preserves explicit friendly messages separately from metadata message", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cc-pino-explicit-message-"));
  const { createLogger, buildLogFilePath } = await freshLoggerModule();
  const now = new Date("2026-06-06T09:32:41.157Z");
  const logger = createLogger({
    topic: "app",
    config: {
      globalLevel: "info",
      consoleEnabled: false,
      fileEnabled: true,
      logDir: dir,
      rotationMode: "daily",
    },
    now,
    runId: "explicit-message-run",
  });

  try {
    logger.info({ message: "upstream payload body", friendlyMessage: "Streaming WS starting on port 3001" }, "streaming_ws_starting");
    await logger.flush?.();
    const filePath = buildLogFilePath({ logDir: dir, rotationMode: "daily", now, runId: "explicit-message-run" });
    const contents = await readFile(filePath, "utf8");
    const entry = JSON.parse(contents.trim());
    assert.equal(entry.msg, "streaming_ws_starting");
    assert.equal(entry.message, "upstream payload body");
    assert.equal(entry.friendlyMessage, "Streaming WS starting on port 3001");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createLogger rotates daily file sinks after midnight", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cc-pino-daily-rotation-"));
  const { createLogger, buildLogFilePath } = await freshLoggerModule();
  let currentTime = new Date("2026-06-06T23:59:59.900Z");
  const logger = createLogger({
    topic: "app",
    config: {
      globalLevel: "info",
      consoleEnabled: false,
      fileEnabled: true,
      logDir: dir,
      rotationMode: "daily",
    },
    now: () => currentTime,
    runId: "daily-run",
  });

  try {
    logger.info({}, "before_midnight");
    currentTime = new Date("2026-06-07T00:00:00.100Z");
    logger.info({}, "after_midnight");
    await logger.flush?.();

    const firstPath = buildLogFilePath({ logDir: dir, rotationMode: "daily", now: new Date("2026-06-06T23:59:59.900Z"), runId: "daily-run" });
    const secondPath = buildLogFilePath({ logDir: dir, rotationMode: "daily", now: new Date("2026-06-07T00:00:00.100Z"), runId: "daily-run" });
    assert.match(await readFile(firstPath, "utf8"), /before_midnight/);
    assert.match(await readFile(secondPath, "utf8"), /after_midnight/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diagnostic logger keeps daily rotation tied to live adapter time", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cc-diagnostic-daily-rotation-"));
  const { createDiagnosticLogger } = await freshDiagnosticModule();
  let currentTime = new Date("2026-06-06T23:59:59.900Z");
  const logger = createDiagnosticLogger("test.scope", {
    stdout: () => {},
    now: () => currentTime,
    runId: "diagnostic-daily-run",
    config: {
      globalLevel: "info",
      consoleEnabled: false,
      fileEnabled: true,
      logDir: dir,
      rotationMode: "daily",
      topicEnabled: { "test.scope": true },
    },
  });

  try {
    logger.info("before_midnight");
    currentTime = new Date("2026-06-07T00:00:00.100Z");
    logger.info("after_midnight");

    const firstContents = await readFile(path.join(dir, "app-2026-06-06.jsonl"), "utf8");
    const secondContents = await readFile(path.join(dir, "app-2026-06-07.jsonl"), "utf8");
    assert.match(firstContents, /before_midnight/);
    assert.match(secondContents, /after_midnight/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createLogger can use simplified friendly pino-pretty console output while keeping file JSONL", async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "UTC";
  const dir = await mkdtemp(path.join(os.tmpdir(), "cc-pino-friendly-"));
  const lines = [];
  const { createLogger, buildLogFilePath } = await freshLoggerModule();
  const now = new Date("2026-06-06T09:32:41.157Z");
  const logger = createLogger({
    topic: "app",
    config: {
      globalLevel: "info",
      consoleEnabled: true,
      consolePretty: true,
      consoleFriendly: true,
      fileEnabled: true,
      logDir: dir,
      rotationMode: "daily",
    },
    stdout: (line) => lines.push(line),
    now,
    runId: "friendly-run",
  });

  try {
    logger.info({ safe: "ok", interactionId: "ix-1" }, "friendly_console_test");
    await logger.flush?.();
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "[09:32:41.157] INFO: Friendly console test");
    assert.doesNotMatch(lines[0], /friendly-run|pid\d+|\{"level"/);
    assert.doesNotMatch(lines[0], /"interactionId"/);
    assert.throws(() => JSON.parse(lines[0]), /Unexpected|JSON/);

    const filePath = buildLogFilePath({ logDir: dir, rotationMode: "daily", now, runId: "friendly-run" });
    const contents = await readFile(filePath, "utf8");
    const entry = JSON.parse(contents.trim());
    assert.equal(entry.msg, "friendly_console_test");
    assert.equal(entry.interactionId, "ix-1");
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
    await rm(dir, { recursive: true, force: true });
  }
});

test("friendly console works without pretty mode as plain one-line output", async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "UTC";
  const lines = [];
  const { createLogger } = await freshLoggerModule();
  const logger = createLogger({
    topic: "app",
    config: {
      globalLevel: "info",
      consoleEnabled: true,
      consolePretty: false,
      consoleFriendly: true,
      fileEnabled: false,
    },
    stdout: (line) => lines.push(line),
    now: new Date("2026-06-06T14:00:38.407Z"),
    runId: "plain-friendly-run",
  });

  try {
    logger.info("ghost_call_cleanup_completed");

    assert.deepEqual(lines, ["[14:00:38.407] INFO: Ghost call cleanup completed"]);
    assert.doesNotMatch(lines[0], /plain-friendly-run|\{"level"/);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test("renderStructuredLogLineForConsole reformats child-process JSON logs using parent runtime config", async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "UTC";
  const { renderStructuredLogLineForConsole } = await freshLoggerModule();
  const childLine = JSON.stringify({
    level: "info",
    time: "2026-06-07T18:36:45.847Z",
    topic: "telnyx.stt",
    runId: "child-run",
    callControlId: "v3:visible-debug-id",
    msg: "provider_socket_open",
  });

  try {
    const rendered = renderStructuredLogLineForConsole(childLine, {
      globalLevel: "info",
      consoleEnabled: true,
      consolePretty: true,
      consoleFriendly: true,
      fileEnabled: false,
      topicEnabled: { "telnyx.stt": true },
      topicLevels: { "telnyx.stt": "info" },
    });

    assert.equal(rendered, "[18:36:45.847] \u001b[32mINFO\u001b[0m: Provider socket open");
    assert.doesNotMatch(rendered, /\{"level"|child-run|callControlId/);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test("renderStructuredLogLineForConsole suppresses child-process JSON logs for disabled topics", async () => {
  const { renderStructuredLogLineForConsole } = await freshLoggerModule();
  const childLine = JSON.stringify({
    level: "error",
    time: "2026-06-07T18:36:45.847Z",
    topic: "agent-assist.workflow",
    msg: "workflow_session_started",
  });

  const rendered = renderStructuredLogLineForConsole(childLine, {
    globalLevel: "debug",
    consoleEnabled: true,
    consoleFriendly: true,
    fileEnabled: false,
    topicEnabled: { "agent-assist.workflow": false },
  });

  assert.equal(rendered, null);
});

test("renderStructuredLogLineForConsole leaves non-structured child lines untouched", async () => {
  const { renderStructuredLogLineForConsole } = await freshLoggerModule();

  assert.equal(renderStructuredLogLineForConsole("plain next output", { consoleFriendly: true }), undefined);
  assert.equal(renderStructuredLogLineForConsole(JSON.stringify({ level: "info", msg: "missing_topic" }), { consoleFriendly: true }), undefined);
});

test("friendly console timestamps use the local process timezone", async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "Europe/Warsaw";
  const { buildFriendlyConsoleLine } = await freshLoggerModule();

  try {
    const line = buildFriendlyConsoleLine({
      time: "2026-06-06T14:00:38.407Z",
      level: "info",
      msg: "local_console_time",
    });

    assert.equal(line, "[16:00:38.407] INFO: Local console time");
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test("friendly console pretty mode colorizes the user-friendly line", async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "UTC";
  const { buildFriendlyConsoleLine } = await freshLoggerModule();
  try {
    const line = buildFriendlyConsoleLine({ time: "2026-06-06T14:00:38.407Z", level: "info", msg: "streaming_ws_routes_ready" }, { colorize: true });

    assert.match(line, /^\[14:00:38\.407\] \u001b\[[0-9;]+mINFO\u001b\[[0-9;]+m: Streaming WS routes ready$/);
    assert.doesNotMatch(line, /runId|streaming_ws_routes_ready/);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
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
  assert.equal(entry.topic, "platform.app");
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
  assert.equal(entry.topic, "platform.app");
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
  assert.equal(entry.message, "Media WS connected");
  assert.equal(entry.msg, "media_ws_connected");
  assert.equal(entry.ts, "2026-06-06T09:32:41.157Z");
  assert.doesNotMatch(entry.url, /abc|value/);
});
