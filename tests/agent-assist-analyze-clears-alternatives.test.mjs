import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("FDE-535: live analyze route clears alternatives on both completed and suggested UPDATEs", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // The live analyzer re-writes value/confidence/source but does not produce
  // alternatives, so it must clear the column to avoid stale chips under a new
  // value. Expect the clear in BOTH the completed and suggested UPDATEs.
  const clears = route.match(/alternatives = NULL/g) || [];
  assert.ok(
    clears.length >= 2,
    `expected 'alternatives = NULL' in both UPDATE statements, found ${clears.length}`
  );
});

test("FDE-535: workflow-store analyzeTranscript clears stale alternatives on merge", async () => {
  const store = await read("../lib/stores/workflow-store.js");
  // The client merge preserves omitted fields, so the analyzer apply path must
  // explicitly reset alternatives (defaulting to []) to drop stale chips.
  assert.match(store, /alternatives:\s*update\.alternatives\s*\?\?\s*\[\]/);
});
