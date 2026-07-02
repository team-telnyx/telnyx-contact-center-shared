import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeTopics = [
  "telnyx.streaming",
  "telnyx.media",
  "telnyx.stt",
  "agent-assist.workflow",
  "contact-center.interactions",
  "platform.db",
];

test("every runtime diagnostic logger follows cached friendly console and topic enabled settings", async () => {
  const { createDiagnosticLogger } = await import("../lib/diagnostic-logger.mjs");
  const { setCachedRuntimeLoggingConfig, resetRuntimeLoggingConfigCache } = await import("../lib/logger/runtime-config.mjs");
  resetRuntimeLoggingConfigCache();

  try {
    for (const topic of runtimeTopics) {
      const lines = [];
      const logger = createDiagnosticLogger(topic, {
        stdout: (line) => lines.push(line),
        now: () => new Date("2026-06-07T17:59:24.819Z"),
      });

      setCachedRuntimeLoggingConfig({
        enabled: true,
        globalLevel: "info",
        consoleEnabled: true,
        consolePretty: true,
        consoleFriendly: true,
        fileEnabled: false,
        topicEnabled: { [topic]: false },
        topicLevels: { [topic]: "trace" },
      });
      logger.error("disabled_topic_must_not_emit", { topicProbe: topic });
      assert.equal(lines.length, 0, `${topic} ignored topicEnabled=false`);

      setCachedRuntimeLoggingConfig({
        enabled: true,
        globalLevel: "info",
        consoleEnabled: true,
        consolePretty: true,
        consoleFriendly: true,
        fileEnabled: false,
        topicEnabled: { [topic]: true },
        topicLevels: { [topic]: "info" },
      });
      logger.info("friendly_probe_event", { topicProbe: topic });
      assert.equal(lines.length, 1, `${topic} emitted after topic re-enabled`);
      assert.match(lines[0], /^\[\d{2}:\d{2}:\d{2}\.819\] INFO: Friendly probe event$/, `${topic} uses friendly console`);
      assert.doesNotMatch(lines[0], /^\{"level":"info"/, `${topic} must not print raw JSON to friendly console`);
      resetRuntimeLoggingConfigCache();
    }
  } finally {
    resetRuntimeLoggingConfigCache();
  }
});

test("runtime/server logger modules must not instantiate topic-specific direct createLogger bypasses", async () => {
  const filesToAllow = new Set([
    "lib/logger/index.mjs",
    "lib/diagnostic-logger.mjs",
  ]);
  const tracked = [
    "lib/postgres.mjs",
    "lib/runtime-logging.mjs",
    "lib/telnyx-stt-handler.mjs",
    "lib/streaming-ws-handler.mjs",
    "lib/agent-assist/logging.mjs",
    "lib/contact-center/logging.mjs",
    "lib/voice/logging.mjs",
    "lib/outbound-dialer/logging.mjs",
    "lib/security-logging.mjs",
    "lib/telnyx-ai-logging.mjs",
  ];
  for (const file of tracked) {
    const src = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    if (!filesToAllow.has(file)) {
      assert.doesNotMatch(src, /\bcreateLogger\s*\(/, `${file} must use createDiagnosticLogger/runtime adapters, not createLogger directly`);
    }
  }
});

test("Postgres logger does not keep its own createLogger fallback bypass", async () => {
  const src = await readFile(new URL("../lib/postgres.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bcreateLogger\s*\(/, "platform.db must use the same createDiagnosticLogger path as all other topics");
  assert.doesNotMatch(src, /topicEnabled:\s*\{\s*["']platform\.db["']:/, "platform.db must not force-enable its topic in local fallback config");
});
