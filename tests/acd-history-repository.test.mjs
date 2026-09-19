import test from "node:test";
import assert from "node:assert/strict";

import { readOptionalHistoryRows } from "../lib/acd/work-item-repository.mjs";

test("Agent Assist history uses its real started_at timestamp", async () => {
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("to_regclass")) {
        return { rows: [{ relation: "aa_workflow_sessions" }] };
      }
      return { rows: [{ id: "session-1", started_at: "2026-09-09T06:00:00Z" }] };
    },
  };

  const rows = await readOptionalHistoryRows(
    db,
    "aa_workflow_sessions",
    "work-item-1",
  );

  assert.equal(rows[0].id, "session-1");
  assert.match(queries[1].sql, /ORDER BY started_at, id/);
  assert.doesNotMatch(queries[1].sql, /ORDER BY created_at/);
  assert.deepEqual(queries[1].params, ["work-item-1"]);
});

test("optional history table names are constrained to the known business links", async () => {
  const db = { query: async () => assert.fail("unknown tables must not be queried") };
  await assert.rejects(
    readOptionalHistoryRows(db, "unknown; DROP TABLE users", "work-item-1"),
    /Unsupported optional history table/,
  );
});
