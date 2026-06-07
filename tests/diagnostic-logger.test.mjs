import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const modulePath = new URL("../lib/diagnostic-logger.mjs", import.meta.url).href;

async function freshLogger() {
  return import(`${modulePath}?t=${Date.now()}-${Math.random()}`);
}

test("sanitizeDiagnosticPayload redacts secret-like keys and media payloads", async () => {
  const { sanitizeDiagnosticPayload } = await freshLogger();

  const sanitized = sanitizeDiagnosticPayload({
    authorization: "test-auth-value",
    token: "abc123456789",
    nested: {
      api_key: "KEY-1234567890",
      payload: "base64-audio-payload",
      audio: Buffer.from("secret audio"),
      safe: "hello",
    },
  });

  assert.equal(sanitized.authorization, "[redacted:string:15]");
  assert.equal(sanitized.token, "[redacted:string:12]");
  assert.equal(sanitized.nested.api_key, "[redacted:string:14]");
  assert.equal(sanitized.nested.payload, "[redacted:string:20]");
  assert.equal(sanitized.nested.audio, "[redacted:buffer:12]");
  assert.equal(sanitized.nested.safe, "hello");
});

test("sanitizeDiagnosticPayload preserves safe call debug identifiers", async () => {
  const { sanitizeDiagnosticPayload } = await freshLogger();

  const sanitized = sanitizeDiagnosticPayload({
    topic: "contact-center.timeout",
    interactionId: "9a9d4b18-9999-4a53-8b0a-72d16f2b2c01",
    callSessionId: "6f8d3a6f-1111-4425-a333-7bba1d5e0a22",
    callControlId: "v3:qxbH4PrvSxNeSbuqSOUPGoee36yCcHj3jKDWBi1e9e0vaMchp74P_w",
    queueId: "7a5c2e0b-2222-4a2e-9f4f-01cc2ed4c912",
    agentUserId: "44df75d9-3333-45b1-91ea-08d3ab39f761",
    flowId: "f7f0b84f-1111-4f6e-965a-95e14e9b53c6",
    flow_id: "f7f0b84f-2222-4f6e-965a-95e14e9b53c6",
    streamId: "stream-12345678901234567890",
    commandId: "cmd-12345678901234567890",
    runId: "20260607T090159Z-pid123456789",
    nested: {
      authorization: "Bearer secret-token-value",
      clientState: "eyJzdGlsbCI6InNlY3JldCJ9",
    },
  });

  assert.equal(sanitized.interactionId, "9a9d4b18-9999-4a53-8b0a-72d16f2b2c01");
  assert.equal(sanitized.callSessionId, "6f8d3a6f-1111-4425-a333-7bba1d5e0a22");
  assert.equal(sanitized.callControlId, "v3:qxbH4PrvSxNeSbuqSOUPGoee36yCcHj3jKDWBi1e9e0vaMchp74P_w");
  assert.equal(sanitized.queueId, "7a5c2e0b-2222-4a2e-9f4f-01cc2ed4c912");
  assert.equal(sanitized.agentUserId, "44df75d9-3333-45b1-91ea-08d3ab39f761");
  assert.equal(sanitized.flowId, "f7f0b84f-1111-4f6e-965a-95e14e9b53c6");
  assert.equal(sanitized.flow_id, "f7f0b84f-2222-4f6e-965a-95e14e9b53c6");
  assert.equal(sanitized.streamId, "stream-12345678901234567890");
  assert.equal(sanitized.commandId, "cmd-12345678901234567890");
  assert.equal(sanitized.runId, "20260607T090159Z-pid123456789");
  assert.match(sanitized.nested.authorization, /^\[redacted:/);
  assert.match(sanitized.nested.clientState, /^\[redacted:/);
});

test("sanitizeDiagnosticUrl redacts all query values and sensitive query keys", async () => {
  const { sanitizeDiagnosticPayload, sanitizeDiagnosticUrl } = await freshLogger();

  const url = "/streaming/telnyx-stt?secret=super-secret&client_state=eyJmb28iOiJiYXIifQ&safe=value";
  const sanitizedUrl = sanitizeDiagnosticUrl(url);
  assert.equal(
    sanitizedUrl,
    "/streaming/telnyx-stt?secret=%5BREDACTED%5D&client_state=%5BREDACTED%5D&safe=%5BREDACTED_PARAM%5D",
  );
  assert.doesNotMatch(sanitizedUrl, /super-secret|eyJmb28i|value/);

  const sanitizedEmbedded = sanitizeDiagnosticPayload(
    `bad request for ${url}`,
  );
  assert.doesNotMatch(sanitizedEmbedded, /super-secret|eyJmb28i|value/);
  assert.match(sanitizedEmbedded, /\[REDACTED\]|%5BREDACTED%5D/);

  const genericUrl = sanitizeDiagnosticPayload({
    url: "https://example.com/path?foo=bar&baz=qux",
  }).url;
  assert.doesNotMatch(genericUrl, /bar|qux/);
  assert.match(genericUrl, /foo=%5BREDACTED_PARAM%5D/);
});

test("createDiagnosticLogger writes JSON lines to stdout and optional file sink", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cc-logs-"));
  const filePath = path.join(dir, "diagnostics.jsonl");
  const previous = process.env.LOG_FILE_PATH;
  process.env.LOG_FILE_PATH = filePath;

  const lines = [];
  const { createDiagnosticLogger } = await freshLogger();
  const logger = createDiagnosticLogger("test.scope", {
    stdout: (line) => lines.push(line),
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  });

  logger.info("hello", { token: "secret-token", count: 2 });

  try {
    assert.equal(lines.length, 1);
    const stdoutEntry = JSON.parse(lines[0]);
    assert.equal(stdoutEntry.scope, "test.scope");
    assert.equal(stdoutEntry.level, "info");
    assert.equal(stdoutEntry.message, "Hello");
    assert.equal(stdoutEntry.msg, "hello");
    assert.equal(stdoutEntry.count, 2);
    assert.equal(stdoutEntry.token, "[redacted:string:12]");

    const file = await readFile(filePath, "utf8");
    const fileEntry = JSON.parse(file.trim());
    assert.deepEqual(fileEntry, stdoutEntry);
  } finally {
    if (previous === undefined) delete process.env.LOG_FILE_PATH;
    else process.env.LOG_FILE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("diagnostic logger honors LOG_FILE_ENABLED and LOG_DIR without LOG_FILE_PATH", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cc-logs-dir-"));
  const previousEnabled = process.env.LOG_FILE_ENABLED;
  const previousDir = process.env.LOG_DIR;
  const previousPath = process.env.LOG_FILE_PATH;
  process.env.LOG_FILE_ENABLED = "true";
  process.env.LOG_DIR = dir;
  delete process.env.LOG_FILE_PATH;

  const { createDiagnosticLogger } = await freshLogger();
  const logger = createDiagnosticLogger("test.scope", {
    stdout: () => {},
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    runId: "test-run",
  });

  try {
    logger.info("hello_dir_sink", { count: 3 });
    const filePath = path.join(dir, "app-2026-06-06.jsonl");
    const file = await readFile(filePath, "utf8");
    const fileEntry = JSON.parse(file.trim());
    assert.equal(fileEntry.scope, "test.scope");
    assert.equal(fileEntry.message, "Hello dir sink");
    assert.equal(fileEntry.msg, "hello_dir_sink");
    assert.equal(fileEntry.count, 3);
  } finally {
    if (previousEnabled === undefined) delete process.env.LOG_FILE_ENABLED;
    else process.env.LOG_FILE_ENABLED = previousEnabled;
    if (previousDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = previousDir;
    if (previousPath === undefined) delete process.env.LOG_FILE_PATH;
    else process.env.LOG_FILE_PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("diagnostic logger honors LOG_LEVEL ordering and protects metadata fields", async () => {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  const lines = [];
  const { createDiagnosticLogger } = await freshLogger();
  const logger = createDiagnosticLogger("test.level", { stdout: (line) => lines.push(line) });

  logger.debug("debug ignored");
  logger.info("info ignored");
  logger.warn("warn emitted", { level: "error", message: "payload metadata", friendlyMessage: "Payload friendly text", scope: "payload" });

  try {
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.level, "warn");
    assert.equal(entry.message, "payload metadata");
    assert.equal(entry.friendlyMessage, "Payload friendly text");
    assert.equal(entry.msg, "warn emitted");
    assert.equal(entry.scope, "test.level");
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
});


test("diagnostic logger uses cached runtime consolePretty before first startup log", async () => {
  const { createDiagnosticLogger } = await import("../lib/diagnostic-logger.mjs");
  const { setCachedRuntimeLoggingConfig, resetRuntimeLoggingConfigCache } = await import("../lib/logger/runtime-config.mjs");
  resetRuntimeLoggingConfigCache();
  const lines = [];
  try {
    setCachedRuntimeLoggingConfig({ consoleEnabled: true, consolePretty: true, fileEnabled: false });
    const logger = createDiagnosticLogger("app", { stdout: (line) => lines.push(line) });
    logger.info("cached_pretty_probe", { ok: true });
    assert.match(lines.join("\n"), /INFO: cached_pretty_probe/);
    assert.doesNotMatch(lines.join("\n"), /^\{"level":"info"/);
  } finally {
    resetRuntimeLoggingConfigCache();
  }
});
