import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const instrumentationPath = new URL("../instrumentation.js", import.meta.url);
const postgresPath = new URL("../lib/postgres.mjs", import.meta.url);
const runtimeConfigPath = new URL("../lib/logger/runtime-config.mjs", import.meta.url);
const streamingHandlerPath = new URL("../lib/streaming-ws-handler.mjs", import.meta.url);

async function source(path) {
  return readFile(path, "utf8");
}

test("startup instrumentation emits application, Postgres, and streaming events through pino diagnostic loggers", async () => {
  const src = await source(instrumentationPath);

  assert.match(src, /createDiagnosticLogger/);
  assert.match(src, /bootstrapLoggingConfig/);
  assert.match(src, /fileEnabled: bootstrapFileEnabled/);
  assert.match(src, /getRuntimeLoggingConfig\(\{ forceRefresh: true \}\)/);
  assert.match(src, /loadRuntimeLoggingConfigEarly/);
  assert.match(src, /runtimeLoggingConfig = await loadRuntimeLoggingConfigEarly\(\)/);
  assert.match(src, /createDiagnosticLogger\("platform\.app", \{ config: bootstrapLoggingConfig, getConfig: \(\) => runtimeLoggingConfig \}\)/);
  assert.match(src, /createDiagnosticLogger\("platform\.app"/);
  assert.match(src, /createDiagnosticLogger\("platform\.db"/);
  assert.doesNotMatch(src, /createDiagnosticLogger\("telnyx\.streaming"/);
  assert.match(src, /application_starting/);
  assert.match(src, /Application starting on port/);
  assert.match(src, /runtime_logging_config_loaded/);
  assert.match(src, /postgres_startup_status/);
  assert.match(src, /streaming_ws_starting/);
  assert.match(src, /Streaming WS starting on port/);
  assert.match(src, /Streaming WS start requested on port/);
  assert.match(src, /application_startup_completed/);
  assert.doesNotMatch(src, /console\.(log|warn|error)\(/);
});

test("streaming WebSocket handler keeps runtime lifecycle diagnostics on telnyx.streaming", async () => {
  const src = await source(streamingHandlerPath);

  assert.match(src, /const streamingLogger = createDiagnosticLogger\("telnyx\.streaming"\)/);
  assert.match(src, /const platformLogger = createDiagnosticLogger\("platform\.app"\)/);
  assert.match(src, /streamingLogger\.warn\("streaming_ws_connection_rejected"\)/);
  assert.match(src, /streamingLogger\.error\("streaming_ws_ai_handler_load_failed"\)/);
  assert.match(src, /platformLogger\.info\("streaming_ws_listening"/);
  assert.match(src, /friendlyMessage: `Streaming WS listening on port/);
});

test("Postgres module logs pool lifecycle through pino instead of direct console calls", async () => {
  const src = await source(postgresPath);

  assert.match(src, /from "\.\/diagnostic-logger\.mjs"/);
  assert.match(src, /getCachedRuntimeLoggingConfig/);
  assert.match(src, /getDbRuntimeLoggingConfig/);
  assert.match(src, /"platform\.db": process\.env\.LOG_DB_LEVEL \|\| runtimeConfig\.topicLevels\?\.\["platform\.db"\] \|\| runtimeConfig\.topicLevels\?\.db \|\| "warn"/);
  assert.match(src, /getConfig: getDbRuntimeLoggingConfig/);
  assert.match(src, /createDiagnosticLogger\("platform\.db"/);
  assert.match(src, /postgres_pool_created/);
  assert.match(src, /postgres_connected/);
  assert.match(src, /postgres_status_check_ok/);
  assert.match(src, /postgres_status_check_failed/);
  assert.doesNotMatch(src, /console\.(log|warn|error)\(/);
});

test("runtime logging defaults create a JSONL file sink on startup unless explicitly disabled", async () => {
  const src = await source(runtimeConfigPath);

  assert.match(src, /function defaultLogDir\(\)/);
  assert.match(src, /process\.cwd\(\).*\/logs/);
  assert.match(src, /fileEnabled: true/);
  assert.match(src, /rotationMode: "daily"/);
});
