import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const schemaPath = new URL("../lib/postgres-schema.mjs", import.meta.url);
const reservationManagerPath = new URL(
  "../lib/contact-center/reservation-manager.js",
  import.meta.url,
);
const idempotencyPath = new URL("../lib/events/idempotency.js", import.meta.url);

function createFakeClient() {
  const calls = [];
  const client = {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/FOR UPDATE OF u/i.test(sql)) {
        return { rows: [{ id: params[0], max_concurrent_calls: 1 }] };
      }
      if (/INSERT INTO cc_agent_reservations/i.test(sql)) {
        return { rows: [{ id: params[0] }] };
      }
      if (/INSERT INTO cc_processed_events/i.test(sql)) {
        return { rows: [{ event_id: params[0] }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return client;
}

function createFakePool(client = createFakeClient()) {
  return {
    client,
    async connect() {
      return client;
    },
    async query(sql, params = []) {
      return client.query(sql, params);
    },
  };
}

test("WS0 schema adds routing foundation tables and columns idempotently", async () => {
  const source = await readFile(schemaPath, "utf8");

  assert.match(source, /CREATE TABLE IF NOT EXISTS cc_agent_reservations/);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_resv_agent_active/);
  assert.match(source, /CREATE INDEX IF NOT EXISTS idx_resv_lease/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS cc_processed_events/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS wrapup_expires_at/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS status_reason/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS active_channel/);
});

test("reserveAgent locks the agent before capacity is checked in a fresh insert statement", async () => {
  const { reserveAgent } = await import(reservationManagerPath);
  const pool = createFakePool();

  const reservationId = await reserveAgent("agent-1", {
    pool,
    channel: "inbound",
    interactionId: "interaction-1",
    queueId: "queue-1",
    leaseMs: 30_000,
  });

  assert.ok(reservationId, "reservation should return the inserted id");
  const insertCall = pool.client.calls.find((call) =>
    /INSERT INTO cc_agent_reservations/i.test(call.sql),
  );
  assert.ok(insertCall, "reserveAgent must insert into cc_agent_reservations");
  const lockCall = pool.client.calls.find((call) => /FOR UPDATE OF u/i.test(call.sql));
  assert.ok(lockCall, "reserveAgent must lock the agent row before inserting");
  assert.match(lockCall.sql, /JOIN cc_agent_state/i);
  assert.match(lockCall.sql, /s\.agent_status\s*=\s*'Available'/i);
  assert.match(lockCall.sql, /s\.is_available_for_routing\s*=\s*true/i);
  assert.ok(
    pool.client.calls.indexOf(lockCall) < pool.client.calls.indexOf(insertCall),
    "capacity insert should run after the row lock statement",
  );
  assert.doesNotMatch(insertCall.sql, /FOR UPDATE OF u/i);
  assert.match(insertCall.sql, /COUNT\(\*\)[\s\S]*<\s*\$9/i);
  assert.match(insertCall.sql, /r\.state\s*=\s*'active'/i);
  assert.match(insertCall.sql, /r\.lease_expires_at\s*>\s*now\(\)/i);
  assert.match(insertCall.sql, /RETURNING id/i);
});

test("reserveAgent returns null when the guarded insert loses the race", async () => {
  const { reserveAgent } = await import(reservationManagerPath);
  const client = createFakeClient();
  client.query = async (sql, params = []) => {
    client.calls.push({ sql: String(sql), params });
    if (/FOR UPDATE OF u/i.test(sql)) {
      return { rows: [{ id: params[0], max_concurrent_calls: 1 }] };
    }
    if (/INSERT INTO cc_agent_reservations/i.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  };
  const pool = createFakePool(client);

  const reservationId = await reserveAgent("agent-1", {
    pool,
    channel: "inbound",
    interactionId: "interaction-1",
  });

  assert.equal(reservationId, null);
});

test("release helpers fall back to the default pool when no explicit pool/client is passed", async () => {
  const source = await readFile(reservationManagerPath, "utf8");

  const withClientBlock = source.slice(
    source.indexOf("async function withClient"),
    source.indexOf("export async function reserveAgent"),
  );

  assert.match(
    withClientBlock,
    /poolOrClient\s*&&[\s\S]*typeof poolOrClient\.query === "function"/,
    "withClient must guard optional poolOrClient before reading .query",
  );
  assert.match(
    withClientBlock,
    /const pool = resolvePool\(poolOrClient\)/,
    "withClient should resolve the default Postgres pool when no explicit pool/client is provided",
  );
});

test("alreadyProcessed is concurrency-safe via INSERT ON CONFLICT DO NOTHING RETURNING", async () => {
  const { alreadyProcessed } = await import(idempotencyPath);
  const pool = createFakePool();

  const first = await alreadyProcessed("evt-1", "telnyx-webhook", { pool });

  assert.equal(first, false, "first insert should not be considered already processed");
  const insertCall = pool.client.calls.find((call) =>
    /INSERT INTO cc_processed_events/i.test(call.sql),
  );
  assert.ok(insertCall, "alreadyProcessed must insert into cc_processed_events");
  assert.match(insertCall.sql, /ON CONFLICT\s*\(event_id\)\s*DO NOTHING/i);
  assert.match(insertCall.sql, /RETURNING event_id/i);
});
