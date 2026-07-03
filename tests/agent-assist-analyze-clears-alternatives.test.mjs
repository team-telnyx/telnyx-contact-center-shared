import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("live analyze route: completed branch clears alternatives; suggested branch persists them", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // Contract after live-alternatives: a COMPLETED (confident) slot has no chips,
  // so it still clears (alternatives = NULL). A SUGGESTED (low-confidence) slot
  // now PERSISTS the analyzer's alternatives (= $7::jsonb; null when empty, which
  // also clears any stale value) so the agent-desktop chips can render.
  assert.match(route, /alternatives = NULL/, "completed branch still clears alternatives");
  assert.match(route, /alternatives = \$7::jsonb/, "suggested branch persists alternatives");
  // The old behavior (both branches hardcoded NULL) must be gone.
  const nullClears = route.match(/alternatives = NULL/g) || [];
  assert.equal(nullClears.length, 1, "only the completed branch hardcodes NULL now");
});

test("FDE-535: workflow-store analyzeTranscript clears stale alternatives on merge", async () => {
  const store = await read("../lib/stores/workflow-store.js");
  // The client merge preserves omitted fields, so the analyzer apply path must
  // explicitly reset alternatives (defaulting to []) to drop stale chips.
  assert.match(store, /alternatives:\s*update\.alternatives\s*\?\?\s*\[\]/);
});
