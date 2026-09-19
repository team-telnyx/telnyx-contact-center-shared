import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool, seedAgent, seedQueue, makeTxRunner } from "./helpers/acd-test-db.mjs";
import { heartbeatAgentSession } from "../lib/acd/sessions.mjs";
import { routeOne } from "../lib/acd/router.mjs";
import { actOnTextWork, createChatWork, endCustomerChat } from "../lib/acd/text-lifecycle.mjs";
import { readTextInteractions } from "../lib/acd/text-desktop.mjs";
import { createVideoWork } from "../lib/video/lifecycle.mjs";
import { checkInvariants } from "../lib/acd/lifecycle.mjs";
import { clearSagaDeadlineWakeups } from "../lib/acd/saga-engine.mjs";
import { sweepOrphanedClaims } from "../lib/acd/reconciler.mjs";
import { executeAcdOperation, readAcdOperations } from "../lib/acd/operations.mjs";
import { readAgentSnapshot } from "../lib/acd/stream.mjs";

const pool = await prepareAcdTestPool("acd_core_test_native_capacity_recovery");
const withTx = makeTxRunner(pool);
after(async () => { clearSagaDeadlineWakeups(); await pool.end(); });

async function fixture(channel) {
  const agentId = randomUUID(), queueId = randomUUID();
  await seedAgent(pool, agentId, { voiceReady: false });
  await pool.query("UPDATE users SET telephony_credentials_id=NULL WHERE id=$1", [agentId]);
  await seedQueue(pool, queueId, [agentId]);
  const exclusive = channel === "video";
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,$2,true,$3,$4)", [agentId, channel, exclusive ? 1 : 2, exclusive ? 1 : 0.33]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,$2,true,$3,$4)", [queueId, channel, exclusive ? 1 : 2, exclusive ? 1 : 0.33]);
  await heartbeatAgentSession(pool, { agentId, sessionId: randomUUID(), ready: { [channel]: true } });
  const work = await withTx((tx) => channel === "video"
    ? createVideoWork(tx, { queueId, customerName: "Visitor" })
    : createChatWork(tx, { queueId }));
  const routed = await routeOne(pool, work.id);
  assert.equal(routed.routed, true);
  return { agentId, queueId, work, reservationId: routed.reservationId };
}

// Reproduces the stuck state seen on dev: the offer saga finished (timeout
// handled by an older node without the channel) but never released the claim,
// then the visitor left. The agent shows Busy with no interaction.
async function strandReservation({ work, reservationId }) {
  await pool.query(`UPDATE acd_sagas SET state='succeeded', terminal_at=now() WHERE work_item_id=$1`, [work.id]);
  await pool.query(`UPDATE acd_offers SET state='no_answer', terminal_at=now() WHERE work_item_id=$1`, [work.id]);
  await pool.query(`UPDATE acd_work_items SET state='queued' WHERE id=$1`, [work.id]);
  await withTx(async (tx) => {
    const current = (await tx.query("SELECT * FROM acd_work_items WHERE id=$1 FOR UPDATE", [work.id])).rows[0];
    await endCustomerChat(tx, current);
  });
  await pool.query(`UPDATE acd_reservations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [reservationId]);
  const stranded = (await pool.query("SELECT state, owner_saga_id FROM acd_reservations WHERE id=$1", [reservationId])).rows[0];
  assert.equal(stranded.state, "reserved");
  assert.ok(stranded.owner_saga_id, "the finished saga still owns the claim");
}

test("the reconciler releases a claim whose owning saga finished without releasing it", async () => {
  const f = await fixture("video");
  await strandReservation(f);
  assert.equal((await readAgentSnapshot(pool, f.agentId)).agent.status, "Busy");
  assert.equal(await sweepOrphanedClaims(pool), 1);
  const reservation = (await pool.query("SELECT state, released_reason FROM acd_reservations WHERE id=$1", [f.reservationId])).rows[0];
  assert.equal(reservation.state, "released");
  assert.equal(reservation.released_reason, "lease_expired_orphan");
  assert.equal((await pool.query("SELECT workflow_state FROM acd_agent_state WHERE agent_id=$1", [f.agentId])).rows[0].workflow_state, "idle");
  assert.equal((await readAgentSnapshot(pool, f.agentId)).agent.status, "Available");
  assert.equal(await sweepOrphanedClaims(pool), 0);
  assert.deepEqual(await checkInvariants(pool), {});
});

test("the reconciler still leaves claims owned by a running saga alone", async () => {
  const f = await fixture("chat");
  await pool.query(`UPDATE acd_reservations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [f.reservationId]);
  assert.equal(await sweepOrphanedClaims(pool), 0, "a live text_offer saga owns the claim");
  assert.equal((await pool.query("SELECT state FROM acd_reservations WHERE id=$1", [f.reservationId])).rows[0].state, "reserved");
});

test("supervisors see stale chat and video capacity in Operations and can release it with an audit trail", async () => {
  const f = await fixture("video");
  const live = await fixture("chat");
  await strandReservation(f);
  const before = await readAcdOperations(pool);
  const stale = before.nativeCapacity.find((row) => row.reservation_id === f.reservationId);
  assert.ok(stale, "stale video reservation is listed");
  assert.equal(stale.channel, "video"); assert.equal(stale.needs_attention, true); assert.equal(stale.work_state, "abandoned");
  const ringing = before.nativeCapacity.find((row) => row.reservation_id === live.reservationId);
  assert.ok(ringing, "a ringing chat reservation is listed too");
  assert.equal(ringing.needs_attention, false); assert.equal(ringing.offer_state, "created");
  assert.equal((await readAcdOperations(pool, { channel: "chat" })).nativeCapacity.some((row) => row.reservation_id === f.reservationId), false, "the channel filter narrows the list");
  assert.ok((await readAcdOperations(pool, { channel: "video" })).nativeCapacity.some((row) => row.reservation_id === f.reservationId), "the video filter keeps video reservations");
  assert.deepEqual((await readAcdOperations(pool, { channel: "voice" })).nativeCapacity, [], "voice has no native reservations");

  const input = { actorId: "supervisor-1", requestId: randomUUID(), action: "release_native_capacity", targetId: live.reservationId, reason: "Agent reports Busy" };
  await assert.rejects(executeAcdOperation(pool, input), (error) => error.status === 409 && /live offer/.test(error.message));
  const result = await executeAcdOperation(pool, { ...input, requestId: randomUUID(), targetId: f.reservationId });
  assert.equal(result.recovered, true); assert.equal(result.state, "released"); assert.equal(result.evidence, "work_item_ended");
  assert.equal(result.channel, "video");
  assert.equal((await pool.query("SELECT state, released_reason FROM acd_reservations WHERE id=$1", [f.reservationId])).rows[0].released_reason, "operator_released_stale");
  assert.equal((await readAgentSnapshot(pool, f.agentId)).agent.status, "Available");
  const audit = (await pool.query("SELECT action, result FROM acd_operator_actions WHERE target_id=$1", [f.reservationId])).rows[0];
  assert.equal(audit.action, "release_native_capacity"); assert.equal(audit.result.recovered, true);
  const after = await readAcdOperations(pool);
  assert.equal(after.nativeCapacity.some((row) => row.reservation_id === f.reservationId), false);
  await assert.rejects(executeAcdOperation(pool, { ...input, requestId: randomUUID(), targetId: f.reservationId }), (error) => error.status === 409);
  assert.deepEqual(await checkInvariants(pool), {});
});

// The work item ended (visitor gone, inactivity sweep) while the accepted
// assignment stayed open: releasing the capacity must close that assignment
// too, or the desktop keeps the interaction and the agent gets double work.
test("releasing capacity of an ended work item closes its open assignment and segment", async () => {
  const f = await fixture("chat");
  const offer = (await pool.query("SELECT id FROM acd_offers WHERE work_item_id=$1 AND agent_id=$2 ORDER BY generation DESC LIMIT 1", [f.work.id, f.agentId])).rows[0];
  const version = (await pool.query("SELECT version FROM acd_work_items WHERE id=$1", [f.work.id])).rows[0].version;
  assert.equal((await actOnTextWork(pool, { workItemId: f.work.id, agentId: f.agentId, commandId: randomUUID(), expectedVersion: version, action: "accept", channel: "chat", offerId: offer.id })).ok, true);
  await pool.query("UPDATE acd_work_items SET state='abandoned', terminal_at=now(), terminal_reason='inactivity' WHERE id=$1", [f.work.id]);
  assert.ok((await readTextInteractions(pool, f.agentId)).interactions.some((row) => row.id === f.work.id), "the stale assignment still lists the interaction");
  const result = await executeAcdOperation(pool, { actorId: "supervisor-1", requestId: randomUUID(), action: "release_native_capacity", targetId: f.reservationId, reason: "Visitor gone, agent stuck" });
  assert.equal(result.assignmentClosed, true); assert.equal(result.evidence, "work_item_ended");
  const assignment = (await pool.query("SELECT a.state, s.ended_at, s.wrapup_ended_at FROM acd_text_assignments a JOIN acd_segments s ON s.id=a.segment_id WHERE a.reservation_id=$1", [f.reservationId])).rows[0];
  assert.equal(assignment.state, "completed"); assert.ok(assignment.ended_at); assert.ok(assignment.wrapup_ended_at);
  assert.equal((await pool.query("SELECT state FROM acd_offers WHERE id=$1", [offer.id])).rows[0].state, "cancelled");
  assert.equal((await readTextInteractions(pool, f.agentId)).interactions.some((row) => row.id === f.work.id), false);
  assert.equal((await readAgentSnapshot(pool, f.agentId)).agent.status, "Available");
  assert.deepEqual(await checkInvariants(pool), {});
});
