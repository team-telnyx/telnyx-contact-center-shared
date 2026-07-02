import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routePath = new URL("../app/api/admin/logging/config/route.js", import.meta.url);

test("logging config Admin API uses a positive allowlist and keeps paths backend-owned", async () => {
  const source = await readFile(routePath, "utf8");

  assert.match(source, /const allowedConfigKeys = \[[\s\S]*"enabled"[\s\S]*"consoleFriendly"[\s\S]*"topicEnabled"[\s\S]*\];/);
  assert.match(source, /if \(Object\.hasOwn\(requestedConfig, key\)\) safeConfig\[key\] = requestedConfig\[key\];/);
  assert.match(source, /safeConfig\.redactionEnabled = true/);
  assert.doesNotMatch(source, /const safeConfig = \{\s*\.\.\.requestedConfig\s*\}/);
  assert.doesNotMatch(source, /enabled: requestedConfig\.enabled/);
  assert.doesNotMatch(source, /safeConfig\.logDir\s*=/);
  assert.doesNotMatch(source, /safeConfig\.logFilePath\s*=/);
  assert.match(source, /config: safeConfig/);
});
