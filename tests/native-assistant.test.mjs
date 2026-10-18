import test from "node:test";
import assert from "node:assert/strict";
import { updateNativeAssistant } from "../lib/acd/native-assistant.mjs";
function poolFor(row) {
  const statements = [];
  const db = {
    release() {},
    async query(sql, args) {
      statements.push(sql);
      if (sql.includes("FROM acd_direct_intents"))
        return { rows: row ? [row] : [] };
      if (sql.includes("SELECT state"))
        return { rows: [{ state: "completed" }] };
      if (sql.includes("INSERT INTO acd_events"))
        return { rows: [{ id: 1, occurred_at: new Date() }] };
      if (sql.includes("INSERT INTO acd_outbox")) return { rows: [{ seq: 1 }] };
      return { rows: [], rowCount: 0 };
    },
  };
  return {
    statements,
    query: db.query,
    async connect() {
      return db;
    },
  };
}
const row = {
  id: "intent",
  agent_id: "agent",
  purpose: "native_ai",
  state: "active",
  attributes: {
    native_auth_session_id: "session",
    native_deadline: new Date(Date.now() + 60000).toISOString(),
  },
  work_item_id: "work",
  reservation_id: "reservation",
};
test("unknown session cannot touch capacity", async () => {
  const pool = poolFor(null);
  await assert.rejects(
    updateNativeAssistant(pool, "agent", {
      id: "missing",
      state: "ended",
      authSessionId: "session",
    }),
    { status: 404 },
  );
  assert.ok(!pool.statements.some((s) => /^UPDATE\s/.test(s.trim())));
});
test("a different login session cannot end an AI call", async () => {
  const pool = poolFor(row);
  await assert.rejects(
    updateNativeAssistant(pool, "agent", {
      id: "intent",
      state: "ended",
      authSessionId: "other",
    }),
    { status: 404 },
  );
  assert.ok(!pool.statements.some((s) => /^UPDATE\s/.test(s.trim())));
});
test("backgrounding or a missing heartbeat does not release capacity before the provider limit", async () => {
  const pool = poolFor(row);
  const result = await updateNativeAssistant(
    pool,
    "agent",
    { id: "intent", state: "ended" },
    { expiredOnly: true },
  );
  assert.equal(result.ended, false);
  assert.ok(!pool.statements.some((s) => /^UPDATE\s/.test(s.trim())));
});
test("terminal sessions are idempotent and late active events cannot resurrect them", async () => {
  const pool = poolFor({ ...row, state: "ended" });
  const result = await updateNativeAssistant(pool, "agent", {
    id: "intent",
    state: "active",
    authSessionId: "session",
  });
  assert.equal(result.ended, true);
  assert.ok(!pool.statements.some((s) => /^UPDATE\s/.test(s.trim())));
});
