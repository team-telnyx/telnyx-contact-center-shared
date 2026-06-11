import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Load DB env from .env (node:test does not load Next.js dotenv files).
async function loadEnvFile() {
  try {
    const raw = await readFile(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) {
        process.env[key] = value.replace(/^"|"$/g, "");
      }
    }
  } catch {
    /* no .env — DB-dependent tests will be skipped */
  }
}

await loadEnvFile();

const { getPostgresPool } = await import("../lib/postgres.mjs");

async function dbAvailable() {
  try {
    const pool = getPostgresPool();
    if (!pool) return false;
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const hasDb = await dbAvailable();

test("WS0-T2 event bus module shape and topic constants", async () => {
  const bus = await import("../lib/events/event-bus.js");
  assert.equal(typeof bus.publish, "function");
  assert.equal(typeof bus.subscribe, "function");
  assert.equal(typeof bus.closeEventBus, "function");
  assert.equal(bus.TOPICS.AGENT_AVAILABLE, "agent.available");
  assert.equal(bus.TOPICS.CALL_ENQUEUED, "call.enqueued");
  assert.equal(bus.TOPICS.SSE_PREFIX, "sse:");
});

test("WS0-T2 pg adapter rejects oversized payloads before hitting NOTIFY limits", async () => {
  const { createPgNotifyAdapter } = await import("../lib/events/adapter-pg-notify.js");
  const adapter = createPgNotifyAdapter();
  await assert.rejects(
    adapter.publish("big.topic", { blob: "x".repeat(8 * 1024) }),
    /too large/,
  );
  await adapter.close();
});

test(
  "WS0-T2 publish from one connection invokes subscriber on another connection",
  { skip: !hasDb && "postgres not reachable" },
  async () => {
    const { createPgNotifyAdapter } = await import("../lib/events/adapter-pg-notify.js");
    // Two adapter instances = two dedicated LISTEN connections, simulating
    // two Node processes against the same database.
    const nodeA = createPgNotifyAdapter();
    const nodeB = createPgNotifyAdapter();
    try {
      const received = [];
      const wildcard = [];
      await nodeB.subscribe("ws0.test.topic", (payload, meta) => {
        received.push({ payload, meta });
      });
      await nodeB.subscribe("ws0.test.*", (payload, meta) => {
        wildcard.push(meta.topic);
      });

      await nodeA.publish("ws0.test.topic", { hello: "ha" });
      await nodeA.publish("ws0.test.other", { n: 2 });

      const deadline = Date.now() + 5000;
      while ((received.length < 1 || wildcard.length < 2) && Date.now() < deadline) {
        await delay(50);
      }

      assert.equal(received.length, 1, "exact-topic subscriber fires once");
      assert.deepEqual(received[0].payload, { hello: "ha" });
      assert.equal(received[0].meta.topic, "ws0.test.topic");
      assert.deepEqual(
        wildcard.sort(),
        ["ws0.test.other", "ws0.test.topic"],
        "prefix wildcard receives both topics",
      );
    } finally {
      await nodeA.close();
      await nodeB.close();
    }
  },
);

test(
  "WS0-T3 leadership: second contender takes over when holder releases",
  { skip: !hasDb && "postgres not reachable" },
  async () => {
    const { withLeadership, isLeader, advisoryKeyForName } = await import(
      "../lib/coordinator/leadership.js"
    );
    const { Client } = await import("pg");

    const name = `ws0-test-${process.pid}-${Date.now()}`;
    const key = advisoryKeyForName(name);

    // Simulate "another process" holding the lock on a dedicated connection.
    const rival = new Client({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT || 5432),
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      ssl: false,
    });
    await rival.connect();
    const grabbed = await rival.query(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [key],
    );
    assert.equal(grabbed.rows[0].acquired, true, "rival holds the lock first");

    let becameLeader = false;
    let lostLeadership = false;
    const controller = withLeadership(
      name,
      async ({ signal }) => {
        becameLeader = true;
        await new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            lostLeadership = true;
            resolve();
          });
        });
      },
      { retryIntervalMs: 300 },
    );

    try {
      // While rival holds the lock we must NOT be leader.
      await delay(900);
      assert.equal(becameLeader, false, "no leadership while rival holds lock");
      assert.equal(isLeader(name), false);

      // Rival "process dies" → advisory lock auto-releases server-side.
      await rival.end();

      const deadline = Date.now() + 5000;
      while (!becameLeader && Date.now() < deadline) {
        await delay(100);
      }
      assert.equal(becameLeader, true, "takes over after rival releases");
      assert.equal(isLeader(name), true);
    } finally {
      await controller.stop();
    }
    assert.equal(lostLeadership, true, "loop observed abort signal on stop");
    assert.equal(isLeader(name), false, "leadership cleared after stop");
  },
);

test("WS0 modules stay dormant: no existing routing/status file imports them yet", async () => {
  // Guard: adding the primitives must not change current routing/status flows.
  const filesThatMustNotChangeBehavior = [
    "../lib/contact-center/routing-engine.js",
    "../lib/contact-center/queued-call-router.js",
    "../lib/contact-center/user-status.js",
    "../lib/contact-center/state-manager.js",
    "../lib/contact-center/webhook-handler.js",
  ];
  for (const rel of filesThatMustNotChangeBehavior) {
    const source = await readFile(new URL(rel, import.meta.url), "utf8");
    assert.ok(
      !source.includes("events/event-bus") && !source.includes("coordinator/leadership"),
      `${rel} must not consume WS0 primitives until WS3 lands behind flags`,
    );
  }
});
