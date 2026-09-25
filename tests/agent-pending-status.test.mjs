import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool, seedAgent, seedQueue } from "./helpers/acd-test-db.mjs";
import { heartbeatAgentSession } from "../lib/acd/sessions.mjs";
import { routeOne } from "../lib/acd/router.mjs";
import { createChatWork, actOnTextWork, completeTextWrapup } from "../lib/acd/text-lifecycle.mjs";
import { readTextDetail } from "../lib/acd/text-desktop.mjs";
import {
  agentStatusPresentation,
  effectiveAgentStatus,
  pendingAgentStatusSql,
  readAgentStatusPresentation,
  setManualAgentStatus,
} from "../lib/acd/agent-state.mjs";
import { readAgentSnapshot } from "../lib/acd/stream.mjs";
import { readMonitorStatistics } from "../lib/acd/monitor-statistics.mjs";
import { getAcdRealtimeQueueCalls } from "../lib/acd/realtime-queue-calls.mjs";
import { clearSagaDeadlineWakeups } from "../lib/acd/saga-engine.mjs";

const pool = await prepareAcdTestPool("acd_core_test_agent_pending_status");
const skip = pool ? false : "ACD test database unavailable";
if (pool) {
  await pool.query(`DROP TABLE IF EXISTS app_settings,cc_queue_wrapup_codes,cc_wrapup_codes;
    CREATE TABLE app_settings(id text PRIMARY KEY,cc_settings jsonb,updated_by text,updated_at timestamptz);
    INSERT INTO app_settings(id,cc_settings) VALUES('default','{}');
    CREATE TABLE cc_wrapup_codes(id text,name text,is_active boolean);
    CREATE TABLE cc_queue_wrapup_codes(queue_id text,wrapup_code_id text);
    INSERT INTO cc_wrapup_codes VALUES('resolved','Resolved',true);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;
    INSERT INTO cc_user_statuses (id, name, type) VALUES ('away', 'Away', 'active') ON CONFLICT (id) DO NOTHING;`);
}
after(async () => { clearSagaDeadlineWakeups(); if (pool) await pool.end(); });

const state = async (id) => (await pool.query("SELECT * FROM acd_agent_state WHERE agent_id=$1", [id])).rows[0];
const pendingBySql = async (id) => (await pool.query(
  `SELECT ${pendingAgentStatusSql("ast")} AS pending FROM acd_agent_state ast WHERE ast.agent_id=$1`, [id],
)).rows[0].pending;
const blockingEvents = async (workItemId) => (await pool.query(
  "SELECT payload FROM acd_events WHERE work_item_id=$1 AND type='no_agent_reserved' ORDER BY id", [workItemId],
)).rows.map((row) => row.payload);

async function fixture() {
  const agentId = randomUUID(), queueId = randomUUID();
  await seedAgent(pool, agentId, { voiceReady: false });
  await seedQueue(pool, queueId, [agentId]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,3,0.2)", [queueId]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,3,0.2)", [agentId]);
  await heartbeatAgentSession(pool, { agentId, sessionId: randomUUID(), ready: { chat: true } });
  return { agentId, queueId };
}
async function queueChat(f) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const work = await createChatWork(client, { queueId: f.queueId, customerName: "Visitor" });
    await client.query("COMMIT");
    return work;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
async function acceptChat(f) {
  const work = await queueChat(f);
  const offer = await routeOne(pool, work.id);
  assert.equal(offer.routed, true, JSON.stringify(offer));
  const detail = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "chat" });
  await actOnTextWork(pool, { workItemId: work.id, agentId: f.agentId, channel: "chat", action: "accept", commandId: randomUUID(), expectedVersion: detail.work.version, offerId: offer.offerId });
  return work;
}
async function disconnectChat(f, work) {
  const detail = await readTextDetail(pool, { workItemId: work.id, agentId: f.agentId, channel: "chat" });
  await actOnTextWork(pool, { workItemId: work.id, agentId: f.agentId, channel: "chat", action: "disconnect", commandId: randomUUID(), expectedVersion: detail.work.version });
}

test("the presentation exposes a manual status that waits behind Busy or Wrapup", () => {
  const at = "2026-09-15T10:00:00.000Z";
  const base = { presence: "online", manual_status: "Available", workflow_state: "idle", manual_status_set_at: at };
  assert.deepEqual(agentStatusPresentation(base), { version: null, status: "Available", pendingStatus: null, pendingSince: null });
  assert.deepEqual(agentStatusPresentation({ ...base, workflow_state: "handling" }), { version: null, status: "Busy", pendingStatus: null, pendingSince: null });
  assert.deepEqual(agentStatusPresentation({ ...base, workflow_state: "handling", manual_status: "Away" }), { version: null, status: "Busy", pendingStatus: "Away", pendingSince: at });
  assert.deepEqual(agentStatusPresentation({ ...base, workflow_state: "offered", manual_status: "Break" }), { version: null, status: "Busy", pendingStatus: "Break", pendingSince: at });
  assert.deepEqual(agentStatusPresentation({ ...base, workflow_state: "wrapup", manual_status: "Break" }), { version: null, status: "Wrapup", pendingStatus: "Break", pendingSince: at });
  // Once the work ends the manual status is simply the status; nothing is pending.
  assert.deepEqual(agentStatusPresentation({ ...base, manual_status: "Away" }), { version: null, status: "Away", pendingStatus: null, pendingSince: null });
  assert.deepEqual(agentStatusPresentation({ ...base, presence: "offline", manual_status: "Away" }), { version: null, status: "Offline", pendingStatus: null, pendingSince: null });
  assert.deepEqual(agentStatusPresentation(null), { version: null, status: "Offline", pendingStatus: null, pendingSince: null });
});

test("a break chosen while handling stays pending, blocks new offers with a visible reason and applies when the work ends", { skip }, async () => {
  const f = await fixture();
  const first = await acceptChat(f);
  assert.equal(effectiveAgentStatus(await state(f.agentId)), "Busy");

  assert.equal(await setManualAgentStatus(pool, { agentId: f.agentId, status: "Away" }), "Busy");
  const stored = await state(f.agentId);
  assert.equal(stored.manual_status, "Away");
  assert.ok(stored.manual_status_set_at, "the choice is timestamped for the UI");
  assert.equal(stored.routability, "not_routable");

  // Every read model agrees: effective Busy with Away pending.
  const presentation = await readAgentStatusPresentation(pool, f.agentId);
  assert.equal(presentation.status, "Busy");
  assert.equal(presentation.pendingStatus, "Away");
  assert.equal(presentation.pendingSince, new Date(stored.manual_status_set_at).toISOString());
  const snapshot = await readAgentSnapshot(pool, f.agentId);
  assert.equal(snapshot.agent.status, "Busy");
  assert.equal(snapshot.agent.pendingStatus, "Away");
  assert.equal(snapshot.agent.pendingSince, presentation.pendingSince);
  assert.equal(await pendingBySql(f.agentId), "Away");
  const monitorRow = (await readMonitorStatistics(pool)).agents.find((row) => row.userId === f.agentId);
  assert.equal(monitorRow.status, "Busy");
  assert.equal(monitorRow.pendingStatus, "Away");
  assert.equal(monitorRow.pendingSince, presentation.pendingSince);
  const statusEvent = (await pool.query(
    "SELECT payload FROM acd_events WHERE agent_id=$1 AND type='agent_manual_status_changed' ORDER BY id DESC LIMIT 1", [f.agentId],
  )).rows[0].payload;
  assert.equal(statusEvent.pending, true);
  assert.equal(statusEvent.pending_status, "Away");

  // A second chat is not offered although the agent has free chat capacity, and
  // the supervisor sees which status is blocking.
  const second = await queueChat(f);
  const refused = await routeOne(pool, second.id);
  assert.equal(refused.routed, false);
  let events = await blockingEvents(second.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "agent_not_routable");
  assert.deepEqual(events[0].pending_statuses, ["Away"]);
  assert.deepEqual(events[0].blocked_by_status, []);
  const waiting = (await getAcdRealtimeQueueCalls(pool, f.queueId)).find((row) => row.workItemId === second.id);
  assert.equal(waiting.waitingReason, "Agent status blocks offers (Away pending)");
  // The polling worker re-evaluates every tick; identical outcomes are journaled once.
  await routeOne(pool, second.id);
  await routeOne(pool, second.id);
  events = await blockingEvents(second.id);
  assert.equal(events.length, 1, "unchanged outcome is not journaled again");

  // The chosen status becomes effective only after the interaction and its wrap-up end.
  await disconnectChat(f, first);
  const wrapping = await readAgentStatusPresentation(pool, f.agentId);
  assert.deepEqual([wrapping.status, wrapping.pendingStatus], ["Wrapup", "Away"]);
  const wrapup = await completeTextWrapup(pool, { workItemId: first.id, expectedAgentId: f.agentId, wrapupCodeId: "resolved" });
  assert.equal(wrapup.completed, true);
  const done = await readAgentStatusPresentation(pool, f.agentId);
  assert.deepEqual(done, { version: String((await state(f.agentId)).version), status: "Away", pendingStatus: null, pendingSince: null });
  assert.equal(await pendingBySql(f.agentId), null);
  // Once Away is effective the reason names it as the current status.
  await routeOne(pool, second.id);
  events = await blockingEvents(second.id);
  assert.deepEqual(events.at(-1).blocked_by_status, ["Away"]);
  assert.deepEqual(events.at(-1).pending_statuses, []);
  const stillWaiting = (await getAcdRealtimeQueueCalls(pool, f.queueId)).find((row) => row.workItemId === second.id);
  assert.equal(stillWaiting.waitingReason, "Agent status blocks offers (Away)");
});

test("choosing Available while busy cancels the pending status and offers resume", { skip }, async () => {
  const f = await fixture();
  const first = await acceptChat(f);
  await setManualAgentStatus(pool, { agentId: f.agentId, status: "Away" });
  assert.equal((await readAgentStatusPresentation(pool, f.agentId)).pendingStatus, "Away");

  assert.equal(await setManualAgentStatus(pool, { agentId: f.agentId, status: "Available" }), "Busy");
  const presentation = await readAgentStatusPresentation(pool, f.agentId);
  assert.deepEqual([presentation.status, presentation.pendingStatus], ["Busy", null]);
  assert.equal((await state(f.agentId)).manual_status, "Available");

  const second = await acceptChat(f);
  assert.notEqual(second.id, first.id);
  assert.equal(effectiveAgentStatus(await state(f.agentId)), "Busy");
});

test("a supervisor-style change during wrap-up is pending until the wrap-up completes", { skip }, async () => {
  const f = await fixture();
  const work = await acceptChat(f);
  await disconnectChat(f, work);
  assert.equal(await setManualAgentStatus(pool, { agentId: f.agentId, status: "Break", actor: "supervisor:test" }), "Wrapup");
  const during = await readAgentStatusPresentation(pool, f.agentId);
  assert.deepEqual([during.status, during.pendingStatus], ["Wrapup", "Break"]);
  const wrapup = await completeTextWrapup(pool, { workItemId: work.id, expectedAgentId: f.agentId, wrapupCodeId: "resolved" });
  assert.equal(wrapup.completed, true);
  const after = await state(f.agentId);
  assert.deepEqual([after.workflow_state, after.manual_status, effectiveAgentStatus(after)], ["idle", "Break", "Break"]);
});
