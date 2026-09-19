import test from "node:test";
import assert from "node:assert/strict";

import {
  attachAgentNamesToTimeline,
  buildAcdTimeline,
  createAcdHistoryDto,
  deriveConsultTimelineEvents,
} from "../lib/acd/history-projection.mjs";

for (const channel of ["chat", "email", "sms", "whatsapp"]) {
  test(`${channel}: completed history separates handling from wrap-up using stored segment timestamps`, () => {
    const input = {
      workItem: {
        id: "messaging-work", channel, state: "completed", queue_id: "queue-1",
        created_at: "2026-09-13T12:00:00.000Z",
        enqueued_at: "2026-09-13T12:00:00.000Z",
        // Text work is completed in the same transaction as wrap-up submission.
        terminal_at: "2026-09-13T12:05:30.000Z",
      },
      segments: [
        { id: "queue-segment", seq: 1, kind: "queue_wait", queue_id: "queue-1",
          started_at: "2026-09-13T12:00:00.000Z", ended_at: "2026-09-13T12:00:15.000Z" },
        { id: "agent-segment", seq: 2, kind: "agent", agent_id: "agent-1", outcome: "completed",
          started_at: "2026-09-13T12:00:15.000Z", answered_at: "2026-09-13T12:00:15.000Z",
          ended_at: "2026-09-13T12:05:00.000Z", wrapup_ended_at: "2026-09-13T12:05:30.000Z" },
      ],
      // Existing projections must be rebuilt without a database backfill.
      routingMetadata: { timeline: [
        { type: "wrapup_start", timestamp: "2026-09-13T12:05:30.000Z", source: "acd_core" },
        { type: "wrapup_end", timestamp: "2026-09-13T12:05:30.000Z", wrapupDurationSeconds: 0 },
      ] },
    };
    const { timeline } = buildAcdTimeline(input);
    const history = createAcdHistoryDto(input);
    assert.equal(timeline[0].type, "received", "intake precedes queue entry at the same timestamp");
    assert.equal(timeline.find(event => event.type === "disconnected").timestamp, input.segments[1].ended_at);
    assert.equal(timeline.find(event => event.type === "wrapup_start").timestamp, input.segments[1].ended_at);
    const wrapup = timeline.find(event => event.type === "wrapup_end");
    assert.equal(wrapup.timestamp, input.segments[1].wrapup_ended_at);
    assert.equal(wrapup.wrapupDurationSeconds, 30);
    assert.equal(wrapup.wrapupDurationSeconds, history.metrics.wrapupSeconds);
    const handling = (Date.parse(timeline.find(event => event.type === "disconnected").timestamp)
      - Date.parse(timeline.find(event => event.type === "connected").timestamp)) / 1000;
    assert.equal(handling, 285, "handling must not absorb the 30-second wrap-up");
    assert.equal(handling, history.metrics.talkSeconds);
  });
}

test("transferred messaging segments do not gain a second wrap-up when work later fails in a queue", () => {
  const { timeline } = buildAcdTimeline({
    workItem: { id: "work", channel: "email", state: "failed", terminal_at: "2026-09-13T12:10:00Z" },
    segments: [{ id: "segment", kind: "agent", seq: 1, outcome: "transferred", agent_id: "agent",
      started_at: "2026-09-13T12:00:00Z", ended_at: "2026-09-13T12:05:00Z", wrapup_ended_at: "2026-09-13T12:05:00Z" }],
  });
  assert.equal(timeline.filter(event => event.type === "wrapup_start").length, 1);
  assert.equal(timeline.filter(event => event.type === "wrapup_end").length, 1);
  assert.equal(timeline.find(event => event.type === "wrapup_end").wrapupDurationSeconds, 0,
    "immediate text transfer has no disposition interval");
  assert.equal(timeline.find(event => event.type === "disconnected").timestamp, "2026-09-13T12:10:00.000Z");
});

test("history timeline attaches agent names without replacing usernames", () => {
  const enriched = attachAgentNamesToTimeline(
    {
      timeline: [
        { type: "connected", agentUsername: "demo@example.com" },
        { type: "transfer", transferredBy: "test@example.com" },
      ],
    },
    {
      "demo@example.com": "Demo User",
      "test@example.com": "John Wick",
    },
  );

  assert.deepEqual(enriched.timeline, [
    {
      type: "connected",
      agentUsername: "demo@example.com",
      agentName: "Demo User",
    },
    {
      type: "transfer",
      transferredBy: "test@example.com",
      transferredByName: "John Wick",
    },
  ]);
});

test("Core history preserves IVR and projects queue, alert, interaction and wrap-up phases", () => {
  const timeline = buildAcdTimeline({
    routingMetadata: {
      timeline: [
        {
          type: "initiated",
          timestamp: "2026-08-03T13:07:28.000Z",
          from: "+48600000001",
          to: "+48220000530",
          direction: "incoming",
        },
        // The wrap-up route used to leave this as the only post-IVR event.
        { type: "wrapup_end", timestamp: "2026-08-03T13:08:52.000Z" },
      ],
      workflow_data: { name: "Healthcare Intake" },
    },
    workItem: {
      id: "work-item-1",
      state: "completed",
      queue_id: "queue-acd-test",
      enqueued_at: "2026-08-03T13:07:32.000Z",
      terminal_at: "2026-08-03T13:08:49.000Z",
      terminal_reason: "call_ended",
    },
    queue: {
      id: "queue-acd-test",
      name: "ACD Test",
      routing_strategy: "FIFO",
    },
    offers: [
      {
        generation: 1,
        agent_id: "agent-1",
        state: "accepted",
        created_at: "2026-08-03T13:07:33.000Z",
        terminal_at: "2026-08-03T13:07:36.000Z",
      },
    ],
    segments: [
      {
        seq: 1,
        kind: "queue_wait",
        queue_id: "queue-acd-test",
        started_at: "2026-08-03T13:07:32.000Z",
        answered_at: "2026-08-03T13:07:36.000Z",
        ended_at: "2026-08-03T13:07:36.000Z",
        outcome: "answered",
      },
      {
        seq: 2,
        kind: "agent",
        queue_id: "queue-acd-test",
        agent_id: "agent-1",
        started_at: "2026-08-03T13:07:36.000Z",
        answered_at: "2026-08-03T13:07:36.000Z",
        ended_at: "2026-08-03T13:08:49.000Z",
        outcome: "completed",
        wrapup_ended_at: "2026-08-03T13:08:52.000Z",
      },
    ],
    agentUsernames: { "agent-1": "demo@example.com" },
  });

  assert.deepEqual(
    timeline.timeline.map((event) => event.type),
    [
      "initiated",
      "enqueued",
      "alerting",
      "answered",
      "connected",
      "disconnected",
      "wrapup_start",
      "wrapup_end",
    ],
  );
  assert.equal(timeline.timeline[0].source, undefined);
  assert.ok(timeline.timeline.slice(1).every((event) => event.source === "acd_core"));
  assert.equal(timeline.timeline.at(-1).wrapupDurationSeconds, 3);
  assert.deepEqual(timeline.workflow_data, { name: "Healthcare Intake" });
});

test("Core history preserves every consult attempt and active-leg switch", () => {
  const timeline = buildAcdTimeline({
    routingMetadata: {},
    workItem: {
      id: "work-consult",
      state: "active",
      queue_id: "queue-1",
      enqueued_at: "2026-08-05T12:00:00.000Z",
    },
    queue: { id: "queue-1", name: "Support", routing_strategy: "FIFO" },
    segments: [
      {
        seq: 1,
        kind: "agent",
        agent_id: "agent-1",
        started_at: "2026-08-05T12:00:05.000Z",
        answered_at: "2026-08-05T12:00:05.000Z",
      },
    ],
    agentUsernames: { "agent-1": "demo@example.com" },
    consultEvents: [
      {
        id: 101,
        type: "consult_started",
        occurred_at: "2026-08-05T12:00:20.000Z",
        payload: {
          saga_id: "consult-1",
          agent_id: "agent-1",
          agent_username: "demo@example.com",
          target_label: "John Wick",
          target_kind: "agents",
        },
      },
      {
        id: 102,
        type: "consult_ringing",
        occurred_at: "2026-08-05T12:00:21.000Z",
        payload: { saga_id: "consult-1", target_label: "John Wick" },
      },
      {
        id: 103,
        type: "consult_connected",
        occurred_at: "2026-08-05T12:00:24.000Z",
        payload: { saga_id: "consult-1", target_label: "John Wick" },
      },
      {
        id: 104,
        type: "consult_customer_active",
        occurred_at: "2026-08-05T12:00:30.000Z",
        payload: { saga_id: "consult-1", active_leg: "parked" },
      },
      {
        id: 105,
        type: "consult_consultant_active",
        occurred_at: "2026-08-05T12:00:34.000Z",
        payload: { saga_id: "consult-1", active_leg: "consultant" },
      },
      {
        id: 106,
        type: "consult_customer_active",
        occurred_at: "2026-08-05T12:00:38.000Z",
        payload: { saga_id: "consult-1", active_leg: "parked" },
      },
      {
        id: 107,
        type: "consult_customer_restored",
        occurred_at: "2026-08-05T12:00:42.000Z",
        payload: { saga_id: "consult-1", active_leg: "parked" },
      },
    ],
  });

  assert.deepEqual(
    timeline.timeline.filter((event) => event.type.startsWith("consult_"))
      .map((event) => event.type),
    [
      "consult_started",
      "consult_ringing",
      "consult_connected",
      "consult_customer_active",
      "consult_consultant_active",
      "consult_customer_active",
      "consult_customer_restored",
    ],
  );
  assert.equal(
    timeline.timeline.find((event) => event.type === "consult_started").targetLabel,
    "John Wick",
  );
  assert.equal(
    timeline.timeline.find((event) => event.type === "consult_started").eventId,
    101,
  );
});

test("historical consult saga steps reconstruct history without a database backfill", () => {
  const derived = deriveConsultTimelineEvents([
    {
      id: 201,
      type: "saga_started",
      occurred_at: "2026-08-05T12:00:20.000Z",
      payload: { saga_id: "historical-consult", saga_type: "consult" },
      saga_data: {
        agentId: "agent-1",
        agentUsername: "demo@example.com",
        targetLabel: "John Wick",
      },
    },
    {
      id: 202,
      type: "saga_step",
      occurred_at: "2026-08-05T12:00:21.000Z",
      payload: {
        saga_id: "historical-consult",
        saga_type: "consult",
        to: "route_initial_hold_audio",
      },
      saga_data: { targetLabel: "John Wick" },
    },
    {
      id: 203,
      type: "saga_step",
      occurred_at: "2026-08-05T12:00:24.000Z",
      payload: {
        saga_id: "historical-consult",
        saga_type: "consult",
        to: "consult_active",
      },
    },
    {
      id: 204,
      type: "saga_step",
      occurred_at: "2026-08-05T12:00:30.000Z",
      payload: {
        saga_id: "historical-consult",
        saga_type: "consult",
        to: "customer_active",
      },
    },
    {
      id: 205,
      type: "saga_step",
      occurred_at: "2026-08-05T12:00:34.000Z",
      payload: {
        saga_id: "historical-consult",
        saga_type: "consult",
        to: "consultant_active",
      },
    },
    {
      id: 206,
      type: "saga_step",
      occurred_at: "2026-08-05T12:00:42.000Z",
      payload: {
        saga_id: "historical-consult",
        saga_type: "consult",
        to: "consult_cancelled",
      },
    },
  ]);

  assert.deepEqual(derived.map((event) => event.type), [
    "consult_started",
    "consult_ringing",
    "consult_connected",
    "consult_customer_active",
    "consult_consultant_active",
    "consult_customer_restored",
  ]);
  assert.equal(derived[0].payload.target_label, "John Wick");
  assert.equal(derived[0].payload.derived, true);
});

test("Core history represents a no-answer attempt as alert then queue re-entry", () => {
  const timeline = buildAcdTimeline({
    routingMetadata: {},
    workItem: {
      state: "offered",
      queue_id: "queue-1",
      enqueued_at: "2026-08-03T13:00:00.000Z",
    },
    queue: { id: "queue-1", name: "ACD Test", routing_strategy: "FIFO" },
    segments: [
      {
        seq: 1,
        kind: "queue_wait",
        started_at: "2026-08-03T13:00:00.000Z",
      },
    ],
    offers: [
      {
        generation: 1,
        agent_id: "agent-1",
        state: "no_answer",
        created_at: "2026-08-03T13:00:02.000Z",
        terminal_at: "2026-08-03T13:00:22.000Z",
      },
      {
        generation: 2,
        agent_id: "agent-2",
        state: "ringing",
        created_at: "2026-08-03T13:00:25.000Z",
      },
    ],
    agentUsernames: {
      "agent-1": "first@example.com",
      "agent-2": "second@example.com",
    },
  });

  assert.deepEqual(
    timeline.timeline.map((event) => event.type),
    [
      "enqueued",
      "alerting",
      "agent_not_answering",
      "enqueued",
      "alerting",
    ],
  );
  assert.equal(timeline.timeline[2].agentUsername, "first@example.com");
  assert.equal(timeline.timeline[2].reason, "agent not answering");
  assert.equal(timeline.timeline[2].alertingDurationSeconds, 20);
  assert.equal(timeline.timeline[3].reEvaluated, true);
});

test("Core history re-enqueues reconciled orphan claims but not generic cancellations", () => {
  const timeline = buildAcdTimeline({
    routingMetadata: {},
    workItem: {
      state: "queued",
      queue_id: "queue-1",
      enqueued_at: "2026-08-03T13:00:00.000Z",
    },
    queue: { id: "queue-1", name: "ACD Test", routing_strategy: "FIFO" },
    segments: [
      {
        seq: 1,
        kind: "queue_wait",
        queue_id: "queue-1",
        started_at: "2026-08-03T13:00:00.000Z",
      },
    ],
    offers: [
      {
        generation: 1,
        agent_id: "agent-1",
        state: "cancelled",
        outcome_reason: "orphaned_claim",
        created_at: "2026-08-03T13:00:02.000Z",
        terminal_at: "2026-08-03T13:00:10.000Z",
      },
      {
        generation: 2,
        agent_id: "agent-2",
        state: "cancelled",
        outcome_reason: "caller_abandoned",
        created_at: "2026-08-03T13:00:12.000Z",
        terminal_at: "2026-08-03T13:00:20.000Z",
      },
    ],
  });

  const reentries = timeline.timeline.filter(
    (event) => event.type === "enqueued" && event.reEvaluated,
  );
  assert.equal(reentries.length, 1);
  assert.equal(reentries[0].reason, "orphaned_claim");
});

test("Core history preserves each queue and names every transfer destination", () => {
  const timeline = buildAcdTimeline({
    routingMetadata: {},
    workItem: {
      state: "active",
      queue_id: "queue-support",
      enqueued_at: "2026-08-03T18:00:30.000Z",
    },
    queuesById: {
      "queue-acd-test": {
        id: "queue-acd-test",
        name: "ACD Test",
        routing_strategy: "FIFO",
      },
      "queue-support": {
        id: "queue-support",
        name: "Support",
        routing_strategy: "Priority-based",
      },
    },
    segments: [
      {
        seq: 1,
        kind: "queue_wait",
        queue_id: "queue-acd-test",
        started_at: "2026-08-03T18:00:00.000Z",
        ended_at: "2026-08-03T18:00:05.000Z",
      },
      {
        seq: 2,
        kind: "agent",
        queue_id: "queue-acd-test",
        agent_id: "agent-1",
        started_at: "2026-08-03T18:00:05.000Z",
        answered_at: "2026-08-03T18:00:05.000Z",
        ended_at: "2026-08-03T18:00:30.000Z",
        outcome: "transferred",
        wrapup_ended_at: "2026-08-03T18:00:40.000Z",
      },
      {
        seq: 3,
        kind: "queue_wait",
        queue_id: "queue-support",
        started_at: "2026-08-03T18:00:30.000Z",
        ended_at: "2026-08-03T18:00:35.000Z",
      },
      {
        seq: 4,
        kind: "agent",
        queue_id: "queue-support",
        agent_id: "agent-2",
        started_at: "2026-08-03T18:00:35.000Z",
        answered_at: "2026-08-03T18:00:35.000Z",
      },
    ],
    offers: [
      {
        generation: 1,
        agent_id: "agent-1",
        state: "cancelled",
        created_at: "2026-08-03T18:00:02.000Z",
        terminal_at: "2026-08-03T18:00:30.000Z",
        outcome_reason: "queue_transfer",
      },
      {
        generation: 2,
        agent_id: "agent-2",
        state: "accepted",
        created_at: "2026-08-03T18:00:32.000Z",
      },
    ],
    transferEvents: [
      {
        type: "work_item_queue_transferred",
        occurred_at: "2026-08-03T18:00:30.000Z",
        payload: {
          agent_id: "agent-1",
          queue_id: "queue-support",
          queue_name: "Support",
        },
      },
    ],
    agentUsernames: {
      "agent-1": "first@example.com",
      "agent-2": "second@example.com",
    },
  });

  const enqueued = timeline.timeline.filter((event) => event.type === "enqueued");
  assert.deepEqual(
    enqueued.map((event) => [event.queueId, event.queueName]),
    [
      ["queue-acd-test", "ACD Test"],
      ["queue-support", "Support"],
    ],
  );
  const alerting = timeline.timeline.filter((event) => event.type === "alerting");
  assert.deepEqual(
    alerting.map((event) => event.queueName),
    ["ACD Test", "Support"],
  );
  const transfer = timeline.timeline.find((event) => event.type === "transfer");
  assert.equal(transfer.targetKind, "queues");
  assert.equal(transfer.targetLabel, "Support");
  assert.ok(
    timeline.timeline.indexOf(transfer) <
      timeline.timeline.findIndex(
        (event) => event.type === "enqueued" && event.queueName === "Support",
      ),
    "the transfer must precede the destination queue entry at the same timestamp",
  );
  assert.deepEqual(
    timeline.timeline
      .filter((event) => event.type.startsWith("wrapup_"))
      .map((event) => event.type),
    ["wrapup_start", "wrapup_end"],
  );
});
