import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("suggested responses cards stay contained inside the right panel", async () => {
  const ui = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  assert.match(ui, /className="flex gap-4 flex-1 min-h-0 min-w-0 overflow-hidden"/);
  assert.match(ui, /className="flex-1 basis-0 min-w-0 flex flex-col overflow-hidden border border-border"/);
  assert.doesNotMatch(ui, /className="w-1\/3 flex flex-col overflow-hidden border-2 border-border"/);
  assert.match(ui, /ScrollArea className="h-full overflow-x-hidden"/);
  assert.match(ui, /className="px-3 py-3 space-y-3 max-w-full min-w-0 overflow-x-hidden"/);
  assert.match(ui, /group w-full max-w-full min-w-0 box-border overflow-hidden/);
  assert.match(ui, /flex flex-wrap items-center gap-1\.5 mb-2 min-w-0 max-w-full overflow-hidden/);
  assert.match(ui, /max-w-full min-w-0 overflow-hidden truncate/);
  assert.match(ui, /break-words/);
});
