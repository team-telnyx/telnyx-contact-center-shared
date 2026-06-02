import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("suggested responses cards stay contained inside the right panel", async () => {
  const ui = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  assert.match(ui, /ScrollArea className="h-full overflow-x-hidden"/);
  assert.match(ui, /className="px-4 py-4 space-y-3 max-w-full overflow-x-hidden"/);
  assert.match(ui, /group w-full max-w-full overflow-hidden/);
  assert.match(ui, /flex flex-wrap items-center gap-2 mb-2 min-w-0/);
  assert.match(ui, /max-w-full truncate/);
  assert.match(ui, /break-words/);
});
