import { readMonitorStatistics } from "../lib/acd/monitor-statistics.mjs";
import {
  readHandoffReport,
  readSkillsReport,
} from "../lib/acd/interaction-analytics.mjs";
import { transfersHoldsReport } from "../lib/acd/transfer-hold-report.mjs";
import { agentAdherenceReport } from "../lib/acd/workforce-reports.mjs";
import { readMessageTranscript } from "../lib/acd/message-transcript.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  prepareAcdTestPool,
  seedAgent,
  seedQueue,
} from "./helpers/acd-test-db.mjs";
import {
  CHANNEL_REGISTRY,
  channelDefinition,
  RELEASED_CHANNELS,
} from "../lib/acd/channel-registry.mjs";
import {
  interactionCapabilities,
  parseChannel,
} from "../lib/acd/interaction-channels.mjs";
import {
  validateSlaPolicy,
  effectiveSlaPolicy,
  evaluateSla,
  saveSlaPolicies,
  recordSlaService,
} from "../lib/acd/sla.mjs";
import {
  createWorkItem,
  openSegment,
  closeOpenSegment,
} from "../lib/acd/lifecycle.mjs";
import { appendEvent } from "../lib/acd/events.mjs";
import {
  readInteractionReport,
  readLiveWorkload,
  slaSummary,
} from "../lib/acd/interaction-reporting.mjs";
import { resolveReportingScope } from "../lib/acd/reporting-scope.mjs";
import {
  authorizeInteractionRead,
  readConversationPreview,
  readConversationSnapshot,
} from "../lib/acd/conversation-preview.mjs";
import { publishCommittedOutbox } from "../lib/acd/stream.mjs";
const pool = await prepareAcdTestPool("acd_core_test_multichannel_reporting");
after(() => pool.end());
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
  CREATE TABLE IF NOT EXISTS cc_wrapup_codes(id TEXT PRIMARY KEY,name TEXT);
  CREATE TABLE IF NOT EXISTS app_settings(id TEXT PRIMARY KEY,cc_settings JSONB,updated_by TEXT,updated_at TIMESTAMPTZ);
  DELETE FROM app_settings;`);
const agent = await seedAgent(pool, "multichannel-agent");
const agentId =
  typeof agent === "string" ? agent : agent?.id || "multichannel-agent";
const queueId = "multichannel-queue";
await seedQueue(pool, queueId, [agentId]);
const policy = {
  enabled: true,
  thresholdSeconds: 60,
  targetPercentage: 90,
  warningPercentage: 80,
  clock: "24x7",
};
await saveSlaPolicies(pool, {
  revision: 0,
  policies: { chat: policy, email: { ...policy, thresholdSeconds: 3600 } },
  actor: "test",
});
async function work(channel, queue = queueId) {
  const conversationId = channelDefinition(channel).capabilities.conversation
    ? randomUUID()
    : null;
  if (conversationId)
    await pool.query(
      "INSERT INTO acd_conversations(id,channel) VALUES($1,$2)",
      [conversationId, channel],
    );
  return createWorkItem(pool, {
    channel,
    direction: "inbound",
    queueId: queue,
    conversationId,
    customerAddress: "customer@example.test",
  });
}
const scope = {
  from: new Date(Date.now() - 86400000).toISOString(),
  to: new Date(Date.now() + 86400000).toISOString(),
  timezone: "UTC",
  bucket: "day",
  channel: null,
  queueId,
  agentId: null,
};
test("catalogue separates release gates, viewer families and capabilities", () => {
  assert.deepEqual(RELEASED_CHANNELS, ["voice", "chat", "email", "whatsapp", "sms", "video"]);
  assert.equal(channelDefinition("video").viewer, "video");
  assert.equal(channelDefinition("video").family, "video");
  assert.equal(channelDefinition("video").lifecycle, "native");
  assert.equal(channelDefinition("video").capabilities.conversation, false);
  assert.equal(channelDefinition("video").capabilities.recordings, true);
  assert.equal(channelDefinition("sms").viewer, "messages");
  assert.equal(channelDefinition("sms").serviceEvent, "human_send_accepted");
  assert.equal(parseChannel("sms"), "sms");
  assert.equal(channelDefinition("whatsapp").viewer, "messages");
  assert.equal(channelDefinition("whatsapp").serviceEvent, "human_send_accepted");
  assert.equal(parseChannel("whatsapp"), "whatsapp");
  assert.notEqual(channelDefinition("whatsapp").tone, channelDefinition("chat").tone, "WhatsApp and chat stay visually distinct");
  for (const channel of ["rcs"]) {
    assert.equal(channelDefinition(channel).viewer, "messages");
    assert.equal(channelDefinition(channel).released, false);
    assert.throws(() => parseChannel(channel));
    assert.throws(() => validateSlaPolicy(policy, channel));
  }
  assert.equal(channelDefinition("future-social").viewer, "metadata");
  assert.equal(
    interactionCapabilities({
      channel: "future-social",
      state: "active",
      agentCallControlId: "fake",
    }).supervision,
    false,
  );
  assert.equal(
    interactionCapabilities({ channel: "whatsapp", conversationId: "test" })
      .conversation,
    true,
  );
  for (const definition of Object.values(CHANNEL_REGISTRY))
    assert.ok(definition.viewer && definition.family && definition.capacity);
});
test("SLA inherits whole policies, preserves legacy queue voice overrides and leaves new channels unconfigured", () => {
  assert.equal(
    effectiveSlaPolicy(
      "voice",
      {},
      { sla_answer_threshold_seconds: 42, sla_target_percentage: 95 },
    ).thresholdSeconds,
    42,
  );
  assert.equal(effectiveSlaPolicy("chat", {}).status, "not_configured");
  assert.equal(
    effectiveSlaPolicy(
      "chat",
      { policies: { chat: policy } },
      { sla_policies: { chat: { mode: "disabled" } } },
    ).status,
    "disabled",
  );
  assert.equal(
    effectiveSlaPolicy(
      "chat",
      { policies: { chat: policy } },
      { sla_policies: { chat: { mode: "inherit" } } },
    ).thresholdSeconds,
    60,
  );
  const base = {
    started_at: "2026-01-01T00:00:00Z",
    deadline_at: "2026-01-01T00:01:00Z",
    policy: { ...policy, status: "configured" },
  };
  assert.equal(
    evaluateSla({ ...base, served_at: base.deadline_at }).state,
    "met",
  );
  assert.equal(
    evaluateSla({ ...base, served_at: "2026-01-01T00:01:01Z" }).state,
    "breached",
  );
  assert.equal(
    evaluateSla(base, Date.parse("2026-01-01T00:00:50Z")).atRisk,
    true,
  );
  assert.equal(
    evaluateSla({ ...base, ended_at: "2026-01-01T00:00:30Z" }).state,
    "unserved",
  );
  assert.equal(
    evaluateSla(base, Date.parse("2026-01-01T00:02:00Z")).state,
    "breached",
  );
  assert.equal(evaluateSla(null).state, "unavailable");
  assert.equal(
    slaSummary([
      { state: "met", total: 2, target_sum: 160 },
      { state: "breached", total: 1, target_sum: 90 },
      { state: "pending", total: 10 },
    ]).rate,
    200 / 3,
  );
});
test("saved policy revisions are atomic and do not overwrite unrelated settings or existing deadlines", async () => {
  await pool.query(
    "UPDATE app_settings SET cc_settings=cc_settings||'{\"chat_copilot\":{\"keep\":true}}'::jsonb WHERE id='default'",
  );
  const item = await work("chat");
  const before = (
    await pool.query(
      "SELECT * FROM acd_sla_measurements WHERE work_item_id=$1",
      [item.id],
    )
  ).rows[0];
  await saveSlaPolicies(pool, {
    revision: 1,
    policies: { chat: { ...policy, thresholdSeconds: 120 } },
    actor: "test",
  });
  await assert.rejects(
    saveSlaPolicies(pool, {
      revision: 1,
      policies: { chat: policy },
      actor: "test",
    }),
    { status: 409 },
  );
  const after = (
    await pool.query(
      "SELECT * FROM acd_sla_measurements WHERE work_item_id=$1",
      [item.id],
    )
  ).rows[0];
  assert.deepEqual(before.deadline_at, after.deadline_at);
  assert.equal(after.policy.thresholdSeconds, 60);
  assert.equal(
    (
      await pool.query(
        "SELECT cc_settings#>>'{chat_copilot,keep}' AS keep FROM app_settings WHERE id='default'",
      )
    ).rows[0].keep,
    "true",
  );
});
test("voice measures each queue visit; messaging transfers retain the first deadline", async () => {
  const voice = await work("voice");
  const first = await openSegment(pool, {
    workItemId: voice.id,
    kind: "queue_wait",
    queueId,
  });
  await closeOpenSegment(pool, voice.id, {
    outcome: "answered",
    answeredAt: new Date().toISOString(),
  });
  await openSegment(pool, {
    workItemId: voice.id,
    kind: "queue_wait",
    queueId,
  });
  const measurements = (
    await pool.query(
      "SELECT * FROM acd_sla_status WHERE work_item_id=$1 ORDER BY started_at",
      [voice.id],
    )
  ).rows;
  assert.equal(measurements.length, 2);
  assert.equal(measurements[0].segment_id, first.id);
  assert.equal(measurements[0].state, "met");
  const chat = await work("chat");
  await openSegment(pool, { workItemId: chat.id, kind: "queue_wait", queueId });
  await closeOpenSegment(pool, chat.id, { outcome: "transferred" });
  await openSegment(pool, { workItemId: chat.id, kind: "queue_wait", queueId });
  assert.equal(
    (
      await pool.query(
        "SELECT * FROM acd_sla_measurements WHERE work_item_id=$1",
        [chat.id],
      )
    ).rowCount,
    1,
  );
});
test("email queued sends are not replies; only durable accepted evidence satisfies SLA", async () => {
  const email = await work("email"),
    id = randomUUID();
  await pool.query(
    `INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body) VALUES($1::uuid,$2,$3,'agent',$4,$1::text,'Reply')`,
    [id, email.conversation_id, email.id, agentId],
  );
  await appendEvent(pool, {
    workItemId: email.id,
    type: "email_send_updated",
    actor: "email",
    payload: { message_id: id, status: "queued" },
  });
  assert.equal(
    (
      await pool.query(
        "SELECT served_at FROM acd_sla_measurements WHERE work_item_id=$1",
        [email.id],
      )
    ).rows[0].served_at,
    null,
  );
  await appendEvent(pool, {
    workItemId: email.id,
    type: "email_send_updated",
    actor: "email",
    payload: { message_id: id, status: "accepted" },
  });
  assert.ok(
    (
      await pool.query(
        "SELECT served_at FROM acd_sla_measurements WHERE work_item_id=$1",
        [email.id],
      )
    ).rows[0].served_at,
  );
});
test("readonly preview authorizes unassigned supervisors, scopes episodes and follows committed events", async () => {
  const item = await work("chat"),
    supervisor = { id: agentId, roles: ["supervisor"] };
  const messageId = randomUUID();
  await pool.query(
    `INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body) VALUES($1::uuid,$2,$3,'customer','visitor',$1::text,'Hello')`,
    [messageId, item.conversation_id, item.id],
  );
  const before = await readConversationSnapshot(pool, {
    workItemId: item.id,
    user: supervisor,
  });
  assert.equal(before.snapshot.messages.length, 1);
  await assert.rejects(
    authorizeInteractionRead(pool, item.id, {
      id: "stranger",
      roles: ["agent"],
    }),
    { status: 404 },
  );
  await pool.query(
    "UPDATE acd_work_items SET terminal_at=now(),state='completed' WHERE id=$1",
    [item.id],
  );
  const next = await createWorkItem(pool, {
    channel: "chat",
    direction: "inbound",
    conversationId: item.conversation_id,
    queueId,
  });
  const nextId = randomUUID();
  await pool.query(
    `INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body) VALUES($1::uuid,$2,$3,'customer','visitor',$1::text,'Later episode')`,
    [nextId, item.conversation_id, next.id],
  );
  const projection = await readConversationPreview(
    pool,
    await authorizeInteractionRead(pool, item.id, supervisor),
  );
  assert.equal(projection.messages.length, 1);
  assert.equal(projection.episodes.length, 2);
  assert.equal("draft" in projection, false);
  await appendEvent(pool, {
    workItemId: item.id,
    type: "text_message_created",
    actor: "customer",
    payload: { message_id: messageId },
  });
  await publishCommittedOutbox(pool);
  const changed = await readConversationSnapshot(pool, {
    workItemId: item.id,
    user: supervisor,
    after: before.cursor,
  });
  assert.ok(changed.snapshot);
  assert.notEqual(changed.cursor, before.cursor);
});
test("report counts full cohorts, attributes transferred work to participants and never calls text duration talk time", async () => {
  const q = "report-only";
  await seedQueue(pool, q, [agentId]);
  for (const channel of RELEASED_CHANNELS) {
    const item = await work(channel, q);
    await openSegment(pool, {
      workItemId: item.id,
      kind: "agent",
      agentId,
      queueId: q,
      startedAt: new Date(Date.now() - 10000).toISOString(),
      answeredAt: new Date(Date.now() - 9000).toISOString(),
    });
    await closeOpenSegment(pool, item.id, { outcome: "completed" });
    await pool.query(
      "UPDATE acd_work_items SET state='completed',terminal_at=now() WHERE id=$1",
      [item.id],
    );
  }
  const result = await readInteractionReport(pool, { ...scope, queueId: q });
  assert.ok(result.totals.avgHandlingSeconds >= 10);
  assert.ok(result.totals.totalTalkSeconds >= 18);
  assert.equal(result.channels.find(c => c.channel === "voice").handlingCount, 1);
  const emailTiming = await readInteractionReport(pool, { ...scope, queueId: q, channel: "email", agentId });
  assert.ok(emailTiming.totals.avgHandlingSeconds >= 10);
  assert.equal(emailTiming.totals.totalTalkSeconds, null);
  const emptyTiming = await readInteractionReport(pool, {
    ...scope, queueId: q, from: "2000-01-01T00:00:00Z", to: "2000-01-02T00:00:00Z",
  });
  assert.equal(emptyTiming.totals.avgHandlingSeconds, null);
  assert.equal(emptyTiming.totals.totalTalkSeconds, 0);
  assert.equal(result.totals.closed, RELEASED_CHANNELS.length);
  assert.equal(result.totals.received, RELEASED_CHANNELS.length);
  assert.equal(
    result.queues.reduce((n, q) => n + q.total, 0),
    RELEASED_CHANNELS.length,
  );
  assert.equal(
    result.channels.find((c) => c.channel === "chat").avgTalkSeconds,
    null,
  );
  assert.ok(
    result.channels.find((c) => c.channel === "voice").avgTalkSeconds > 0,
  );
  assert.equal(
    (await readInteractionReport(pool, { ...scope, queueId: q, agentId }))
      .totals.closed,
    RELEASED_CHANNELS.length,
  );
  assert.equal(
    (
      await readInteractionReport(pool, {
        ...scope,
        queueId: q,
        channel: "email",
      })
    ).totals.closed,
    1,
  );
  assert.equal(
    (await readLiveWorkload(pool, agentId)).scope.includes("All channels"),
    true,
  );
});
test("periods contain 7 and 30 calendar days, reject invalid channels and preserve DST boundaries", async () => {
  for (const [period, days] of [
    ["7days", 7],
    ["30days", 30],
  ]) {
    const result = await resolveReportingScope(
      pool,
      new URLSearchParams({ period, timezone: "UTC" }),
    );
    assert.equal(
      (Date.parse(result.to) - Date.parse(result.from)) / 86400000,
      days,
    );
  }
  await assert.rejects(
    resolveReportingScope(
      pool,
      new URLSearchParams({ timezone: "Invalid/Timezone" }),
    ),
    { status: 400 },
  );
  const result = await resolveReportingScope(
    pool,
    new URLSearchParams({
      timezone: "Europe/Warsaw",
      from: "2026-03-29T00:00:00+01:00",
      to: "2026-03-30T00:00:00+02:00",
    }),
  );
  assert.equal((Date.parse(result.to) - Date.parse(result.from)) / 3600000, 23);
});

test("late committed messages older than the latest page still reach a live observer", async () => {
  const item = await work("chat"),
    supervisor = { id: agentId, roles: ["supervisor"] },
    ids = [];
  for (let i = 0; i < 105; i++) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      `INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body) VALUES($1::uuid,$2,$3,'customer','visitor',$1::text,$4)`,
      [id, item.conversation_id, item.id, String(i)],
    );
  }
  const initial = await readConversationSnapshot(pool, {
    workItemId: item.id,
    user: supervisor,
  });
  assert.equal(initial.snapshot.messages.length, 100);
  assert.equal(initial.snapshot.hasMore, true);
  await appendEvent(pool, {
    workItemId: item.id,
    type: "text_message_created",
    actor: "customer",
    payload: { message_id: ids[0] },
  });
  await publishCommittedOutbox(pool);
  const next = await readConversationSnapshot(pool, {
    workItemId: item.id,
    user: supervisor,
    after: initial.cursor,
  });
  assert.ok(next.snapshot.messages.some((message) => message.id === ids[0]));
});

test("monitor uses all-channel capacity and all closed outcomes without legacy tables", async () => {
  const result = await readMonitorStatistics(pool, { timezone: "UTC" });
  assert.ok(result.queues.some((q) => q.queueId === queueId));
  assert.equal(
    result.agents.some((a) => a.userId === agentId),
    true,
  );
  assert.equal(typeof result.overall.calls.total, "number");
  assert.equal(
    result.agents.find((a) => a.userId === agentId).capacityBudget,
    1,
  );
});
test("skills, handoff, transfers and ongoing adherence readers execute against Core fixtures", async () => {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS aa_ai_handoff_events(id TEXT PRIMARY KEY,work_item_id UUID,status TEXT,error_message TEXT,created_at TIMESTAMPTZ DEFAULT now())`,
  );
  assert.equal((await readHandoffReport(pool, scope)).totals.handoffs, 0);
  assert.ok(Array.isArray((await readSkillsReport(pool, scope)).demand));
  const transfer = await transfersHoldsReport(pool, {
    ...scope,
    queueName: null,
    channel: "chat",
  });
  assert.equal(transfer.totals.holdCount, null);
  const adherence = await agentAdherenceReport(pool, scope);
  assert.ok(Array.isArray(adherence.agents));
});
test("a future messaging channel uses the common episode reader without email or voice assumptions", async () => {
  const item = await work("whatsapp"),
    id = randomUUID();
  await pool.query(
    `INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body) VALUES($1::uuid,$2,$3,'customer','visitor',$1::text,'Future provider message')`,
    [id, item.conversation_id, item.id],
  );
  const preview = await readConversationPreview(pool, item);
  assert.equal(preview.messages[0].body, "Future provider message");
  assert.equal(preview.mailbox, null);
  const transcript = await readMessageTranscript(pool, item.id);
  assert.match(transcript.text, /Future provider message/);
});

test("transfer attribution keeps queue durations and each agent reply scoped to their own segments", async () => {
  const firstQueue = "transfer-first",
    lastQueue = "transfer-last",
    secondAgent = "second-agent";
  await seedAgent(pool, secondAgent);
  await seedQueue(pool, firstQueue, [agentId]);
  await seedQueue(pool, lastQueue, [secondAgent]);
  const item = await work("chat", firstQueue),
    start = Date.now() - 100000;
  await pool.query("UPDATE acd_work_items SET created_at=$2 WHERE id=$1", [
    item.id,
    new Date(start),
  ]);
  const first = await openSegment(pool, {
    workItemId: item.id,
    kind: "agent",
    agentId,
    queueId: firstQueue,
    startedAt: new Date(start + 10000).toISOString(),
  });
  await closeOpenSegment(pool, item.id, { outcome: "transferred" });
  await pool.query("UPDATE acd_segments SET ended_at=$2 WHERE id=$1", [
    first.id,
    new Date(start + 30000),
  ]);
  const second = await openSegment(pool, {
    workItemId: item.id,
    kind: "agent",
    agentId: secondAgent,
    queueId: lastQueue,
    startedAt: new Date(start + 40000).toISOString(),
  });
  await closeOpenSegment(pool, item.id, { outcome: "completed" });
  await pool.query("UPDATE acd_segments SET ended_at=$2 WHERE id=$1", [
    second.id,
    new Date(start + 90000),
  ]);
  const message = randomUUID();
  await pool.query(
    `INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body,created_at) VALUES($1::uuid,$2,$3,'agent',$4,$1::text,'First agent reply',$5)`,
    [message, item.conversation_id, item.id, agentId, new Date(start + 18000)],
  );
  await appendEvent(pool, {
    workItemId: item.id,
    type: "text_message_created",
    actor: "agent",
    payload: { message_id: message, sender_role: "agent" },
  });
  await pool.query(
    "UPDATE acd_work_items SET queue_id=$2,state='completed',terminal_at=$3 WHERE id=$1",
    [item.id, lastQueue, new Date(start + 95000)],
  );
  const personal = await readInteractionReport(pool, {
    ...scope,
    queueId: firstQueue,
    agentId,
  });
  const row = personal.channels.find((row) => row.channel === "chat");
  assert.equal(personal.totals.closed, 1);
  assert.equal(row.avgHandlingSeconds, 20);
  assert.equal(row.avgAgentResponseSeconds, 8);
  const last = await readInteractionReport(pool, {
    ...scope,
    queueId: lastQueue,
  });
  assert.equal(
    last.channels.find((row) => row.channel === "chat").avgHandlingSeconds,
    50,
  );
  const monitor = await readMonitorStatistics(pool, { timezone: "UTC" });
  assert.equal(
    monitor.queues.find((q) => q.queueId === firstQueue).today.totalCalls,
    1,
  );
  assert.equal(
    monitor.queues.find((q) => q.queueId === lastQueue).today.totalCalls,
    1,
  );
  assert.equal(
    (
      await authorizeInteractionRead(pool, item.id, {
        id: agentId,
        roles: ["agent"],
      })
    ).id,
    item.id,
  );
});
test("fractional capacity includes active and saga-owned claims but excludes expired unowned claims", async () => {
  const owner = "capacity-reader";
  await seedAgent(pool, owner);
  for (const [channel, weight, state, saga] of [
    ["chat", 0.33, "active", null],
    ["chat", 0.33, "active", null],
    ["email", 0.2, "reserved", randomUUID()],
    ["voice", 1, "reserved", null],
  ]) {
    const item = await work(channel);
    await pool.query(
      `INSERT INTO acd_reservations(id,agent_id,work_item_id,channel,weight,state,lease_expires_at,owner_saga_id) VALUES($1,$2,$3,$4,$5,$6,now()-interval '1 minute',$7)`,
      [randomUUID(), owner, item.id, channel, weight, state, saga],
    );
  }
  const load = await readLiveWorkload(pool, owner);
  assert.equal(load.used, 0.86);
  assert.equal(load.interactions.length, 3);
  assert.equal(load.budget, 1);
});
test("excluded work never becomes an at-risk SLA measurement and earlier durable evidence corrects a breach", async () => {
  const outbound = await createWorkItem(pool, {
    channel: "chat",
    direction: "outbound",
    queueId,
  });
  await pool.query(
    "UPDATE acd_sla_measurements SET started_at=now()-interval '100 seconds',deadline_at=now()+interval '10 seconds' WHERE work_item_id=$1",
    [outbound.id],
  );
  const excluded = (
    await pool.query("SELECT * FROM acd_sla_status WHERE work_item_id=$1", [
      outbound.id,
    ])
  ).rows[0];
  assert.equal(excluded.state, "excluded");
  assert.equal(excluded.at_risk, false);
  const item = await work("chat"),
    measurement = (
      await pool.query(
        "SELECT * FROM acd_sla_measurements WHERE work_item_id=$1",
        [item.id],
      )
    ).rows[0];
  await recordSlaService(pool, {
    workItemId: item.id,
    serviceEvent: "human_message_persisted",
    occurredAt: new Date(+measurement.deadline_at + 1000),
    evidenceId: "late",
  });
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM acd_sla_status WHERE work_item_id=$1",
        [item.id],
      )
    ).rows[0].state,
    "breached",
  );
  await recordSlaService(pool, {
    workItemId: item.id,
    serviceEvent: "human_message_persisted",
    occurredAt: measurement.deadline_at,
    evidenceId: "earlier",
  });
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM acd_sla_status WHERE work_item_id=$1",
        [item.id],
      )
    ).rows[0].state,
    "met",
  );
});
test("read snapshots perform no writes and revoked identities cannot read", async () => {
  const item = await work("chat");
  const counts = async () =>
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM acd_events) AS events,(SELECT count(*) FROM acd_reservations) AS reservations,(SELECT count(*) FROM acd_messages) AS messages",
      )
    ).rows[0];
  const before = await counts();
  await readConversationSnapshot(pool, {
    workItemId: item.id,
    user: { id: agentId, roles: ["supervisor"] },
  });
  assert.deepEqual(await counts(), before);
  await assert.rejects(
    readConversationSnapshot(pool, {
      workItemId: item.id,
      user: { id: agentId, roles: ["supervisor"], active: false },
    }),
    { status: 401 },
  );
});
test("empty filtered SLA populations are unevaluated and no-queue work remains visible", async () => {
  const item = await work("email", null);
  await pool.query(
    "UPDATE acd_work_items SET state='failed',terminal_at=now() WHERE id=$1",
    [item.id],
  );
  const result = await readInteractionReport(pool, {
    ...scope,
    queueId: "none",
    channel: "email",
  });
  assert.equal(result.totals.closed, 1);
  assert.equal(result.queues[0].queue_id, null);
  assert.ok(Array.isArray(result.slaTrend));
  assert.equal(
    (await readInteractionReport(pool, { ...scope, queueId: "missing" })).sla
      .rate,
    null,
  );
});

test("conversation attachments reject another episode before loading bytes", async () => {
  const { loadRoute } = await import("./helpers/route-harness.mjs");
  const first = await work("chat"),
    other = await work("chat"),
    message = randomUUID(),
    attachment = randomUUID();
  await pool.query(
    `INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body) VALUES($1::uuid,$2,$3,'customer','visitor',$1::text,'File')`,
    [message, first.conversation_id, first.id],
  );
  await pool.query(
    `INSERT INTO acd_text_attachments(id,message_id,conversation_id,name,content_type,bytes,byte_size,content_hash) VALUES($1,$2,$3,'receipt.txt','text/plain',$4,2,'test')`,
    [attachment, message, first.conversation_id, Buffer.from("ok")],
  );
  let reads = 0;
  const route = await loadRoute(
    "app/api/contact-center/interactions/[id]/conversation/attachments/[attachmentId]/route.js",
    {
      "@/lib/auth-server": {
        getAuthenticatedUser: async () => ({
          id: agentId,
          roles: ["supervisor"],
        }),
      },
      "@/lib/postgres.mjs": { getPostgresPool: () => pool },
      "@/lib/acd/conversation-preview.mjs": { authorizeInteractionRead },
      "@/lib/widgets/attachments": {
        attachmentResponse: () => {
          reads++;
          return { status: 200 };
        },
      },
    },
  );
  const request = new Request("https://cc.example.test/attachment");
  assert.equal(
    (
      await route.GET(request, {
        params: { id: other.id, attachmentId: attachment },
      })
    ).status,
    404,
  );
  assert.equal(reads, 0);
  assert.equal(
    (
      await route.GET(request, {
        params: { id: first.id, attachmentId: attachment },
      })
    ).status,
    200,
  );
  assert.equal(reads, 1);
});
test("email preview redacts Bcc and provider attachment locations while retaining recipient delivery status", async () => {
  const item = await work("email"),
    mailbox = randomUUID(),
    message = randomUUID();
  await pool.query(
    `INSERT INTO cc_email_mailboxes(id,provider_inbox_id,domain_id,address,name,queue_id) VALUES($1::uuid,$1::text,'test',$2,'Test mailbox',$3)`,
    [mailbox, mailbox + "@example.test", queueId],
  );
  await pool.query(
    `INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body) VALUES($1::uuid,$2,$3,'agent',$4,$1::text,'Email')`,
    [message, item.conversation_id, item.id, agentId],
  );
  await pool.query(
    `INSERT INTO cc_email_messages(message_id,mailbox_id,envelope,status) VALUES($1,$2,$3,'accepted')`,
    [
      message,
      mailbox,
      JSON.stringify({
        from: "agent@example.test",
        to: ["customer@example.test"],
        bcc: ["private@example.test"],
        attachments: [
          {
            filename: "document.pdf",
            url: "https://private.example.test/token",
            storage_key: "secret/key",
          },
        ],
      }),
    ],
  );
  await pool.query(
    `INSERT INTO cc_email_deliveries(message_id,recipient_id,kind,address,status,occurred_at) VALUES($1,'one','to','customer@example.test','delivered',now()),($1,'two','bcc','private@example.test','delivered',now())`,
    [message],
  );
  const preview = await readConversationPreview(pool, item);
  const json = JSON.stringify(preview);
  assert.doesNotMatch(json, /private@example|private.example|secret\/key/);
  assert.equal(preview.messages[0].deliveries[0].status, "delivered");
  assert.ok(
    preview.messages[0].attachments[0].url.startsWith(
      "/api/contact-center/interactions/",
    ),
  );
});
test("observer reconnect resumes committed events and invalid future cursors request a fresh snapshot", async () => {
  const item = await work("chat"),
    user = { id: agentId, roles: ["supervisor"] };
  const first = await readConversationSnapshot(pool, {
    workItemId: item.id,
    user,
  });
  assert.equal(first.reset, true);
  const invalid = await readConversationSnapshot(pool, {
    workItemId: item.id,
    user,
    after: "9223372036854770000",
  });
  assert.equal(invalid.reset, true);
  assert.ok(invalid.snapshot);
});

test("new queues inherit the global voice policy instead of the legacy column default", async () => {
  const queue = "new-inheriting-queue";
  await seedQueue(pool, queue, [agentId]);
  const row = (
    await pool.query(
      "SELECT to_jsonb(q) AS config FROM cc_queues q WHERE id=$1",
      [queue],
    )
  ).rows[0].config;
  assert.equal(row.sla_policies.voice.mode, "inherit");
  const resolved = effectiveSlaPolicy(
    "voice",
    { revision: 7, policies: { voice: { ...policy, thresholdSeconds: 42 } } },
    { ...row, sla_answer_threshold_seconds: 20 },
  );
  assert.equal(resolved.thresholdSeconds, 42);
  assert.equal(resolved.source, "global");
  assert.equal(resolved.revision, 7);
});

test("a registered synthetic channel reuses report, SLA, capabilities and conversation modules unchanged", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const directory = await mkdtemp(join(tmpdir(), "cc-channel-contract-"));
  try {
    for (const name of [
      "channel-registry.mjs",
      "interaction-channels.mjs",
      "interaction-reporting.mjs",
      "supervisor-report-details.mjs",
      "sla-report-summary.mjs",
      "workforce-reports.mjs",
      "agent-state.mjs",
      "events.mjs",
      "sla.mjs",
      "conversation-preview.mjs",
    ]) {
      let source = await readFile(
        new URL("../lib/acd/" + name, import.meta.url),
        "utf8",
      );
      if (name === "channel-registry.mjs")
        source = source.replace(
          "const entries = {",
          `const entries = { test_social: ${JSON.stringify({ ...CHANNEL_REGISTRY.chat, id: undefined, label: "Test social", released: true })},`,
        );
      // The report modules apply the caller's data scope (Phase 3a); point the copies at the real helper.
      source = source.replace('"../authz/scope.mjs"', JSON.stringify(new URL("../lib/authz/scope.mjs", import.meta.url).href));
      await writeFile(join(directory, name), source);
    }
    // Keep the isolated synthetic catalogue with the email reader dependencies.
    const previewPath = join(directory, "conversation-preview.mjs");
    for (const dependency of ["preview-settings.mjs", "content.mjs"]) {
      await writeFile(previewPath, (await readFile(previewPath, "utf8")).replace(`../email/${dependency}`, `./email-${dependency}`));
      await writeFile(join(directory, `email-${dependency}`), await readFile(new URL(`../lib/email/${dependency}`, import.meta.url), "utf8"));
    }
    const imported = (name) =>
      import(pathToFileURL(join(directory, name)).href);
    const registry = await imported("channel-registry.mjs"),
      channels = await imported("interaction-channels.mjs"),
      sla = await imported("sla.mjs"),
      reporting = await imported("interaction-reporting.mjs"),
      reader = await imported("conversation-preview.mjs");
    assert.equal(channels.parseChannel("test_social"), "test_social");
    assert.ok(registry.RELEASED_CHANNELS.includes("test_social"));
    assert.equal(
      channels.interactionCapabilities({
        channel: "test_social",
        conversationId: "test",
      }).conversation,
      true,
    );
    const global = await sla.loadGlobalSla(pool);
    await sla.saveSlaPolicies(pool, {
      revision: Number(global.revision),
      policies: { test_social: policy },
      actor: "test",
    });
    const conversation = randomUUID();
    await pool.query(
      "INSERT INTO acd_conversations(id,channel) VALUES($1,'test_social')",
      [conversation],
    );
    const item = await createWorkItem(pool, {
      channel: "test_social",
      direction: "inbound",
      queueId,
      conversationId: conversation,
    });
    await sla.startSlaMeasurement(pool, item);
    const message = randomUUID();
    await pool.query(
      `INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body) VALUES($1::uuid,$2,$3,'agent',$4,$1::text,'Generic provider reply')`,
      [message, conversation, item.id, agentId],
    );
    await appendEvent(pool, {
      workItemId: item.id,
      type: "text_message_created",
      actor: "agent",
      payload: { message_id: message, sender_role: "agent" },
    });
    await pool.query(
      "UPDATE acd_work_items SET state='completed',terminal_at=now() WHERE id=$1",
      [item.id],
    );
    const result = await reporting.readInteractionReport(pool, {
      ...scope,
      channel: "test_social",
    });
    assert.equal(result.channels[0].closed, 1);
    assert.equal(result.channels[0].sla.met, 1);
    assert.equal(result.channels[0].avgTalkSeconds, null);
    for (const type of ["queue-performance", "agent-performance", "abandonment", "wrapup-codes"]) {
      const specialized = await reporting.readInteractionReport(pool, { ...scope, channel: "test_social" }, type);
      assert.equal(specialized.detail.report, type);
      assert.equal(specialized.channels[0].closed, 1);
      for (const row of specialized.detail.queues || []) assert.equal(row.channel, "test_social");
    }
    assert.equal(
      (await reader.readConversationPreview(pool, item)).messages[0].body,
      "Generic provider reply",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('RBAC monitor preserves queue/channel correlations in SQL aggregates', async () => {
  const qa = 'rbac-monitor-a', qb = 'rbac-monitor-b';
  await seedQueue(pool, qa, [agentId]);
  await seedQueue(pool, qb, [agentId]);
  const items = [await work('voice', qa), await work('sms', qa), await work('voice', qb), await work('sms', qb)];
  await pool.query("UPDATE acd_work_items SET state='queued' WHERE id=ANY($1::uuid[])", [items.map(item => item.id)]);
  const { mergeScopes } = await import('../lib/authz/scope.mjs');
  const clause = (queue, channel) => ({ restricted: true, queueIds: [queue], teamIds: null, teamAgentIds: null, agentIds: [agentId], campaignIds: null, channels: [channel], selfId: 'rbac-nonparticipant' });
  const restriction = mergeScopes(clause(qa, 'voice'), clause(qb, 'sms'));
  const result = await readMonitorStatistics(pool, { timezone: 'UTC', restriction });
  assert.deepEqual(result.queues.map(q => q.queueId).sort(), [qa, qb]);
  assert.deepEqual(result.queues.find(q => q.queueId === qa).channels.map(c => c.channel), ['voice']);
  assert.deepEqual(result.queues.find(q => q.queueId === qb).channels.map(c => c.channel), ['sms']);
  assert.equal(result.overall.queues.totalWaitingCalls, 2);
});
