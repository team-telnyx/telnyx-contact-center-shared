import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACD_HISTORY_DTO_VERSION,
  assertAcdHistoryDto,
  createAcdHistoryDto,
} from "../lib/acd/history-projection.mjs";
import {
  ACD_ADMISSION_DECISIONS,
  classifyAcdVoiceAdmission,
} from "../lib/acd/admission-contract.mjs";
import {
  ACD_INTAKE_STATE_KEY,
  decodeAcdClientState,
  encodeAcdClientState,
  extractAcdIntakeContext,
  materializeAcdIntakeState,
  mergeAcdClientState,
} from "../lib/acd/intake-source.mjs";
import {
  VOICE_OCCUPANCY_KINDS,
  assertExclusiveVoiceOccupancy,
  buildQueueLessVoiceWorkItem,
  normalizedPhone,
  resolveDirectAgentAddress,
  sipUser,
  voiceAddressMatches,
} from "../lib/acd/voice-occupancy-contract.mjs";
import {
  canPruneAcdOutbox,
  canPruneAcdStreamEvent,
  planAcdStreamRead,
} from "../lib/acd/retention-contract.mjs";
import {
  ACD_ADMISSION_FIXTURES,
  DIRECT_AGENT_USERS,
  SHARED_AGENT_CONNECTION_ID,
} from "./fixtures/acd-cutover-admission.mjs";

test("C1 history DTO has a Core work-item identity and native child records", () => {
  const workItem = {
    id: "00000000-0000-4000-8000-000000000001",
    version: "7",
    channel: "voice",
    direction: "inbound",
    state: "completed",
    queue_id: "queue-a",
    priority: 3,
    required_skills: { polish: 4 },
    customer_address: "+48600000003",
    cc_address: "+48700000001",
    created_at: "2026-09-08T10:00:00.000Z",
    enqueued_at: "2026-09-08T10:00:00.000Z",
    terminal_at: "2026-09-08T10:00:52.000Z",
    terminal_reason: "normal_clearing",
    internal_only_marker: "must-not-leak",
    attributes: {
      customer_name: "Test Customer",
      customer_identity_id: "contact-1",
      internal_projection_marker: "must-not-leak",
    },
  };
  const segments = [
    {
      id: "segment-agent",
      seq: 2,
      kind: "agent",
      queue_id: "queue-a",
      agent_id: "agent-a",
      started_at: "2026-09-08T10:00:12.000Z",
      answered_at: "2026-09-08T10:00:12.000Z",
      ended_at: "2026-09-08T10:00:42.000Z",
      outcome: "completed",
      wrapup_code_id: "wrapup-rpc",
      wrapup_ended_at: "2026-09-08T10:00:52.000Z",
    },
    {
      id: "segment-queue",
      seq: 1,
      kind: "queue_wait",
      queue_id: "queue-a",
      started_at: "2026-09-08T10:00:00.000Z",
      ended_at: "2026-09-08T10:00:10.000Z",
      outcome: "answered",
    },
  ];
  const dto = createAcdHistoryDto({
    workItem,
    segments,
    offers: [
      {
        id: "offer-1",
        generation: 1,
        agent_id: "agent-a",
        state: "accepted",
        created_at: "2026-09-08T10:00:10.000Z",
        terminal_at: "2026-09-08T10:00:12.000Z",
      },
    ],
    legs: [
      {
        id: "leg-1",
        role: "customer",
        state: "ended",
        provider_call_id: "v3:customer",
        created_at: "2026-09-08T10:00:00.000Z",
        bridged_at: "2026-09-08T10:00:12.000Z",
        ended_at: "2026-09-08T10:00:42.000Z",
      },
    ],
    events: [
      {
        id: "1",
        type: "work_item_created",
        occurred_at: "2026-09-08T10:00:00.000Z",
        payload: {},
      },
    ],
    recordings: [{ id: "recording-1", created_at: "2026-09-08T10:01:00Z" }],
    lookups: {
      queues: { "queue-a": { id: "queue-a", name: "ACD Voice E2E" } },
      agents: {
        "agent-a": {
          id: "agent-a",
          username: "agent.a",
          first_name: "Agent",
          last_name: "A",
        },
      },
      wrapupCodes: {
        "wrapup-rpc": { id: "wrapup-rpc", name: "Right party contact" },
      },
    },
  });

  assert.equal(dto.contract, ACD_HISTORY_DTO_VERSION);
  assert.equal(dto.interactionId, workItem.id);
  assert.equal(dto.workItemId, workItem.id);
  assert.deepEqual(dto.queue, { id: "queue-a", name: "ACD Voice E2E" });
  assert.deepEqual(dto.customer, {
    address: "+48600000003",
    name: "Test Customer",
    contactId: "contact-1",
  });
  assert.deepEqual(dto.metrics, {
    waitSeconds: 10,
    alertSeconds: 2,
    talkSeconds: 30,
    wrapupSeconds: 10,
    handleSeconds: 40,
    totalSeconds: 52,
  });
  assert.deepEqual(dto.segments.map((segment) => segment.id), [
    "segment-queue",
    "segment-agent",
  ]);
  assert.equal(dto.segments[1].wrapup.codeName, "Right party contact");
  assert.equal(dto.artifacts.recordings[0].createdAt, "2026-09-08T10:01:00.000Z");
  assert.equal("legacyInteractionId" in dto, false);
  assert.equal(JSON.stringify(dto).includes("must-not-leak"), false);
  assert.equal(assertAcdHistoryDto(dto), dto);
});

test("C1 direct-agent identity comes from SIP/E.164 destination, never credential id", () => {
  const options = {
    connectionId: SHARED_AGENT_CONNECTION_ID,
    allowedCredentialConnectionIds: [SHARED_AGENT_CONNECTION_ID],
  };
  const sip = resolveDirectAgentAddress(
    DIRECT_AGENT_USERS,
    "sip:acd-agent-a@sip.telnyx.com",
    options,
  );
  assert.equal(sip.status, "matched");
  assert.equal(sip.agent.id, "agent-a");
  assert.equal(sip.matchedBy, "sip_user");

  const bareSipUser = resolveDirectAgentAddress(
    DIRECT_AGENT_USERS,
    "acd-agent-a",
    options,
  );
  assert.equal(bareSipUser.status, "matched");
  assert.equal(bareSipUser.agent.id, "agent-a");
  assert.equal(bareSipUser.matchedBy, "sip_user");

  const telnyxCredentialUser = "gencredNb4q5bw98tKFI5t40W04UipQA9MSXMwQqaAUSGesgR";
  assert.equal(sipUser(telnyxCredentialUser), telnyxCredentialUser.toLowerCase());
  assert.equal(normalizedPhone(telnyxCredentialUser), null);
  assert.equal(
    voiceAddressMatches(
      `sip:${telnyxCredentialUser}@sip.telnyx.com`,
      telnyxCredentialUser,
    ),
    true,
  );

  const phone = resolveDirectAgentAddress(
    DIRECT_AGENT_USERS,
    "+48 600 111 002",
    options,
  );
  assert.equal(phone.status, "matched");
  assert.equal(phone.agent.id, "agent-b");
  assert.equal(phone.matchedBy, "e164");

  assert.equal(
    resolveDirectAgentAddress(
      DIRECT_AGENT_USERS,
      "sip:credential-a-not-a-connection@sip.telnyx.com",
      options,
    ).status,
    "unmatched",
  );
  assert.equal(
    resolveDirectAgentAddress(DIRECT_AGENT_USERS, "+48600000003", {
      ...options,
      connectionId: "unrelated-connection",
    }).status,
    "outside_connection",
  );
});

test("C1 ambiguous direct address is rejected as Core-scoped evidence", () => {
  const users = [
    ...DIRECT_AGENT_USERS,
    { ...DIRECT_AGENT_USERS[0], id: "agent-c" },
  ];
  const resolution = resolveDirectAgentAddress(
    users,
    "sip:acd-agent-a@sip.telnyx.com",
    {
      connectionId: SHARED_AGENT_CONNECTION_ID,
      allowedCredentialConnectionIds: [SHARED_AGENT_CONNECTION_ID],
    },
  );
  assert.deepEqual(resolution.agentIds, ["agent-a", "agent-c"]);
  const classified = classifyAcdVoiceAdmission(
    {
      eventType: "call.initiated",
      payload: {
        direction: "incoming",
        to: "sip:acd-agent-a@sip.telnyx.com",
      },
    },
    { directAgentResolution: resolution },
  );
  assert.equal(classified.decision, ACD_ADMISSION_DECISIONS.UNMATCHED_CORE);
  assert.equal(classified.observableFailure, true);
});

test("C1 direct/manual work items require one live exclusive reservation", () => {
  const create = buildQueueLessVoiceWorkItem({
    kind: VOICE_OCCUPANCY_KINDS.MANUAL_OUTBOUND,
    customerAddress: "+48600000001",
    contactCenterAddress: "+48220000510",
  });
  assert.deepEqual(create, {
    channel: "voice",
    direction: "outbound",
    queueId: null,
    customerAddress: "+48600000001",
    ccAddress: "+48220000510",
    attributes: { voice_occupancy_kind: "manual_outbound" },
  });

  const workItem = {
    id: "00000000-0000-4000-8000-000000000010",
    channel: "voice",
    queue_id: null,
  };
  const reservation = {
    id: "reservation-1",
    agent_id: "agent-a",
    work_item_id: workItem.id,
    channel: "voice",
    weight: "1.00",
    state: "active",
  };
  assert.equal(
    assertExclusiveVoiceOccupancy({
      kind: VOICE_OCCUPANCY_KINDS.MANUAL_OUTBOUND,
      agentId: "agent-a",
      workItem,
      reservation,
    }),
    true,
  );
  assert.throws(
    () =>
      assertExclusiveVoiceOccupancy({
        kind: VOICE_OCCUPANCY_KINDS.MANUAL_OUTBOUND,
        agentId: "agent-a",
        workItem,
        reservation: { ...reservation, state: "released" },
      }),
    /live weight-1 reservation/,
  );
});

test("C1 admission fixtures enforce Core-before-domain precedence", () => {
  for (const fixture of ACD_ADMISSION_FIXTURES) {
    const actual = classifyAcdVoiceAdmission(fixture.event, fixture.evidence);
    assert.equal(actual.decision, fixture.expected.decision, fixture.name);
    assert.equal(actual.eventClass, fixture.expected.eventClass, fixture.name);
  }

  const directResolution = resolveDirectAgentAddress(
    DIRECT_AGENT_USERS,
    "sip:acd-agent-b@sip.telnyx.com",
    {
      connectionId: SHARED_AGENT_CONNECTION_ID,
      allowedCredentialConnectionIds: [SHARED_AGENT_CONNECTION_ID],
    },
  );
  const direct = classifyAcdVoiceAdmission(
    {
      eventType: "call.initiated",
      payload: {
        direction: "incoming",
        to: "sip:acd-agent-b@sip.telnyx.com",
      },
    },
    { directAgentResolution: directResolution, nonCcDomain: "voice_flow" },
  );
  assert.equal(direct.decision, "admit_core");
  assert.equal(direct.eventClass, "direct_agent_leg");
  assert.equal(direct.agentId, "agent-b");
});

test("C1 intake state carries routing and verified source without legacy data", () => {
  const runId = "10000000-0000-4000-8000-000000000001";
  const ledgerId = "10000000-0000-4000-8000-000000000002";
  const flowId = "10000000-0000-4000-8000-000000000003";
  const initial = encodeAcdClientState({
    queue_name: "ACD Voice E2E",
    call_priority: 4,
    required_skills: { polish: 3 },
    agent_assist_config: { workflowId: "workflow-a" },
    telnyx_stt_config: { language: "en" },
    callGenerator: true,
  });
  const materialized = materializeAcdIntakeState({
    clientState: initial,
    flowId,
    generatorIdentity: { runId, ledgerId, flowId },
    payload: {
      from: "+48600000003",
      to: "+48700000001",
      call_session_id: "session-a",
    },
  });
  assert.deepEqual(materialized[ACD_INTAKE_STATE_KEY], {
    version: 1,
    source: "telnyx_voice_flow",
    flowId,
    workItemId: null,
    providerSessionId: "session-a",
    originalCustomerAddress: "+48600000003",
    originalContactCenterAddress: "+48700000001",
    generator: { verified: true, runId, ledgerId, flowId },
  });

  const merged = mergeAcdClientState(materialized, {
    call_priority: 5,
    [ACD_INTAKE_STATE_KEY]: {
      originalCustomerAddress: "+48999999999",
      generator: { verified: true, runId: "forged" },
    },
  });
  assert.equal(merged.call_priority, 5);
  assert.deepEqual(
    merged[ACD_INTAKE_STATE_KEY],
    materialized[ACD_INTAKE_STATE_KEY],
  );
  const context = extractAcdIntakeContext(encodeAcdClientState(merged));
  assert.equal(context.routing.queueName, "ACD Voice E2E");
  assert.equal(context.routing.priority, 5);
  assert.deepEqual(context.routing.requiredSkills, { polish: 3 });
  assert.deepEqual(context.agentAssistConfig, { workflowId: "workflow-a" });
  assert.equal(
    decodeAcdClientState(encodeAcdClientState(merged)).acd_intake.generator.ledgerId,
    ledgerId,
  );

  const unverified = materializeAcdIntakeState({
    clientState: initial,
    flowId,
    payload: { from: "+1", to: "+2" },
  });
  assert.equal(unverified.acd_intake.generator, undefined);
});

test("C1 retention contract requires materialization and recovers stale cursors", () => {
  assert.deepEqual(
    planAcdStreamRead({ after: 50, minimumRetained: 100, current: 140 }),
    {
      mode: "snapshot",
      reason: "cursor_expired",
      readAfter: "140",
      cursor: "140",
    },
  );
  assert.equal(
    planAcdStreamRead({ after: 99, minimumRetained: 100, current: 140 }).mode,
    "incremental",
  );
  assert.deepEqual(
    planAcdStreamRead({ after: 900, minimumRetained: 0, current: 140 }),
    {
      mode: "snapshot",
      reason: "cursor_reset",
      readAfter: "140",
      cursor: "140",
    },
  );
  const now = new Date("2026-09-08T12:00:00.000Z");
  assert.equal(
    canPruneAcdOutbox({
      createdAt: "2026-09-08T10:00:00.000Z",
      now,
      safetyAgeMs: 60_000,
    }).reason,
    "not_materialized",
  );
  assert.deepEqual(
    canPruneAcdOutbox({
      createdAt: "2026-09-08T10:00:00.000Z",
      now,
      safetyAgeMs: 60_000,
      materializedStreamSequence: 12,
    }),
    { allowed: true, reason: "materialized_and_safe" },
  );
  assert.equal(
    canPruneAcdOutbox({
      createdAt: "2026-09-08T10:00:00.000Z",
      now,
      safetyAgeMs: 60_000,
      materializedStreamSequence: 12,
      activeWorkEvidence: true,
    }).allowed,
    false,
  );
  assert.deepEqual(
    canPruneAcdStreamEvent({ sequence: 9, retainedMinimum: 10 }),
    { allowed: true, reason: "outside_replay_window" },
  );
});
