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
    assert.equal(stdoutEntry.message, "hello");
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

test("diagnostic logger honors LOG_LEVEL ordering and protects metadata fields", async () => {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  const lines = [];
  const { createDiagnosticLogger } = await freshLogger();
  const logger = createDiagnosticLogger("test.level", { stdout: (line) => lines.push(line) });

  logger.debug("debug ignored");
  logger.info("info ignored");
  logger.warn("warn emitted", { level: "error", message: "payload override", scope: "payload" });

  try {
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.level, "warn");
    assert.equal(entry.message, "warn emitted");
    assert.equal(entry.scope, "test.level");
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
});
