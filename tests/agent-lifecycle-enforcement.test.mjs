import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("queue answer timeout supports explicit global lifecycle inheritance", async () => {
  const [schema, createRoute, updateRoute, queueEditor, pgdb] = await Promise.all([
    readFile(new URL("../lib/postgres-schema.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/queues/route.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/queues/[id]/route.js", import.meta.url), "utf8"),
    readFile(new URL("../components/queues/EditSheet.jsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/pgdb.js", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /ALTER COLUMN agent_answer_timeout_secs DROP DEFAULT/);
  assert.match(pgdb, /agent_answer_timeout_secs, overflow_queue_id/);
  assert.match(createRoute, /body\.agentAnswerTimeoutSecs == null[\s\S]*\? null/);
  assert.match(updateRoute, /hasOwnProperty\.call\(body, "agentAnswerTimeoutSecs"\)/);
  assert.match(queueEditor, /placeholder="Inherit global setting"/);
  assert.match(queueEditor, /agentAnswerTimeoutSecs === "" \? null/);
});

test("all transfer entry points apply global lifecycle defaults", async () => {
  const source = await readFile(
    new URL("../lib/acd/sagas/transfers.mjs", import.meta.url),
    "utf8",
  );
  assert.equal((source.match(/await withAgentLifecycleDefaults\(db, params\)/g) || []).length, 3);
  assert.match(source, /lifecycle\.default_answer_timeout_seconds \* 1_000/);
  assert.match(source, /lifecycle\.wrapup_timeout_seconds \* 1_000/);
  assert.match(source, /lifecycle\.after_wrapup_status/);
  assert.match(source, /ctx\.data\.wrapupDeadlineMs \|\| WRAPUP_DEADLINE_MS/);
  assert.match(source, /ctx\.data\.afterWrapupStatus === "available"/);
});
