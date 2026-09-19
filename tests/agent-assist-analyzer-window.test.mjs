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

test("analyzer output token budget scales with the window and stays bounded", async () => {
  const analyzer = await readFile(new URL("../lib/agent-assist/workflow-analyzer.js", import.meta.url), "utf8");
  // #1210 raised the ceiling to 8000 to avoid truncating a data-dump
  // utterance. Latency work (#1365) deliberately superseded that: the budget
  // is now bounded so a reasoning-capable model cannot spend tens of seconds
  // filling a multi-thousand-token allowance. Two properties must survive: the
  // budget still grows with the number of items and slots, and it is capped by
  // a configurable ceiling rather than a hard-coded constant.
  const formula = analyzer.match(/const maxTokens = Math\.min\([^;]+;/);
  assert.ok(formula, "the output budget must be computed, not fixed");
  assert.match(formula[0], /itemCount \* \d+/, "budget grows with the item count");
  assert.match(formula[0], /slotCount \* \d+/, "budget grows with the slot count");
  assert.match(formula[0], /Math\.max\(\s*512/, "a floor keeps small batches usable");
  assert.match(formula[0], /outputCap/, "the ceiling is the configurable cap");

  // The cap itself is validated, so a stored configuration cannot uncap it.
  const cap = analyzer.match(/const outputCap =[\s\S]{0,200}?;/);
  assert.ok(cap, "the ceiling must be derived from a validated configuration");
  assert.match(cap[0], /Number\.isInteger\(maxOutputTokens\)/);
  assert.match(cap[0], /maxOutputTokens >= 512/);
});
