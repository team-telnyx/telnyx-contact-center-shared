import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routePath = new URL("../app/api/admin/logging/logs/route.js", import.meta.url);

test("logging logs Admin API uses backend-owned logDir and no-store admin guard", async () => {
  const source = await readFile(routePath, "utf8");

  assert.match(source, /const config = await getRuntimeLoggingConfig\(\{ forceRefresh: true \}\)/);
  assert.match(source, /const logDir = config\.logDir/);
  assert.doesNotMatch(source, /queryParam\(request, "logDir"\)/);
  assert.doesNotMatch(source, /searchParams\.get\("logDir"\)/);
  assert.doesNotMatch(source, /return noStore\(\{ ok: true,[^}]*logDir/);
  assert.match(source, /Invalid \.\* timestamp/);
  assert.match(source, /isClientError \? message : "Failed to read logs"/);
  // Admin access is enforced by the permission guard, whose 401/403 responses carry Cache-Control: no-store.
  assert.match(source, /export const GET = withPermission\("logging:read", GET_handler, \{ route:/);
  assert.match(source, /Cache-Control": "no-store"/);
});
