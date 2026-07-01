import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("FDE-534: analyze route returns source_text on both completed and suggested updates", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // Both updates.push(...) blocks must carry source_text so the client can jump.
  const matches = route.match(/source_text:\s*completed\.source_text/g) || [];
  assert.ok(
    matches.length >= 2,
    `expected source_text on both update objects, found ${matches.length}`
  );
});

test("FDE-534: workflow-store analyzeTranscript copies update.source_text into source_transcript", async () => {
  const store = await read("../lib/stores/workflow-store.js");
  // The live analyzer apply path must populate source_transcript so
  // status.source_transcript is set (enabling click-to-jump) without a refetch.
  assert.match(store, /source_transcript:\s*update\.source_text/);
});
