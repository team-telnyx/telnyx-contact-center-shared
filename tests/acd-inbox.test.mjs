// Durable Core webhook inbox behavioral tests on real PostgreSQL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { prepareAcdTestPool } from "./helpers/acd-test-db.mjs";
import {
  persistWebhookEvent,
  claimInboxEvent,
  claimInboxBatch,
  completeInboxEvent,
  failInboxEvent,
  runInboxWorkerOnce,
} from "../lib/acd/inbox.mjs";

const pool = await prepareAcdTestPool("acd_core_test_inbox");
const skip = pool ? false : "PostgreSQL not reachable — skipping ACD inbox tests";

test("inbox: persist is idempotent per event_id", { skip }, async () => {
  const eventId = `evt-${randomUUID().slice(0, 12)}`;
  const event = { eventId, eventType: "call.hangup", payload: { call_session_id: "s-1" } };
  assert.deepEqual(await persistWebhookEvent(pool, event), { inserted: true });
  assert.deepEqual(await persistWebhookEvent(pool, event), { inserted: false });
  const rows = await pool.query(
    `SELECT status FROM acd_webhook_events WHERE event_id = $1`,
    [eventId],
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].status, "received");
});

test("inbox: a duplicate can claim an unprocessed row but not a live lease", { skip }, async () => {
  const eventId = `evt-${randomUUID().slice(0, 12)}`;
  await persistWebhookEvent(pool, { eventId, eventType: "x.test", payload: {} });
  const first = await claimInboxEvent(pool, {
    eventId,
    node: "inline-a",
  });
  assert.equal(first.event_id, eventId);
  assert.equal(first.status, "processing");
  assert.equal(first.attempt_count, 1);

  assert.equal(
    await claimInboxEvent(pool, {
      eventId,
      node: "inline-b",
    }),
    null,
  );

  await pool.query(
    `UPDATE acd_webhook_events SET lease_expires_at = now() - interval '1 second'
      WHERE event_id = $1`,
    [eventId],
  );
  const recovered = await claimInboxEvent(pool, {
    eventId,
    node: "inline-b",
  });
  assert.equal(recovered.lease_owner, "inline-b");
  assert.equal(recovered.attempt_count, 2);
  assert.equal(
    await completeInboxEvent(pool, eventId, "noop", { node: "inline-a" }),
    false,
  );
  assert.equal(
    await completeInboxEvent(pool, eventId, "noop", { node: "inline-b" }),
    true,
  );
});

test("inbox: claim → lease blocks others → complete; expired lease is reclaimed", { skip }, async () => {
  const eventId = `evt-${randomUUID().slice(0, 12)}`;
  await persistWebhookEvent(pool, { eventId, eventType: "x.test", payload: {} });

  const claimedA = await claimInboxBatch(pool, { node: "worker-a", limit: 50 });
  const mine = claimedA.find((e) => e.event_id === eventId);
  assert.ok(mine);
  assert.equal(mine.status, "processing");

  const claimedB = await claimInboxBatch(pool, { node: "worker-b", limit: 50 });
  assert.equal(claimedB.find((e) => e.event_id === eventId), undefined);

  // Crash simulation: lease expires → another worker reclaims.
  await pool.query(
    `UPDATE acd_webhook_events SET lease_expires_at = now() - interval '1 second' WHERE event_id = $1`,
    [eventId],
  );
  const reclaimed = await claimInboxBatch(pool, { node: "worker-b", limit: 50 });
  assert.ok(reclaimed.find((e) => e.event_id === eventId));

  assert.equal(
    await completeInboxEvent(pool, eventId, "applied", { node: "worker-a" }),
    false,
  );
  await completeInboxEvent(pool, eventId, "applied", { node: "worker-b" });
  const done = await pool.query(
    `SELECT status, processed_at, lease_owner FROM acd_webhook_events WHERE event_id = $1`,
    [eventId],
  );
  assert.equal(done.rows[0].status, "applied");
  assert.ok(done.rows[0].processed_at);
  assert.equal(done.rows[0].lease_owner, null);
});

test("inbox: failures back off and dead-letter after max attempts", { skip }, async () => {
  const eventId = `evt-${randomUUID().slice(0, 12)}`;
  await persistWebhookEvent(pool, { eventId, eventType: "x.test", payload: {} });

  await claimInboxBatch(pool, { node: "w", limit: 50 });
  await failInboxEvent(pool, eventId, new Error("boom"), { node: "w" });
  let row = (await pool.query(`SELECT * FROM acd_webhook_events WHERE event_id = $1`, [eventId])).rows[0];
  assert.equal(row.status, "retryable_failed");
  assert.equal(row.last_error, "boom");
  assert.ok(new Date(row.next_attempt_at) > new Date());

  // Not claimable before next_attempt_at…
  const early = await claimInboxBatch(pool, { node: "w", limit: 50 });
  assert.equal(early.find((e) => e.event_id === eventId), undefined);

  // …dead after exhausting attempts.
  await pool.query(
    `UPDATE acd_webhook_events SET attempt_count = 99, next_attempt_at = now() WHERE event_id = $1`,
    [eventId],
  );
  await claimInboxBatch(pool, { node: "w", limit: 50 });
  await failInboxEvent(pool, eventId, new Error("still broken"), { node: "w" });
  row = (await pool.query(`SELECT status FROM acd_webhook_events WHERE event_id = $1`, [eventId])).rows[0];
  assert.equal(row.status, "dead");
});

test("inbox worker: handler outcomes are recorded; a throw is retryable", { skip }, async () => {
  const okId = `evt-${randomUUID().slice(0, 12)}`;
  const badId = `evt-${randomUUID().slice(0, 12)}`;
  await persistWebhookEvent(pool, { eventId: okId, eventType: "worker.ok", payload: {} });
  await persistWebhookEvent(pool, { eventId: badId, eventType: "worker.bad", payload: {} });

  const results = await runInboxWorkerOnce(pool, {
    node: "worker-x",
    limit: 50,
    handler: async (event) => {
      if (event.event_type === "worker.bad") throw new Error("handler exploded");
      return "applied";
    },
  });
  assert.ok(results.applied >= 1);
  assert.ok(results.failed >= 1);

  const statuses = await pool.query(
    `SELECT event_id, status FROM acd_webhook_events WHERE event_id = ANY($1)`,
    [[okId, badId]],
  );
  const byId = Object.fromEntries(statuses.rows.map((r) => [r.event_id, r.status]));
  assert.equal(byId[okId], "applied");
  assert.equal(byId[badId], "retryable_failed");
});

test("inbox worker renews a single event lease while its handler is running", { skip }, async () => {
  const eventId = `evt-${randomUUID().slice(0, 12)}`;
  await persistWebhookEvent(pool, { eventId, eventType: "worker.slow", payload: {} });

  let competingClaim = null;
  const result = await runInboxWorkerOnce(pool, {
    node: "slow-worker",
    limit: 1,
    leaseMs: 90,
    handler: async (event) => {
      assert.equal(event.event_id, eventId);
      competingClaim = new Promise((resolve, reject) => {
        setTimeout(() => {
          claimInboxEvent(pool, {
            eventId,
            node: "competing-worker",
            leaseMs: 90,
          }).then(resolve, reject);
        }, 120);
      });
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.equal(await competingClaim, null);
      return "applied";
    },
  });

  assert.equal(result.claimed, 1);
  assert.equal(result.applied, 1);
  assert.equal(result.leaseLost, 0);
  const row = await pool.query(
    `SELECT status, attempt_count, lease_owner FROM acd_webhook_events WHERE event_id = $1`,
    [eventId],
  );
  assert.equal(row.rows[0].status, "applied");
  assert.equal(row.rows[0].attempt_count, 1);
  assert.equal(row.rows[0].lease_owner, null);
});

test.after(async () => {
  await pool?.end().catch(() => {});
});
