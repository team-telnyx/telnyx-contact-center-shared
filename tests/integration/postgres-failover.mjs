// Run against an isolated loopback PostgreSQL instance:
// TEST_POSTGRES_URL=postgres://user@127.0.0.1:port/postgres node --test tests/integration/postgres-failover.mjs
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createPostgresPool, queryPostgresWithDeadline } from "../../lib/postgres-resilience.mjs";

const url = new URL(process.env.TEST_POSTGRES_URL);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Failure injection is restricted to a local test database");

// ReadyForQuery ('Z', length 5, transaction status) closes every server
// response and is sent only after the statement's transaction has finished.
function endsWithReadyForQuery(buffer) {
  return buffer.length >= 6 && buffer[buffer.length - 6] === 0x5a && buffer.readUInt32BE(buffer.length - 5) === 5;
}

async function fixture(t, { patched = true, queryTimeout = 100, statementTimeout = 0 } = {}) {
  const pairs = new Set();
  const dropped = new EventEmitter();
  const server = net.createServer((incoming) => {
    const upstream = net.connect({ host: url.hostname, port: Number(url.port) });
    const pair = { incoming, upstream, blockWrites: false, blockReads: false, lost: Buffer.alloc(0) };
    pairs.add(pair);
    incoming.on("data", (data) => { if (!pair.blockWrites) upstream.write(data); });
    upstream.on("data", (data) => {
      if (!pair.blockReads) { incoming.write(data); return; }
      pair.lost = Buffer.concat([pair.lost, data]);
      if (endsWithReadyForQuery(pair.lost)) dropped.emit("response", pair);
    });
    // A client that gave up on a blocked connection has not made the server
    // give up: keep the upstream side open so the proxy still sees the
    // response the client never received (a lost response is exactly that).
    const dropUpstream = () => { if (!pair.blockReads) upstream.destroy(); };
    incoming.on("error", dropUpstream);
    incoming.on("close", dropUpstream);
    upstream.on("error", () => incoming.destroy());
    upstream.on("close", () => { incoming.destroy(); pairs.delete(pair); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const proxyUrl = new URL(url);
  proxyUrl.hostname = "127.0.0.1";
  proxyUrl.port = String(server.address().port);
  const options = { connectionString: proxyUrl.href, max: 1, connectionTimeoutMillis: 250,
    query_timeout: patched ? queryTimeout : 0, statement_timeout: statementTimeout, ssl: false };
  const pool = patched ? createPostgresPool(options) : new Pool(options);
  pool.on("error", () => {});
  t.after(async () => {
    for (const { incoming, upstream } of pairs) { incoming.destroy(); upstream.destroy(); }
    await pool.end();
    await new Promise((resolve) => server.close(resolve));
  });
  const blockExisting = ({ writes = true } = {}) => {
    for (const pair of pairs) { pair.blockReads = true; pair.blockWrites = writes; }
  };
  // Resolves once a blocked connection has dropped a complete server response.
  const lostResponse = ({ timeoutMillis = 10_000 } = {}) => once(dropped, "response", { signal: AbortSignal.timeout(timeoutMillis) });
  return { pool, blockExisting, lostResponse, pairs, proxyUrl };
}

test("reproduces the incident: the original pool stays occupied after the old connection stops answering", async (t) => {
  const { pool, blockExisting } = await fixture(t, { patched: false });
  const client = await pool.connect();
  await client.query("SELECT 1");
  blockExisting();
  const abandoned = client.query("SELECT 1").catch((error) => error);
  await assert.rejects(pool.query("SELECT 1"), /timeout exceeded when trying to connect/);
  assert.equal(pool.totalCount, 1);
  assert.equal(pool.idleCount, 0);
  await client.end();
  client.release(new Error("test cleanup"));
  await abandoned;
});

test("pooled queries discard a blackholed socket and recover on a new connection without a restart", async (t) => {
  const { pool, blockExisting } = await fixture(t);
  await pool.query("SELECT 1");
  blockExisting();
  await assert.rejects(pool.query("SELECT 1"), /Query read timeout/);
  assert.equal((await pool.query("SELECT 1 AS ok")).rows[0].ok, 1);
  assert.equal(pool.waitingCount, 0);
});

test("a checked-out transaction cannot hang in rollback after a lost response", async (t) => {
  const { pool, blockExisting } = await fixture(t);
  const client = await pool.connect();
  await client.query("BEGIN");
  blockExisting();
  await assert.rejects(client.query("SELECT 1"), /Query read timeout/);
  const start = Date.now();
  await assert.rejects(client.query("ROLLBACK"), /closed|terminated|not queryable/i);
  assert.ok(Date.now() - start < 80, "rollback must fail promptly on the discarded client");
  client.release();
  assert.equal((await pool.query("SELECT 1 AS ok")).rows[0].ok, 1);
});

test("a request deadline closes its active socket and makes the pool available again", async (t) => {
  const { pool, blockExisting } = await fixture(t, { queryTimeout: 1000 });
  await pool.query("SELECT 1");
  blockExisting();
  await assert.rejects(queryPostgresWithDeadline(pool, { text: "SELECT 1" }, 50), /timeout/i);
  assert.equal((await queryPostgresWithDeadline(pool, { text: "SELECT 1 AS ok" }, 500)).rows[0].ok, 1);
});

test("the callback API reports a blackhole timeout once and recovers", async (t) => {
  const { pool, blockExisting } = await fixture(t);
  const client = await pool.connect();
  await client.query("SELECT 1");
  blockExisting();
  let callbacks = 0;
  const error = await new Promise((resolve) => client.query("SELECT 1", (err) => { callbacks++; resolve(err); }));
  assert.match(error.message, /Query read timeout/);
  client.release(error);
  await pool.query("SELECT 1");
  assert.equal(callbacks, 1);
});

test("normal SQL errors and server-side statement timeouts still allow rollback", async (t) => {
  const { pool } = await fixture(t, { queryTimeout: 1000, statementTimeout: 50 });
  const client = await pool.connect();
  await client.query("BEGIN");
  await assert.rejects(client.query("SELECT 1/0"), { code: "22012" });
  await client.query("ROLLBACK");
  await client.query("BEGIN");
  await assert.rejects(client.query("SELECT pg_sleep(0.2)"), { code: "57014" });
  await client.query("ROLLBACK");
  assert.equal((await client.query("SELECT 1 AS ok")).rows[0].ok, 1);
  client.release();
});

test("a write whose response is lost is never automatically replayed", async (t) => {
  // Only the write under test runs against a short read timeout. The pool-wide
  // 100 ms deadline also covered the DDL around it, which a loaded runner's
  // Postgres can take longer than that to commit; the pool timeout here is a
  // hang guard, not part of the scenario.
  const { pool, blockExisting, lostResponse } = await fixture(t, { queryTimeout: 10_000 });
  const table = `failover_test_${randomUUID().replaceAll("-", "")}`;
  await pool.query(`CREATE TABLE ${table}(id integer)`);
  try {
    blockExisting({ writes: false });
    const lost = lostResponse();
    await assert.rejects(pool.query({ text: `INSERT INTO ${table} VALUES (1) RETURNING id`, query_timeout: 100 }), /Query read timeout/);
    // The client gave up on its own clock while the server kept working. Count
    // only once the server has answered and the proxy has dropped that answer:
    // the row is committed by then, and the table is no longer locked.
    await lost;
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 1);
  } finally {
    await pool.query(`DROP TABLE ${table}`);
  }
});

test("the application health check reports failure within the ALB deadline and then recovers", async (t) => {
  const { proxyUrl, blockExisting } = await fixture(t);
  const env = {
    POSTGRES_HOST: proxyUrl.hostname,
    POSTGRES_PORT: proxyUrl.port,
    POSTGRES_USER: decodeURIComponent(url.username),
    POSTGRES_PASSWORD: decodeURIComponent(url.password),
    POSTGRES_DB: url.pathname.slice(1),
    POSTGRES_SSL: "false",
    POSTGRES_POOL_MAX: "1",
    POSTGRES_HEALTH_TIMEOUT_MS: "100",
  };
  const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const { checkPostgresStatus, getPostgresPool } = await import("../../lib/postgres.mjs");
  t.after(async () => {
    await getPostgresPool()?.end();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  assert.equal((await checkPostgresStatus()).ready, true);
  blockExisting();
  const start = Date.now();
  const status = await checkPostgresStatus();
  assert.equal(status.ready, false);
  assert.match(status.error, /timeout/i);
  assert.ok(Date.now() - start < 4500, "health must return before the ALB's five-second timeout");
  assert.equal((await checkPostgresStatus()).ready, true);
  assert.equal(getPostgresPool().waitingCount, 0);
});
