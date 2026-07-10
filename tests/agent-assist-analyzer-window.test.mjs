import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("analyzer window is widened past 12 so a 24+ slot workflow isn't starved", async () => {
  const route = await readFile(new URL("../app/api/agent-assist/workflow/analyze/route.js", import.meta.url), "utf8");
  assert.match(route, /const MAX_ANALYZER_PENDING_ITEMS = 40/);
  assert.match(route, /\.slice\(0, MAX_ANALYZER_PENDING_ITEMS\)/);
  // The old hard-coded 12-cap is gone.
  assert.doesNotMatch(route, /\.slice\(0, 12\)/);
});

test("analyzer output token budget is raised in sync with the wider window (#1210)", async () => {
  const analyzer = await readFile(new URL("../lib/agent-assist/workflow-analyzer.js", import.meta.url), "utf8");
  // Ceiling raised 4000 -> 8000 so a data-dump utterance filling many slots on
  // the widened 40-item window isn't truncated (truncation -> empty parse ->
  // lost captures). Verified safe on the models in use (analyze returns 200).
  assert.match(analyzer, /const maxTokens = Math\.min\(\s*8000,/s);
  assert.match(analyzer, /itemCount \* 150/);
  assert.doesNotMatch(analyzer, /Math\.min\(\s*4000,/s);
});
