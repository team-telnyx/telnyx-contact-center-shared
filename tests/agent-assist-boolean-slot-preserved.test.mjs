import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("analyzer preserves falsy slot values with nullish coalescing (not ||)", async () => {
  const analyzer = await read("../lib/agent-assist/workflow-analyzer.js");
  assert.match(analyzer, /extracted_value:\s*item\.extracted_value\s*\?\?\s*null/);
  assert.doesNotMatch(analyzer, /extracted_value:\s*item\.extracted_value\s*\|\|\s*null/);
});

test("analyze route binds extracted_value with ?? null in both UPDATE statements", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const nullish = route.match(/completed\.extracted_value\s*\?\?\s*null/g) || [];
  assert.ok(nullish.length >= 2, `expected >=2 '?? null' bindings, found ${nullish.length}`);
  // The old falsy form must be gone (it nulled false/0).
  assert.doesNotMatch(route, /completed\.extracted_value\s*\|\|\s*null/);
});

test("analyze route uses hasMeaningfulExtractedValue (not truthiness) to gate slots_filled", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(
    route,
    /if \(item\?\.slot_name && hasMeaningfulExtractedValue\(completed\.extracted_value\)\)/
  );
  // The old truthiness guard would drop accompanying=false / iv_count=0.
  assert.doesNotMatch(route, /if \(item\?\.slot_name && completed\.extracted_value\)/);
});

test("hasMeaningfulExtractedValue treats false and 0 as present (documents intent)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // The helper returns true for any non-null/undefined non-empty-string value,
  // which includes boolean false and numeric 0.
  assert.match(
    route,
    /function hasMeaningfulExtractedValue\(value\) \{[\s\S]*?return true;\s*\}/
  );
});
