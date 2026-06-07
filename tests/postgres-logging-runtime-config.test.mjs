import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const postgresSourcePath = new URL("../lib/postgres.mjs", import.meta.url);

async function postgresSource() {
  return readFile(postgresSourcePath, "utf8");
}

test("platform.db health logging bootstraps runtime config before status checks", async () => {
  const src = await postgresSource();

  assert.match(
    src,
    /tryLoadRuntimeLoggingConfigEarly/,
    "platform.db logger should be able to load DB-backed runtime logging config in cold workers",
  );
  assert.match(
    src,
    /await\s+ensureDbRuntimeLoggingConfig\(\);[\s\S]*?const pool = getPostgresPool\(\);/,
    "checkPostgresStatus must load runtime logging config before emitting pool/status logs",
  );
});

test("platform.db bootstrap fallback does not force info logs when runtime config is missing", async () => {
  const src = await postgresSource();

  assert.doesNotMatch(
    src,
    /topicEnabled:\s*\{\s*["']platform\.db["']:\s*true\s*\}/,
    "platform.db logger must not force-enable the topic outside runtime settings",
  );
  assert.match(
    src,
    /topicLevels:\s*\{\s*["']platform\.db["']:\s*process\.env\.LOG_DB_LEVEL\s*\|\|\s*["']warn["']\s*\}/,
    "platform.db fallback should be warn so health-check info noise is suppressed until runtime config is loaded",
  );
  assert.match(
    src,
    /consoleFriendly:\s*envFlagEnabled\(["']LOG_CONSOLE_FRIENDLY["']\)/,
    "platform.db fallback console format should include the same friendly flag as other diagnostic loggers",
  );
});
