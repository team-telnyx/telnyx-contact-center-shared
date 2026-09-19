import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { prepareAcdTestPool, makeTxRunner, seedAgent, seedQueue, makeFakeProvider } from "./helpers/acd-test-db.mjs";
import { admitAcdVoiceEvent } from "../lib/acd/admission.mjs";
import { persistWebhookEvent } from "../lib/acd/inbox.mjs";
import { publishCommittedOutbox, readAgentStream } from "../lib/acd/stream.mjs";
import { appendEvent } from "../lib/acd/events.mjs";
import { createWorkItem, applyTransition } from "../lib/acd/lifecycle.mjs";
import { drainQueuedOnce } from "../lib/acd/worker.mjs";
import { routeAndConnect } from "../lib/acd/live-intake.mjs";

const database = "acd_core_test_durable_replay";
const pool = await prepareAcdTestPool(database);
const skip = !pool;
after(async () => pool?.end());
const tx = makeTxRunner(pool);
async function restart(crash = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("./helpers/acd-replay-process.mjs", import.meta.url).pathname, database, crash],
      { env: { ...process.env, TELNYX_API_KEY: "" }, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", value => { errors += value; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Replay process timed out")); }, 20000);
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timer); code === 0 || code === 86 ? resolve(code) : reject(new Error(errors.slice(-2000))); });
  });
}

test("durable admission, process death after provider send, restart, reordered correlation and duplicate delivery", { skip }, async () => {
  await pool.query(`CREATE TABLE acd_test_provider_calls (command_id TEXT PRIMARY KEY, operation TEXT, deliveries INT DEFAULT 1)`);
  await seedAgent(pool, "replay-agent");
  await seedQueue(pool, "replay-queue", ["replay-agent"], { engineOwner: "acd_core" });
  const customer = `v3:${randomUUID()}`;
  const device = `v3:${randomUUID()}`;
  const admission = { eventId: randomUUID(), eventType: "call.enqueued", payload: {
    queue: "replay-queue", call_session_id: randomUUID(), call_control_id: customer, from: "+15550001111", to: "+15550002222",
  } };
  assert.equal((await admitAcdVoiceEvent(pool, admission)).durable, true);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_work_items`)).rows[0].n, 0, "ACK must precede lifecycle/provider effects");
  assert.equal(await restart("transfer_to_agent"), 86);
  const work = (await pool.query(`SELECT * FROM acd_work_items`)).rows[0];
  await pool.query(`UPDATE acd_webhook_events SET lease_expires_at = now() - interval '1 second' WHERE status = 'processing'`);
  await pool.query(`UPDATE acd_sagas SET lease_expires_at = now() - interval '1 second' WHERE lease_owner IS NOT NULL`);
  await restart();
  const transfer = (await pool.query(`SELECT * FROM acd_test_provider_calls WHERE operation = 'transfer_to_agent'`)).rows;
  assert.equal(transfer.length, 1, "retries use the original durable command id");
  const generation = (await pool.query(`SELECT generation FROM acd_offers WHERE work_item_id = $1`, [work.id])).rows[0].generation;
  const early = { eventId: randomUUID(), eventType: "call.answered", payload: { call_control_id: device } };
  await persistWebhookEvent(pool, early, { intakeOwner: "acd_core" });
  await restart();
  assert.equal((await pool.query(`SELECT status FROM acd_webhook_events WHERE event_id = $1`, [early.eventId])).rows[0].status, "retryable_failed");
  await persistWebhookEvent(pool, { eventId: randomUUID(), eventType: "call.initiated", payload: {
    call_control_id: device, direction: "incoming", custom_headers: [
      { name: "X-CC-Work-Item-Id", value: work.id }, { name: "X-CC-Offer-Generation", value: String(generation) },
    ],
  } }, { intakeOwner: "acd_core" });
  await restart();
  await pool.query(`UPDATE acd_webhook_events SET next_attempt_at = now() WHERE event_id = $1`, [early.eventId]);
  await restart();
  const fixture = JSON.parse(await readFile(new URL("./fixtures/acd/voice-replay.json", import.meta.url), "utf8"));
  for (const item of fixture.events) {
    const event = { eventId: randomUUID(), eventType: item.eventType, payload: { call_control_id: item.leg === "device" ? device : customer } };
    await persistWebhookEvent(pool, event, { intakeOwner: "acd_core" });
    await restart();
    await persistWebhookEvent(pool, event, { intakeOwner: "acd_core" });
    await restart();
  }
  assert.equal((await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [work.id])).rows[0].state, "completed");
  assert.equal((await pool.query(`SELECT state FROM acd_legs WHERE provider_call_id = $1`, [customer])).rows[0].state, "ended");
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_reservations WHERE state <> 'released'`)).rows[0].n, 0);
});

test("stream survives commit reordering and reconnect without disclosing another agent's state", { skip }, async () => {
  const slow = await pool.connect();
  await slow.query("BEGIN");
  try {
    await appendEvent(slow, { agentId: "viewer", type: "slow", actor: "test" });
    await tx(db => appendEvent(db, { agentId: "other", type: "fast", actor: "test" }));
    await publishCommittedOutbox(pool);
    const before = await readAgentStream(pool, { agentId: "viewer", after: 0 });
    assert.equal(before.snapshot, null);
    await slow.query("COMMIT");
    await publishCommittedOutbox(pool);
    const after = await readAgentStream(pool, { agentId: "viewer", after: before.cursor });
    assert.ok(BigInt(after.cursor) > BigInt(before.cursor));
    assert.ok(after.snapshot);
    assert.deepEqual(after.snapshot.interactions, []);
    assert.equal((await readAgentStream(pool, { agentId: "viewer", after: after.cursor })).snapshot, null);
  } finally { await slow.query("ROLLBACK"); slow.release(); }
});

test("voice worker refuses nonvoice work before capacity or provider I/O", { skip }, async () => {
  const work = await tx(async db => {
    const wi = await createWorkItem(db, { channel: "sms", direction: "inbound", actor: "test", attributes: { engine: "acd_core" } });
    await applyTransition(db, { workItemId: wi.id, to: "queued", eventType: "work_item_queued", actor: "test" });
    return wi;
  });
  const provider = makeFakeProvider();
  assert.equal((await routeAndConnect(pool, provider, work.id)).reason, "unsupported_channel");
  await drainQueuedOnce(pool, provider);
  assert.equal(provider.calls.length, 0);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM acd_reservations WHERE work_item_id = $1`, [work.id])).rows[0].n, 0);
});
