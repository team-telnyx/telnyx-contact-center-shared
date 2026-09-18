import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  makeTxRunner,
  prepareAcdTestPool,
  seedAgent,
} from "./helpers/acd-test-db.mjs";
import { createWorkItem } from "../lib/acd/lifecycle.mjs";
import { appendEvent } from "../lib/acd/events.mjs";
import { persistWebhookEvent } from "../lib/acd/inbox.mjs";
import { runAcdRetentionCycle } from "../lib/acd/retention.mjs";
import { publishCommittedOutbox, readAgentStream } from "../lib/acd/stream.mjs";

const database = "acd_core_test_retention";
const pool = await prepareAcdTestPool(database);
const skip = !pool;
const tx = makeTxRunner(pool);
after(async () => pool?.end());

test("retention prunes only materialized terminal evidence and records watermarks", { skip }, async () => {
  await seedAgent(pool, "retention-agent");
  const terminal = await tx((db) => createWorkItem(db, {
    channel: "voice",
    direction: "inbound",
    actor: "test",
  }));
  const active = await tx((db) => createWorkItem(db, {
    channel: "voice",
    direction: "inbound",
    actor: "test",
  }));
  const protectedWork = await tx((db) => createWorkItem(db, {
    channel: "voice",
    direction: "inbound",
    actor: "test",
  }));
  await pool.query(
    `UPDATE acd_work_items
        SET state = 'completed', terminal_at = now() - interval '3 days'
      WHERE id = ANY($1::uuid[])`,
    [[terminal.id, protectedWork.id]],
  );

  const unresolvedEventId = randomUUID();
  await persistWebhookEvent(pool, {
    eventId: unresolvedEventId,
    eventType: "call.hangup",
    payload: { call_control_id: `v3:${randomUUID()}` },
  }, { intakeOwner: "acd_core" });

  await tx(async (db) => {
    await appendEvent(db, {
      workItemId: terminal.id,
      type: "terminal_history",
      actor: "test",
    });
    await appendEvent(db, {
      workItemId: active.id,
      type: "active_evidence",
      actor: "test",
    });
    await appendEvent(db, {
      workItemId: protectedWork.id,
      type: "unresolved_evidence",
      payload: { source_event_id: unresolvedEventId },
      actor: "test",
    });
  });
  await publishCommittedOutbox(pool);
  await pool.query(`UPDATE acd_events SET occurred_at = now() - interval '2 days'`);
  await pool.query(`UPDATE acd_outbox SET created_at = now() - interval '2 days'`);
  await pool.query(`UPDATE acd_stream_events SET created_at = now() - interval '2 days'`);

  const result = await runAcdRetentionCycle(pool, {
    force: true,
    now: new Date(),
    config: {
      enabled: true,
      intervalMs: 1,
      outboxSafetyMs: 60 * 60 * 1000,
      streamReplayMs: 60 * 60 * 1000,
      eventHistoryMs: 60 * 60 * 1000,
      batchSize: 100,
    },
  });
  assert.equal(result.ran, true);
  // createWorkItem emits one event per item in addition to the three explicit
  // events above. Both events for the terminal item and the unprotected create
  // event for protectedWork are eligible; live-work and inbox-linked evidence
  // remain available.
  assert.equal(result.layers.acd_outbox.deleted, 3);
  assert.equal(result.layers.acd_stream_events.deleted, 3);
  assert.equal(result.layers.acd_events.deleted, 3);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_events`)).rows[0].n, 3);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_outbox`)).rows[0].n, 3);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_stream_events`)).rows[0].n, 3);
  assert.equal(
    (await pool.query(`SELECT COUNT(*)::int AS n FROM acd_retention_watermarks`)).rows[0].n,
    3,
  );

  const recovered = await readAgentStream(pool, {
    agentId: "retention-agent",
    after: 0,
  });
  assert.equal(recovered.recovery, "cursor_expired");
  assert.ok(recovered.snapshot);
});
