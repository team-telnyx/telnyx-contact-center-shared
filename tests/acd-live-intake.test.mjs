// Phase B live intake — end-to-end behavioral tests on real PostgreSQL
// (the internal documentation §8.1, §10 Phase B, §11 matrix).
// Simulates the exact webhook sequences the routes deliver, with a scriptable
// fake provider, and asserts canonical Core state plus the Core-derived
// history read model used by the operator interfaces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  prepareAcdTestPool,
  seedAgent as seedAgentIn,
  seedQueue as seedQueueIn,
  makeFakeProvider,
} from "./helpers/acd-test-db.mjs";
import { routeAcdVoiceEvent, routeAndConnect } from "../lib/acd/live-intake.mjs";
import { persistWebhookEvent } from "../lib/acd/inbox.mjs";
import { drainInboxOnce, drainQueuedOnce } from "../lib/acd/worker.mjs";
import { sweepDueSagas, sweepStalledSagas, applySagaEvent } from "../lib/acd/saga-engine.mjs";
import { checkInvariants } from "../lib/acd/lifecycle.mjs";
import { getDurableQueueMetrics } from "../lib/acd/realtime-queue-metrics.mjs";
import { setManualAgentStatus } from "../lib/acd/agent-state.mjs";
import { hydrateAcdInteractionTimeline } from "../lib/acd/history-projection.mjs";
import { executeAcdOperation } from '../lib/acd/operations.mjs';
import {
  encodeAcdClientState,
  materializeAcdIntakeState,
} from "../lib/acd/intake-source.mjs";

const pool = await prepareAcdTestPool("acd_core_test_live");
const skip = pool ? false : "PostgreSQL not reachable — skipping ACD live-intake tests";
const seedAgent = (agentId, overrides) => seedAgentIn(pool, agentId, overrides);
const seedQueue = (queueId, agentIds, overrides) => seedQueueIn(pool, queueId, agentIds, overrides);

function evt(eventType, payload, eventId = `evt-${randomUUID().slice(0, 12)}`) {
  return { eventId, eventType, occurredAt: new Date().toISOString(), payload };
}

function enqueuedPayload({ queueName, sessionId, customerCcid, clientState = null }) {
  return {
    queue: queueName,
    call_session_id: sessionId,
    call_control_id: customerCcid,
    from: "+15550007777",
    to: "+15550008888",
    ...(clientState ? { client_state: clientState } : {}),
  };
}

async function workItemBySession(sessionId) {
  const result = await pool.query(
    `SELECT * FROM acd_work_items WHERE attributes->>'call_session_id' = $1
      ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );
  return result.rows[0] || null;
}

async function projectionRow(workItemId) {
  const result = await pool.query(
    `SELECT * FROM acd_history_interactions WHERE work_item_id = $1`,
    [workItemId],
  );
  return hydrateAcdInteractionTimeline(pool, result.rows[0] || null);
}

async function bindDeviceLeg(provider, workItem, deviceCcid = `v3:dev${randomUUID().replaceAll("-", "")}`) {
  const result = await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.initiated", {
      call_control_id: deviceCcid,
      call_session_id: `agent-session-${randomUUID().slice(0, 8)}`,
      direction: "incoming",
      custom_headers: [
        { name: "X-CC-Work-Item-Id", value: workItem.id },
        { name: "X-CC-Offer-Generation", value: "1" },
      ],
    }),
    { node: "test" },
  );
  assert.equal(result.outcome, "applied", JSON.stringify(result));
  return deviceCcid;
}

async function answerAndBridge(provider, workItem, customerCcid, deviceCcid) {
  await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.answered", { call_control_id: deviceCcid }),
    { node: "test" },
  );
  const beforeBridge = await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(beforeBridge.rows[0].state, "offered");
  await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.bridged", { call_control_id: customerCcid }),
    { node: "test" },
  );
}

function coreSetup({ agents = 1 } = {}) {
  const queueId = `queue-${randomUUID().slice(0, 8)}`;
  const agentIds = Array.from({ length: agents }, () => `agent-${randomUUID().slice(0, 8)}`);
  const queueName = `Core ${queueId}`;
  return {
    queueId,
    queueName,
    agentIds,
    async seed() {
      for (const a of agentIds) await seedAgent(a, { legacyStatus: "Available" });
      await seedQueue(queueId, agentIds, { name: queueName, answerTimeout: 15 });
    },
  };
}

test("a configured voice queue is always admitted by Core", { skip }, async () => {
  const setup = coreSetup({ agents: 0 });
  await setup.seed();
  const provider = makeFakeProvider();
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const customerCcid = `v3:${"c".repeat(24)}`;
  const result = await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.enqueued", enqueuedPayload({ queueName: setup.queueName, sessionId, customerCcid })),
  );
  assert.equal(result.handled, true);
  assert.equal(result.handledEnqueued, true);
  assert.equal(result.outcome, "applied");
  const workItem = await workItemBySession(sessionId);
  assert.ok(workItem);
  assert.equal(workItem.state, "queued");
  assert.equal(provider.calls.length, 0);
  await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.hangup", { call_control_id: customerCcid, hangup_source: "test_cleanup" }),
  );
});

test("both webhook routes propagate retryable Core admission failures as HTTP 503", async () => {
  const routes = [
    {
      resultName: "acdIntakeResult",
      path: "../app/api/voice/webhook/incoming/[flowId]/route.js",
    },
    {
      resultName: "admission",
      path: "../app/api/voice/webhook/route.js",
    },
  ];

  for (const { resultName, path } of routes) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.ok(source.includes(`if (${resultName}?.retryable)`), path);
    assert.ok(source.includes(`status: ${resultName}.httpStatus || 503`), path);
    assert.ok(source.includes(`headers: { "Retry-After": "1" }`), path);
  }
});

test("core status source stores explicit, idempotent break intervals", { skip }, async () => {
  const setup = coreSetup();
  await setup.seed();
  const agentId = setup.agentIds[0];

  await setManualAgentStatus(pool, {
    agentId,
    status: "Break",
    actor: "test_break_started",
  });
  await setManualAgentStatus(pool, {
    agentId,
    status: "Break",
    actor: "duplicate_break_projection",
  });
  await setManualAgentStatus(pool, {
    agentId,
    status: "Available",
    actor: "test_break_ended",
  });

  const intervals = await pool.query(
    `SELECT status, next_status, status_type
       FROM cc_agent_status_intervals
      WHERE user_id = $1 ORDER BY started_at, created_at`,
    [agentId],
  );
  assert.deepEqual(
    intervals.rows.map((row) => [row.status, row.next_status, row.status_type]),
    [["Available", "Break", "active"], ["Break", "Available", "break"]],
  );
});

test("core queue: enqueued → routed → dialed → answered → hangup, full projection", { skip }, async () => {
  const setup = coreSetup();
  await setup.seed();
  const agentLegCcid = `v3:agentleg${randomUUID().replaceAll("-", "")}`;
  const provider = makeFakeProvider([
    { outcome: "accepted", httpStatus: 200, response: { data: { call_control_id: agentLegCcid } } },
  ]);
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const customerCcid = `v3:cust${randomUUID().replaceAll("-", "")}`;
  const agentAssistConfig = {
    enabled: true,
    assist_type: "workflows",
    workflow_id: "workflow-agent-assist-prod",
  };
  const telnyxSttConfig = {
    enabled: true,
    transcription_tracks: "both",
    transcription_engine: "Google",
    model: "phone_call",
    language: "en",
  };
  const clientState = Buffer.from(
    JSON.stringify({
      call_priority: 4,
      required_skills: { language: 4 },
      agent_assist_config: agentAssistConfig,
      telnyx_stt_config: telnyxSttConfig,
      workflow_data: { customer_tier: "gold" },
      caller_language: "en-US",
    }),
  ).toString("base64");

  const enq = await routeAcdVoiceEvent(
    pool,
    provider,
    evt(
      "call.enqueued",
      enqueuedPayload({
        queueName: setup.queueName,
        sessionId,
        customerCcid,
        clientState,
      }),
    ),
    { node: "test" },
  );
  assert.equal(enq.handled, true);
  assert.equal(enq.handledEnqueued, true);
  assert.equal(enq.outcome, "applied");

  const workItem = await workItemBySession(sessionId);
  assert.ok(workItem);
  assert.equal(workItem.state, "offered"); // routed immediately
  assert.equal(workItem.priority, 4);
  assert.deepEqual(workItem.required_skills, { language: 4 });
  assert.deepEqual(workItem.attributes.agent_assist_config, agentAssistConfig);
  assert.deepEqual(workItem.attributes.telnyx_stt_config, telnyxSttConfig);
  assert.deepEqual(workItem.attributes.workflow_data, { customer_tier: "gold" });

  // Provider got the transfer with legacy-proven parameters.
  const call = provider.calls.find((entry) => entry.operation === "transfer_to_agent");
  assert.ok(call);
  assert.equal(call.endpoint, `/calls/${encodeURIComponent(customerCcid)}/actions/transfer`);
  assert.equal(call.request.connection_id, `cred-${setup.agentIds[0]}`);
  assert.match(call.request.to, new RegExp(`^sip:${setup.agentIds[0]}@sip\\.telnyx\\.com$`));
  assert.equal(call.request.park_after_unbridge, "self");
  const targetLegClientState = JSON.parse(
    Buffer.from(call.request.target_leg_client_state, "base64").toString("utf8"),
  );
  assert.deepEqual(targetLegClientState.telnyx_stt_config, telnyxSttConfig);
  assert.deepEqual(targetLegClientState.agent_assist_config, agentAssistConfig);

  // The transfer response proves only the TRANSPORT sibling — the device leg
  // would bind from its own call.initiated headers (PROD 2026-08-02 fix).
  const legs = await pool.query(
    `SELECT role, provider_call_id, state FROM acd_legs WHERE work_item_id = $1 ORDER BY role`,
    [workItem.id],
  );
  assert.deepEqual(
    legs.rows.map((l) => [l.role, l.state]),
    [["agent_transport", "ringing"], ["customer", "answered"]],
  );
  const intent = await pool.query(
    `SELECT state, transport_call_id FROM acd_leg_intents WHERE work_item_id = $1`,
    [workItem.id],
  );
  assert.equal(intent.rows[0].state, "pending");
  assert.equal(intent.rows[0].transport_call_id, agentLegCcid);

  // The Core-derived history read model preserves provider identity for UI
  // and supervision without a second mutable interaction record.
  let projected = await projectionRow(workItem.id);
  assert.ok(projected);
  assert.equal(projected.state, "ringing");
  assert.equal(projected.queue_name, setup.queueName);
  assert.equal(projected.agent_username, `${setup.agentIds[0]}@test.local`);
  assert.equal(projected.call_control_id, customerCcid);
  assert.equal(projected.call_session_id, sessionId);
  assert.deepEqual(projected.metadata.agent_assist_config, agentAssistConfig);
  assert.deepEqual(projected.metadata.telnyx_stt_config, telnyxSttConfig);
  assert.deepEqual(projected.metadata.workflow_data, { customer_tier: "gold" });
  assert.equal(projected.metadata.caller_language, "en-US");
  assert.equal(
    projected.metadata.agent_transport_call_control_id,
    agentLegCcid,
  );

  const deviceCcid = await bindDeviceLeg(provider, workItem);
  await answerAndBridge(provider, workItem, customerCcid, deviceCcid);

  const midCall = await pool.query(
    `SELECT w.state AS wi_state, r.state AS res_state
       FROM acd_work_items w JOIN acd_reservations r ON r.work_item_id = w.id
      WHERE w.id = $1`,
    [workItem.id],
  );
  assert.equal(midCall.rows[0].wi_state, "active");
  assert.equal(midCall.rows[0].res_state, "active");
  const agentStatus = await pool.query(`SELECT workflow_state FROM acd_agent_state WHERE agent_id = $1`, [setup.agentIds[0]]);
  assert.equal(agentStatus.rows[0].workflow_state, "handling");
  projected = await projectionRow(workItem.id);
  assert.equal(projected.state, "connected");
  assert.ok(projected.answered_at);
  assert.deepEqual(
    projected.routing_metadata.timeline.map((event) => event.type),
    ["enqueued", "alerting", "answered", "connected"],
  );

  // Customer hangs up → one-transaction finalize.
  const bye = await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.hangup", { call_control_id: customerCcid, hangup_cause: "normal_clearing" }),
    { node: "test" },
  );
  assert.equal(bye.handled, true);
  assert.equal((await pool.query(`SELECT state FROM acd_reservations WHERE work_item_id=$1`,[workItem.id])).rows[0].state,'active');
  await routeAcdVoiceEvent(pool,provider,evt('call.hangup',{call_control_id:deviceCcid}),{node:'test'});

  const final = await pool.query(
    `SELECT w.state AS wi_state, w.terminal_reason, r.state AS res_state, r.released_reason
       FROM acd_work_items w JOIN acd_reservations r ON r.work_item_id = w.id
      WHERE w.id = $1`,
    [workItem.id],
  );
  assert.equal(final.rows[0].wi_state, "completed");
  assert.equal(final.rows[0].res_state, "released");
  assert.equal(final.rows[0].released_reason, "completed");
  projected = await projectionRow(workItem.id);
  assert.equal(projected.state, "completed");
  assert.ok(projected.completed_at);
  assert.deepEqual(
    projected.routing_metadata.timeline.map((event) => event.type),
    [
      "enqueued",
      "alerting",
      "answered",
      "connected",
      "disconnected",
      "wrapup_start",
    ],
  );
  const wrapupStatus = await pool.query(`SELECT workflow_state FROM acd_agent_state WHERE agent_id = $1`, [setup.agentIds[0]]);
  assert.equal(wrapupStatus.rows[0].workflow_state, "wrapup");
  const sourceSegments = await pool.query(
    `SELECT kind, started_at, answered_at, ended_at, outcome
       FROM acd_segments WHERE work_item_id = $1 ORDER BY seq`,
    [workItem.id],
  );
  assert.deepEqual(
    sourceSegments.rows.map((segment) => [segment.kind, segment.outcome]),
    [["queue_wait", "answered"], ["agent", "completed"]],
  );
  assert.ok(sourceSegments.rows[0].answered_at);
  assert.ok(sourceSegments.rows[0].ended_at);
  assert.ok(sourceSegments.rows[1].answered_at);
  assert.ok(sourceSegments.rows[1].ended_at);
  assert.equal(
    sourceSegments.rows[0].ended_at.toISOString(),
    sourceSegments.rows[1].started_at.toISOString(),
  );

  const statusIntervals = await pool.query(
    `SELECT status, next_status, status_type, source, work_item_id
       FROM cc_agent_status_intervals
      WHERE user_id = $1 ORDER BY started_at`,
    [setup.agentIds[0]],
  );
  assert.deepEqual(
    statusIntervals.rows.map((interval) => [
      interval.status,
      interval.next_status,
      interval.status_type,
    ]),
    [["Available", "Busy", "active"], ["Busy", "Wrapup", "active"]],
  );
  assert.ok(statusIntervals.rows.every((interval) => interval.source === "acd_core"));
  assert.ok(statusIntervals.rows.every((interval) => interval.work_item_id === workItem.id));
  assert.deepEqual(await checkInvariants(pool), {});
});

test("duplicate and redelivered enqueued events create exactly one work item", { skip }, async () => {
  const setup = coreSetup();
  await setup.seed();
  const provider = makeFakeProvider([
    { outcome: "accepted", httpStatus: 200, response: { data: { call_control_id: `v3:al${"e".repeat(24)}` } } },
  ]);
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const payload = enqueuedPayload({ queueName: setup.queueName, sessionId, customerCcid: `v3:cu${"e".repeat(24)}` });

  const first = evt("call.enqueued", payload);
  await routeAcdVoiceEvent(pool, provider, first, { node: "test" });
  // Same event id (provider retry of the same delivery).
  const dup = await routeAcdVoiceEvent(pool, provider, { ...first }, { node: "test" });
  assert.equal(dup.outcome, "duplicate");
  // Fresh event id, same session (redelivery after ack loss).
  const redelivery = await routeAcdVoiceEvent(pool, provider, evt("call.enqueued", payload), { node: "test" });
  assert.equal(redelivery.outcome, "noop");

  const count = await pool.query(
    `SELECT count(*)::int AS n FROM acd_work_items WHERE attributes->>'call_session_id' = $1`,
    [sessionId],
  );
  assert.equal(count.rows[0].n, 1);
});

test("duplicate enqueued delivery resumes a retryable inbox row after failed intake", { skip }, async () => {
  const setup = coreSetup();
  await setup.seed();
  const provider = makeFakeProvider();
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const event = evt(
    "call.enqueued",
    enqueuedPayload({
      queueName: setup.queueName,
      sessionId,
      customerCcid: `v3:replay${randomUUID().replaceAll("-", "")}`,
    }),
  );

  // Simulate a failed first attempt whose durable row is ready for retry.
  await persistWebhookEvent(pool, event);
  await pool.query(
    `UPDATE acd_webhook_events
        SET status = 'retryable_failed', next_attempt_at = now()
      WHERE event_id = $1`,
    [event.eventId],
  );
  assert.equal(await workItemBySession(sessionId), null);

  const replay = await routeAcdVoiceEvent(pool, provider, event, { node: "redelivery" });
  assert.equal(replay.outcome, "applied");
  assert.ok(await workItemBySession(sessionId));

  const inbox = await pool.query(
    `SELECT status, attempt_count FROM acd_webhook_events WHERE event_id = $1`,
    [event.eventId],
  );
  assert.equal(inbox.rows[0].status, "applied");
  assert.equal(inbox.rows[0].attempt_count, 1);
});

test("durable inbox worker recovers enqueued intake without provider redelivery", { skip }, async () => {
  const setup = coreSetup();
  await setup.seed();
  const provider = makeFakeProvider();
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const event = evt(
    "call.enqueued",
    enqueuedPayload({
      queueName: setup.queueName,
      sessionId,
      customerCcid: `v3:worker${randomUUID().replaceAll("-", "")}`,
    }),
  );

  await persistWebhookEvent(pool, event);
  assert.equal(await workItemBySession(sessionId), null);

  const drained = await drainInboxOnce(pool, provider, { node: "recovery-worker", limit: 100 });
  assert.ok(drained.claimed >= 1);
  assert.ok(await workItemBySession(sessionId));

  const inbox = await pool.query(
    `SELECT status, lease_owner, processed_at FROM acd_webhook_events WHERE event_id = $1`,
    [event.eventId],
  );
  assert.equal(inbox.rows[0].status, "applied");
  assert.equal(inbox.rows[0].lease_owner, null);
  assert.ok(inbox.rows[0].processed_at);
});

test("Core admission failure without an inbox row requests provider retry", { skip }, async () => {
  const setup = coreSetup({ agents: 0 });
  await setup.seed();
  const event = evt(
    "call.enqueued",
    enqueuedPayload({
      queueName: setup.queueName,
      sessionId: `sess-${randomUUID().slice(0, 10)}`,
      customerCcid: `v3:failure${randomUUID().replaceAll("-", "")}`,
    }),
  );
  const failingPool = {
    connect: (...args) => pool.connect(...args),
    query: (sql, params) => {
      if (/INSERT INTO acd_webhook_events/.test(String(sql))) {
        throw new Error("simulated inbox write failure");
      }
      return pool.query(sql, params);
    },
  };

  const result = await routeAcdVoiceEvent(failingPool, makeFakeProvider(), event, {
    node: "failing-web",
  });
  assert.equal(result.handled, true);
  assert.equal(result.handledEnqueued, undefined);
  assert.equal(result.retryable, true);
  assert.equal(result.httpStatus, 503);
  assert.equal(result.error, true);
  assert.match(result.reason, /simulated inbox write failure/);
  const inbox = await pool.query(
    `SELECT event_id FROM acd_webhook_events WHERE event_id = $1`,
    [event.eventId],
  );
  assert.equal(inbox.rows.length, 0);
});

test("failure after durable Core admission is ACK-safe for inbox replay", { skip }, async () => {
  const setup = coreSetup({ agents: 0 });
  await setup.seed();
  const event = evt(
    "call.enqueued",
    enqueuedPayload({
      queueName: setup.queueName,
      sessionId: `sess-${randomUUID().slice(0, 10)}`,
      customerCcid: `v3:durable${randomUUID().replaceAll("-", "")}`,
    }),
  );
  const failingPool = {
    connect: (...args) => pool.connect(...args),
    query: (sql, params) => {
      if (/UPDATE acd_webhook_events e\s+SET status = 'processing'/.test(String(sql))) {
        throw new Error("simulated claim failure after admission");
      }
      return pool.query(sql, params);
    },
  };

  const result = await routeAcdVoiceEvent(failingPool, makeFakeProvider(), event, {
    node: "durable-failing-web",
  });
  assert.equal(result.handled, true);
  assert.equal(result.handledEnqueued, true);
  assert.equal(result.retryable, undefined);
  assert.equal(result.error, true);
  assert.match(result.reason, /simulated claim failure after admission/);
  const inbox = await pool.query(
    `SELECT status FROM acd_webhook_events WHERE event_id = $1`,
    [event.eventId],
  );
  assert.deepEqual(inbox.rows[0], { status: "received" });
});

test("Core intake materializes complete routing context", { skip }, async () => {
  const setup = coreSetup({ agents: 0 });
  await setup.seed();
  const provider = makeFakeProvider();
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const customerCcid = `v3:adopt${randomUUID().replaceAll("-", "")}`;
  const from = "+15551112222";
  const to = "+15553334444";
  const clientState = encodeAcdClientState(
    materializeAcdIntakeState({
      clientState: {
        call_priority: 7,
        required_skills: {},
        agent_assist_config: { enabled: true },
        telnyx_stt_config: { language: "en-US" },
        workflow_data: { caseId: "case-42" },
        caller_language: "en-US",
        agent_language: "pl-PL",
      },
      payload: { from, to, call_session_id: sessionId },
      flowId: "flow-core-only",
    }),
  );

  const result = await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.enqueued", {
      queue: setup.queueName,
      call_session_id: sessionId,
      call_control_id: customerCcid,
      from,
      to,
      client_state: clientState,
    }),
    { node: "test" },
  );
  assert.equal(result.outcome, "applied");
  const workItem = await workItemBySession(sessionId);
  assert.equal(workItem.customer_address, from);
  assert.equal(workItem.cc_address, to);
  assert.equal(workItem.priority, 7);
  assert.deepEqual(workItem.attributes.agent_assist_config, { enabled: true });
  assert.deepEqual(workItem.attributes.telnyx_stt_config, { language: "en-US" });
  assert.deepEqual(workItem.attributes.workflow_data, { caseId: "case-42" });
  assert.equal(workItem.attributes.caller_language, "en-US");
  assert.equal(workItem.attributes.agent_language, "pl-PL");
  const projection = await projectionRow(workItem.id);
  assert.ok(projection);
  assert.equal(projection.from_number, from);
  assert.equal(projection.to_number, to);

  const metrics = await getDurableQueueMetrics(pool, setup.queueId);
  assert.equal(metrics.waitingCalls, 1);
  assert.equal(metrics.queuedCalls, 1);
  assert.ok(metrics.longestWaitSeconds >= 0);

  await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.hangup", { call_control_id: customerCcid, hangup_source: "test_cleanup" }),
    { node: "test" },
  );
});

test("core intake resolves every CC contact phone field for projection and agent transfer", { skip }, async () => {
  const setup = coreSetup({ agents: 1 });
  await setup.seed();
  const provider = makeFakeProvider();
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const customerCcid = `v3:name${randomUUID().replaceAll("-", "")}`;
  const callerNumber = "+48600000001";
  await pool.query(
    `INSERT INTO contacts
       (id, first_name, last_name, phone, business_phone_1, created_at)
     VALUES ($1, 'Demo', 'User', '+48220000055', $2, now())`,
    [`contact-${randomUUID()}`, callerNumber],
  );

  const result = await routeAcdVoiceEvent(
    pool,
    provider,
    evt(
      "call.enqueued",
      {
        ...enqueuedPayload({
          queueName: setup.queueName,
          sessionId,
          customerCcid,
        }),
        from: callerNumber,
      },
    ),
    { node: "test" },
  );
  assert.equal(result.outcome, "applied");

  const workItem = await workItemBySession(sessionId);
  assert.equal(workItem.attributes.customer_name, "Demo User");
  assert.equal(workItem.attributes.customer_identity_source, "contacts");
  const projected = await projectionRow(workItem.id);
  assert.equal(projected.from_name, "Demo User");
  const transfer = provider.calls.find(
    (entry) => entry.operation === "transfer_to_agent",
  );
  assert.equal(transfer.request.caller_id_name, "Demo User");

  const historical = await projectionRow(workItem.id);
  assert.equal(historical.from_name, "Demo User");
});

test("no-answer: deadline compensation requeues; worker re-routes to the other agent", { skip }, async () => {
  const setup = coreSetup({ agents: 2 });
  await setup.seed();
  const provider = makeFakeProvider(); // default accepted, no leg id in response
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const customerCcid = `v3:cu2${randomUUID().replaceAll("-", "")}`;

  await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.enqueued", enqueuedPayload({ queueName: setup.queueName, sessionId, customerCcid })),
    { node: "test" },
  );
  const workItem = await workItemBySession(sessionId);
  const firstOffer = await pool.query(
    `SELECT agent_id, generation FROM acd_offers WHERE work_item_id = $1`, [workItem.id],
  );
  const firstAgent = firstOffer.rows[0].agent_id;

  // Force the dial deadline and let the reconciler-side sweep compensate.
  await pool.query(
    `UPDATE acd_sagas SET deadline_at = now() - interval '1 second' WHERE work_item_id = $1`,
    [workItem.id],
  );
  assert.equal(await sweepDueSagas(pool, { provider }), 1);

  const requeued = await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(requeued.rows[0].state, "queued");
  assert.equal((await projectionRow(workItem.id)).state, "queued");
  const enqueueCall = provider.calls.find((call) => call.operation === "enqueue_customer_leg");
  assert.ok(enqueueCall);
  assert.equal(enqueueCall.endpoint, `/calls/${encodeURIComponent(customerCcid)}/actions/enqueue`);
  assert.equal(enqueueCall.request.queue_name, setup.queueName);
  const noAnswerStatus = await pool.query(
    `SELECT manual_status FROM acd_agent_state WHERE agent_id = $1`,
    [firstAgent],
  );
  assert.equal(noAnswerStatus.rows[0].manual_status, "Agent Not Answering");

  // Worker drain picks it up and offers generation 2 to the OTHER agent
  // (the no-answer agent is still saga-cooled/handling per acd state).
  const results = await drainQueuedOnce(pool, provider, { node: "test-worker" });
  assert.ok(results.some((result) => result.routed === true));
  const secondOffer = await pool.query(
    `SELECT agent_id, generation FROM acd_offers WHERE work_item_id = $1 ORDER BY generation DESC LIMIT 1`,
    [workItem.id],
  );
  assert.equal(Number(secondOffer.rows[0].generation), 2);
  assert.notEqual(secondOffer.rows[0].agent_id, firstAgent);
  assert.deepEqual(await checkInvariants(pool), {});
});

test("header-based binding when the transfer response carries no leg id", { skip }, async () => {
  const setup = coreSetup();
  await setup.seed();
  const provider = makeFakeProvider([
    { outcome: "accepted", httpStatus: 200, response: { data: { result: "ok" } } }, // no call_control_id
  ]);
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const customerCcid = `v3:cu3${randomUUID().replaceAll("-", "")}`;

  await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.enqueued", enqueuedPayload({ queueName: setup.queueName, sessionId, customerCcid })),
    { node: "test" },
  );
  const workItem = await workItemBySession(sessionId);

  // No agent leg yet — the response did not prove one.
  const before = await pool.query(
    `SELECT count(*)::int AS n FROM acd_legs WHERE work_item_id = $1 AND role = 'agent_device'`,
    [workItem.id],
  );
  assert.equal(before.rows[0].n, 0);

  // The outgoing transport webhook is the first authoritative proof of the
  // media leg when the transfer response omits it.
  const transportCcid = `v3:transport${randomUUID().replaceAll("-", "")}`;
  const transportInit = await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.initiated", {
      call_control_id: transportCcid,
      direction: "outgoing",
      custom_headers: [
        { name: "X-CC-Work-Item-Id", value: workItem.id },
        { name: "X-CC-Offer-Generation", value: "1" },
      ],
    }),
    { node: "test" },
  );
  assert.equal(transportInit.handled, true);
  assert.equal(transportInit.outcome, "applied");
  const projectedAfterTransport = await projectionRow(workItem.id);
  assert.equal(
    projectedAfterTransport.metadata.agent_transport_call_control_id,
    transportCcid,
  );

  // call.initiated for the device leg carries the same generation-fenced headers.
  const deviceCcid = `v3:dev${randomUUID().replaceAll("-", "")}`;
  const init = await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.initiated", {
      call_control_id: deviceCcid,
      direction: "incoming",
      custom_headers: [
        { name: "X-CC-Work-Item-Id", value: workItem.id },
        { name: "X-CC-Offer-Generation", value: "1" },
      ],
    }),
    { node: "test" },
  );
  assert.equal(init.handled, true);
  assert.equal(init.outcome, "applied");

  // Now the answered webhook advances the saga by exact id.
  const ans = await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.answered", { call_control_id: deviceCcid }),
    { node: "test" },
  );
  assert.equal(ans.outcome, "applied");
  const beforeBridge = await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(beforeBridge.rows[0].state, "offered");
  await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.bridged", { call_control_id: customerCcid }),
    { node: "test" },
  );
  const state = await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(state.rows[0].state, "active");
  const roles = await pool.query(
    `SELECT role FROM acd_legs WHERE work_item_id = $1 AND role LIKE 'agent_%' ORDER BY role`,
    [workItem.id],
  );
  assert.deepEqual(roles.rows.map((row) => row.role), [
    "agent_device",
    "agent_transport",
  ]);
});

test("late events after completion are absorbed as noop", { skip }, async () => {
  const setup = coreSetup();
  await setup.seed();
  const agentLegCcid = `v3:al4${randomUUID().replaceAll("-", "")}`;
  const provider = makeFakeProvider([
    { outcome: "accepted", httpStatus: 200, response: { data: { call_control_id: agentLegCcid } } },
  ]);
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const customerCcid = `v3:cu4${randomUUID().replaceAll("-", "")}`;

  await routeAcdVoiceEvent(pool, provider, evt("call.enqueued", enqueuedPayload({ queueName: setup.queueName, sessionId, customerCcid })), { node: "test" });
  const workItemBeforeConnect = await workItemBySession(sessionId);
  const deviceCcid = await bindDeviceLeg(provider, workItemBeforeConnect);
  await answerAndBridge(provider, workItemBeforeConnect, customerCcid, deviceCcid);
  await routeAcdVoiceEvent(pool, provider, evt("call.hangup", { call_control_id: customerCcid }), { node: "test" });

  const workItem = await workItemBySession(sessionId);
  assert.equal(workItem.state, "completed");

  // A late duplicate hangup for the agent leg (fresh event id) cannot regress anything.
  const late = await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.hangup", { call_control_id: agentLegCcid }),
    { node: "test" },
  );
  assert.equal(late.handled, true);
  const after = await pool.query(`SELECT state, version FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(after.rows[0].state, "completed");
  assert.equal((await projectionRow(workItem.id)).state, "completed");
  const terminalRedelivery = await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.enqueued", enqueuedPayload({
      queueName: setup.queueName,
      sessionId,
      customerCcid,
    })),
    { node: "test" },
  );
  assert.equal(terminalRedelivery.outcome, "noop");
  const count = await pool.query(
    `SELECT count(*)::int AS n FROM acd_work_items WHERE attributes->>'call_session_id' = $1`,
    [sessionId],
  );
  assert.equal(count.rows[0].n, 1);
  assert.deepEqual(await checkInvariants(pool), {});
});

test("customer hangup while queued (no saga) abandons the work item", { skip }, async () => {
  const setup = coreSetup({ agents: 0 }); // no agents → stays queued
  await setup.seed();
  const provider = makeFakeProvider();
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const customerCcid = `v3:cu5${randomUUID().replaceAll("-", "")}`;

  await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.enqueued", enqueuedPayload({ queueName: setup.queueName, sessionId, customerCcid })),
    { node: "test" },
  );
  const workItem = await workItemBySession(sessionId);
  assert.equal(workItem.state, "queued");

  // PROD 2026-08-02: callers hung up while queued and the items stayed
  // 'queued' forever. Now: terminal abandon + projection update.
  const bye = await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.hangup", { call_control_id: customerCcid, hangup_source: "caller" }),
    { node: "test" },
  );
  assert.equal(bye.handled, true);
  assert.equal(bye.outcome, "applied");

  const after = await pool.query(`SELECT state, terminal_reason FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(after.rows[0].state, "abandoned");
  assert.equal(after.rows[0].terminal_reason, "customer_hangup_in_queue");
  assert.equal((await projectionRow(workItem.id)).state, "abandoned");
  const segment = await pool.query(
    `SELECT outcome FROM acd_segments WHERE work_item_id = $1 ORDER BY seq DESC LIMIT 1`,
    [workItem.id],
  );
  assert.equal(segment.rows[0].outcome, "abandoned");
  assert.deepEqual(await checkInvariants(pool), {});
});

test("agent hangs up first: customer hangup acceptance waits for end evidence", { skip }, async () => {
  const setup = coreSetup();
  await setup.seed();
  const agentLegCcid = `v3:al6${randomUUID().replaceAll("-", "")}`;
  const provider = makeFakeProvider([
    { outcome: "accepted", httpStatus: 200, response: { data: { call_control_id: agentLegCcid } } },
    { outcome: "accepted", httpStatus: 200, response: { data: { result: "ok" } } }, // hangup_customer
  ]);
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const customerCcid = `v3:cu6${randomUUID().replaceAll("-", "")}`;

  await routeAcdVoiceEvent(pool, provider, evt("call.enqueued", enqueuedPayload({ queueName: setup.queueName, sessionId, customerCcid })), { node: "test" });
  const workItemBeforeConnect = await workItemBySession(sessionId);
  const deviceCcid = await bindDeviceLeg(provider, workItemBeforeConnect);
  await answerAndBridge(provider, workItemBeforeConnect, customerCcid, deviceCcid);

  // AGENT leg ends first (PROD call 1: customer sat parked in silence).
  const agentBye = await routeAcdVoiceEvent(
    pool,
    provider,
    evt("call.hangup", { call_control_id: deviceCcid }),
    { node: "test" },
  );
  assert.equal(agentBye.handled, true);

  // The core hung up the surviving customer leg itself.
  const hangupCall = provider.calls.find((entry) => entry.operation === "hangup_customer_leg");
  assert.ok(hangupCall);
  assert.equal(
    hangupCall.endpoint,
    `/calls/${encodeURIComponent(customerCcid)}/actions/hangup`,
  );

  assert.equal((await workItemBySession(sessionId)).state, "active");
  await routeAcdVoiceEvent(pool, provider, evt("call.hangup", { call_control_id: customerCcid }), { node: "test" });
  const workItem = await workItemBySession(sessionId);
  assert.equal(workItem.state, "completed");
  const saga = await pool.query(`SELECT state, last_error FROM acd_sagas WHERE work_item_id = $1 AND type = 'connect'`, [workItem.id]);
  assert.equal(saga.rows[0].state, "succeeded");
  assert.equal(saga.rows[0].last_error, null); // routine advances no longer pollute last_error
  assert.deepEqual(await checkInvariants(pool), {});
});

test("stalled run-step saga is executed (not failed) by the reconciler sweeps", { skip }, async () => {
  const setup = coreSetup();
  await setup.seed();
  const agentLegCcid = `v3:al7${randomUUID().replaceAll("-", "")}`;
  const provider = makeFakeProvider([
    { outcome: "accepted", httpStatus: 200, response: { data: { call_control_id: agentLegCcid } } },
  ]);
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const customerCcid = `v3:cu7${randomUUID().replaceAll("-", "")}`;

  await routeAcdVoiceEvent(pool, provider, evt("call.enqueued", enqueuedPayload({ queueName: setup.queueName, sessionId, customerCcid })), { node: "test" });
  const workItem = await workItemBySession(sessionId);
  const deviceCcid = await bindDeviceLeg(provider, workItem);
  await answerAndBridge(provider, workItem, customerCcid, deviceCcid);

  // PROD 2026-08-02 finalize-stall: the event advances in_call → finalize but
  // the immediate drive is LOST (here: no provider passed → no drive at all).
  const advanced = await applySagaEvent(pool, {
    workItemId: workItem.id,
    name: "leg.ended",
    role: "customer",
    payload: {},
    provider: null,
  });
  assert.equal(advanced.step, "finalize");
  let saga = await pool.query(`SELECT state, step FROM acd_sagas WHERE work_item_id = $1 AND type = 'connect'`, [workItem.id]);
  assert.equal(saga.rows[0].state, "running"); // parked on a run step, undriven
  const stillActive = await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(stillActive.rows[0].state, "active");

  // The stalled-saga sweep executes the run step.
  const driven = await sweepStalledSagas(pool, { provider });
  assert.ok(driven >= 1);
  saga = await pool.query(`SELECT state FROM acd_sagas WHERE work_item_id = $1 AND type = 'connect'`, [workItem.id]);
  assert.equal(saga.rows[0].state, "succeeded");
  const done = await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(done.rows[0].state, "completed");
  assert.deepEqual(await checkInvariants(pool), {});
});

test("run-step deadline executes the step instead of failing the saga", { skip }, async () => {
  const setup = coreSetup();
  await setup.seed();
  const agentLegCcid = `v3:al8${randomUUID().replaceAll("-", "")}`;
  const provider = makeFakeProvider([
    { outcome: "accepted", httpStatus: 200, response: { data: { call_control_id: agentLegCcid } } },
  ]);
  const sessionId = `sess-${randomUUID().slice(0, 10)}`;
  const customerCcid = `v3:cu8${randomUUID().replaceAll("-", "")}`;

  await routeAcdVoiceEvent(pool, provider, evt("call.enqueued", enqueuedPayload({ queueName: setup.queueName, sessionId, customerCcid })), { node: "test" });
  const workItem = await workItemBySession(sessionId);
  const deviceCcid = await bindDeviceLeg(provider, workItem);
  await answerAndBridge(provider, workItem, customerCcid, deviceCcid);
  await applySagaEvent(pool, {
    workItemId: workItem.id, name: "leg.ended", role: "customer", payload: {}, provider: null,
  });
  // Stalled on finalize AND past its deadline (the exact PROD state that
  // previously produced saga=failed + work item stuck 'active').
  await pool.query(
    `UPDATE acd_sagas SET deadline_at = now() - interval '1 second' WHERE work_item_id = $1`,
    [workItem.id],
  );
  const acted = await sweepDueSagas(pool, { provider });
  assert.ok(acted >= 1);
  const saga = await pool.query(`SELECT state FROM acd_sagas WHERE work_item_id = $1 AND type = 'connect'`, [workItem.id]);
  assert.equal(saga.rows[0].state, "succeeded");
  const done = await pool.query(`SELECT state FROM acd_work_items WHERE id = $1`, [workItem.id]);
  assert.equal(done.rows[0].state, "completed");
});

test('queued customer hangup still abandons when reservation cleanup consumes the same event', {skip}, async()=>{
  const setup=coreSetup({agents:1});await setup.seed();const provider=makeFakeProvider();
  const sessionId=randomUUID(),customerCcid='v3:'+randomUUID();
  await routeAcdVoiceEvent(pool,provider,evt('call.enqueued',enqueuedPayload({queueName:setup.queueName,sessionId,customerCcid})));
  const work=await workItemBySession(sessionId);
  await pool.query("UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE work_item_id=$1 AND type='connect'",[work.id]);
  await sweepDueSagas(pool,{provider});
  assert.equal((await workItemBySession(sessionId)).state,'queued');
  const bye=evt('call.hangup',{call_control_id:customerCcid,hangup_source:'caller'});
  await routeAcdVoiceEvent(pool,provider,bye);
  assert.equal((await workItemBySession(sessionId)).state,'abandoned');
  assert.equal((await projectionRow(work.id)).state,'abandoned');
  const res=(await pool.query('SELECT * FROM acd_reservations WHERE work_item_id=$1',[work.id])).rows[0];
  assert.notEqual(res.state,'released'); // A customer hangup is not agent-device evidence.
  const device=await bindDeviceLeg(provider,work);
  await routeAcdVoiceEvent(pool,provider,evt('call.hangup',{call_control_id:device}));
  assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[res.id])).rows[0].state,'released');
  const events=await pool.query("SELECT id FROM acd_events WHERE work_item_id=$1 AND type='work_item_abandoned'",[work.id]);
  await routeAcdVoiceEvent(pool,provider,bye);
  assert.equal(events.rowCount,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM acd_events WHERE work_item_id=$1 AND type='work_item_abandoned'",[work.id])).rows[0].n,1);
});

test('operator reconciliation closes only a queued work item with processed provider end evidence, once', {skip}, async()=>{
  const setup=coreSetup({agents:0});await setup.seed();const provider=makeFakeProvider();
  const sessionId=randomUUID(),customerCcid='v3:'+randomUUID();
  await routeAcdVoiceEvent(pool,provider,evt('call.enqueued',enqueuedPayload({queueName:setup.queueName,sessionId,customerCcid})));
  const work=await workItemBySession(sessionId);
  const args={actorId:'fixture-supervisor',requestId:randomUUID(),action:'reconcile_ended_work',targetId:work.id,reason:'Recover an already ended customer call'};
  await assert.rejects(executeAcdOperation(pool,args),{status:409});
  await pool.query("UPDATE acd_legs SET state='ended',ended_at=now() WHERE work_item_id=$1",[work.id]);
  await assert.rejects(executeAcdOperation(pool,args),{status:409});
  const end=evt('call.hangup',{call_control_id:customerCcid});
  await persistWebhookEvent(pool,end);
  await pool.query("UPDATE acd_webhook_events SET status='applied' WHERE event_id=$1",[end.eventId]);
  const result=await executeAcdOperation(pool,args);
  assert.equal(result.state,'abandoned');assert.equal(result.providerEndVerified,true);
  assert.deepEqual(await executeAcdOperation(pool,args),result);
  assert.equal((await projectionRow(work.id)).state,'abandoned');
  assert.equal((await pool.query('SELECT count(*)::int n FROM acd_operator_actions WHERE request_id=$1',[args.requestId])).rows[0].n,1);
  assert.equal(provider.calls.length,0);
});

test.after(async () => {
  await pool?.end().catch(() => {});
});
