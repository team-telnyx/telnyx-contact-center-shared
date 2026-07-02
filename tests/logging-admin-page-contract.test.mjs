import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pagePath = new URL("../app/(portal)/admin/logging/page.jsx", import.meta.url);

test("Admin Logging page includes read-only log viewer wired to backend-owned logs API", async () => {
  const source = await readFile(pagePath, "utf8");

  assert.match(source, /Log Viewer/);
  assert.match(source, /\/api\/admin\/logging\/logs\?/);
  assert.match(source, /mode: "files"/);
  assert.match(source, /logFilters/);
  assert.match(source, /level/);
  assert.match(source, /topic/);
  assert.match(source, /runId/);
  assert.match(source, /search/);
  assert.match(source, /type="datetime-local"/);
  assert.match(source, /localDateTimeToIso/);
  assert.match(source, /toISOString\(\)/);
  assert.match(source, /key === "from" \|\| key === "to"/);
  assert.match(source, /from/);
  assert.match(source, /to/);
  assert.doesNotMatch(source, /logDir.*setLogFilters/);
  assert.match(source, /safeJsonStringify\(entry\)/);
  assert.match(source, /<CodeBlock code=\{safeJsonStringify\(entry\)\} language="json"/);
  assert.doesNotMatch(source, /<pre|<details|<summary/);
});
