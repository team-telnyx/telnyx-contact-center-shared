import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isProtectedSystemAgentStatus } from "../lib/acd/system-agent-statuses.mjs";

test("lifecycle-owned statuses cannot be renamed, disabled, or deleted", async () => {
  assert.equal(isProtectedSystemAgentStatus({ id: "available", name: "Renamed" }), true);
  assert.equal(
    isProtectedSystemAgentStatus({ id: "custom", name: "Agent Not Answering" }),
    true,
  );
  assert.equal(isProtectedSystemAgentStatus({ id: "break", name: "Break" }), false);

  const route = await readFile(
    new URL("../app/api/admin/statuses/[id]/route.js", import.meta.url),
    "utf8",
  );
  assert.equal((route.match(/isProtectedSystemAgentStatus\(current\)/g) || []).length, 2);
});

test("system status application has a safe fallback for drifted seed data", async () => {
  const source = await readFile(
    new URL("../lib/acd/agent-state.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /const appliedStatus = configured\?\.name \|\| status/);
  assert.match(source, /status_id: configured\?\.id \|\| null/);
});
