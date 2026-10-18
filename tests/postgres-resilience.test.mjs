import assert from "node:assert/strict";
import test from "node:test";
import { isPostgresConnectionFailure, postgresResilienceOptions, queryPostgresWithDeadline } from "../lib/postgres-resilience.mjs";

test("transport failures discard connections while SQL errors remain recoverable by rollback", () => {
  for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT", "08006", "57P01", "PG_QUERY_DEADLINE"]) {
    assert.equal(isPostgresConnectionFailure({ code }), true, code);
  }
  assert.equal(isPostgresConnectionFailure(new Error("Query read timeout")), true);
  for (const code of ["22012", "23505", "40001", "57014"]) {
    assert.equal(isPostgresConnectionFailure({ code }), false, code);
  }
});

test("connection recovery options cannot accidentally disable the deadline", () => {
  const options = postgresResilienceOptions({ POSTGRES_QUERY_TIMEOUT_MS: "0", POSTGRES_MAX_LIFETIME_SECONDS: "-1" });
  assert.equal(options.query_timeout, 35000);
  assert.equal(options.keepAlive, true);
  assert.equal(options.maxLifetimeSeconds, 300);
  assert.equal(postgresResilienceOptions({ POSTGRES_QUERY_TIMEOUT_MS: "80" }).query_timeout, 80);
});

test("a deadline during acquisition releases a late client without executing the abandoned query", async () => {
  let resolve;
  let releases = 0;
  let queries = 0;
  const acquired = new Promise((done) => { resolve = done; });
  const client = { query: () => { queries++; }, release: () => { releases++; } };
  const pending = queryPostgresWithDeadline({ connect: () => acquired }, { text: "SELECT 1" }, 15);
  await assert.rejects(pending, { code: "PG_QUERY_DEADLINE" });
  resolve(client);
  await new Promise((done) => setImmediate(done));
  assert.equal(releases, 1);
  assert.equal(queries, 0);
});

test("an active query deadline disconnects and releases the client exactly once", async () => {
  let ends = 0;
  const releases = [];
  const client = {
    query: () => new Promise(() => {}),
    end: async () => { ends++; },
    release: (error) => { releases.push(error); },
  };
  await assert.rejects(queryPostgresWithDeadline({ connect: async () => client }, { text: "SELECT 1" }, 15), { code: "PG_QUERY_DEADLINE" });
  assert.equal(ends, 1);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].code, "PG_QUERY_DEADLINE");
});
