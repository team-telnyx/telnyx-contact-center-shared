import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { makeFakeProvider, prepareAcdTestPool, seedAgent } from "./helpers/acd-test-db.mjs";
import {
  applyAcdArtifactEvent,
  resolveAcdArtifactContext,
  upsertWorkItemAnnotation,
} from "../lib/acd/artifacts.mjs";
import { ensureAcdArtifactSchema } from "../lib/acd/artifact-schema.mjs";
import { recordHoldIntent } from "../lib/acd/hold-intents.mjs";
import { applySagaEvent } from "../lib/acd/saga-engine.mjs";

const pool = await prepareAcdTestPool("acd_core_test_artifacts");
after(() => pool.end());

async function coreCall({ sessionId = `session-${randomUUID()}`, terminal = false, agentId = null } = {}) {
  const workItemId = randomUUID();
  const customerLegId = randomUUID();
  const agentLegId = randomUUID();
  const customerCallId = `v3:customer-${randomUUID()}`;
  const agentCallId = `v3:agent-${randomUUID()}`;
  await pool.query(
    `INSERT INTO acd_work_items
       (id, channel, direction, state, provider_session_id, terminal_at)
     VALUES ($1, 'voice', 'inbound', $2, $3,
             CASE WHEN $4 THEN now() ELSE NULL END)`,
    [workItemId, terminal ? "completed" : "active", sessionId, terminal],
  );
  await pool.query(
    `INSERT INTO acd_legs
       (id, work_item_id, role, provider_call_id, provider_session_id, state, ended_at, bridged_at)
     VALUES
       ($1,$3,'customer',$4,$6,$7,CASE WHEN $7='ended' THEN now() ELSE NULL END,CASE WHEN $7='bridged' THEN now() ELSE NULL END),
       ($2,$3,'agent_device',$5,$6,$7,CASE WHEN $7='ended' THEN now() ELSE NULL END,CASE WHEN $7='bridged' THEN now() ELSE NULL END)`,
    [
      customerLegId,
      agentLegId,
      workItemId,
      customerCallId,
      agentCallId,
      sessionId,
      terminal ? "ended" : "bridged",
    ],
  );
  if (agentId) {
    await pool.query(`UPDATE acd_legs SET agent_id = $2 WHERE id = $1`, [agentLegId, agentId]);
    await pool.query(
      `INSERT INTO acd_segments
         (id, work_item_id, seq, kind, agent_id, started_at, answered_at)
       VALUES ($1,$2,1,'agent',$3,now(),now())`,
      [randomUUID(), workItemId, agentId],
    );
  }
  return { workItemId, customerLegId, agentLegId, customerCallId, agentCallId, sessionId };
}

test("recording events bind to the exact Core leg and redelivery is idempotent", async () => {
  const call = await coreCall();
  const event = {
    eventId: `evt-${randomUUID()}`,
    eventType: "call.recording.saved",
    provider: "telnyx",
    occurredAt: new Date().toISOString(),
    payload: {
      call_control_id: call.customerCallId,
      call_session_id: call.sessionId,
      recording_id: `rec-${randomUUID()}`,
      format: "mp3",
      channels: "dual",
      recording_urls: { mp3: "https://media.example.test/call.mp3" },
    },
  };

  assert.equal((await applyAcdArtifactEvent(pool, event)).outcome, "applied");
  assert.equal((await applyAcdArtifactEvent(pool, event)).outcome, "applied");

  const rows = await pool.query(
    `SELECT work_item_id, leg_id, recording_url FROM acd_recordings
      WHERE provider_recording_id = $1`,
    [event.payload.recording_id],
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].work_item_id, call.workItemId);
  assert.equal(rows.rows[0].leg_id, call.customerLegId);
  assert.equal(rows.rows[0].recording_url, event.payload.recording_urls.mp3);
  const durableEvents = await pool.query(
    `SELECT COUNT(*)::int AS count FROM acd_events
      WHERE type = 'recording_saved' AND payload->>'source_event_id' = $1`,
    [event.eventId],
  );
  assert.equal(durableEvents.rows[0].count, 1);
});

test("a post-call artifact can use one unambiguous provider session", async () => {
  const call = await coreCall({ terminal: true });
  const event = {
    eventId: `evt-${randomUUID()}`,
    eventType: "call.recording.transcription.saved",
    occurredAt: new Date().toISOString(),
    payload: {
      call_session_id: call.sessionId,
      transcription_id: `tr-${randomUUID()}`,
      transcription_text: "The customer confirmed the order.",
      language: "en",
    },
  };
  const result = await applyAcdArtifactEvent(pool, event);
  assert.equal(result.outcome, "applied");
  const row = (
    await pool.query(`SELECT * FROM acd_transcripts WHERE source_event_id = $1`, [event.eventId])
  ).rows[0];
  assert.equal(row.work_item_id, call.workItemId);
  assert.equal(row.source, "recording");
  assert.equal(row.text, event.payload.transcription_text);
});

test("session fallback fails closed when two work items share a provider session", async () => {
  const sessionId = `session-${randomUUID()}`;
  await coreCall({ sessionId });
  await coreCall({ sessionId });
  const resolved = await resolveAcdArtifactContext(pool, { call_session_id: sessionId });
  assert.equal(resolved, null);
  const result = await applyAcdArtifactEvent(pool, {
    eventId: `evt-${randomUUID()}`,
    eventType: "call.recording.saved",
    payload: { call_session_id: sessionId, recording_id: `rec-${randomUUID()}` },
  });
  assert.equal(result.outcome, "unmatched");
});

test("only final live utterances become native transcript rows", async () => {
  const call = await coreCall();
  const base = {
    eventType: "call.transcription",
    payload: {
      call_control_id: call.agentCallId,
      call_session_id: call.sessionId,
      transcription_data: {
        transcript: "I can help with that.",
        transcription_track: "outbound",
        language: "en",
      },
    },
  };
  const interim = await applyAcdArtifactEvent(pool, {
    ...base,
    eventId: `evt-${randomUUID()}`,
    payload: {
      ...base.payload,
      transcription_data: { ...base.payload.transcription_data, speech_final: false, is_final: true },
    },
  });
  assert.equal(interim.outcome, "noop");

  const finalEventId = `evt-${randomUUID()}`;
  const final = await applyAcdArtifactEvent(pool, {
    ...base,
    eventId: finalEventId,
    payload: {
      ...base.payload,
      transcription_data: { ...base.payload.transcription_data, speech_final: true, is_final: true },
    },
  });
  assert.equal(final.outcome, "applied");
  const rows = await pool.query(
    `SELECT leg_id, source, track, text FROM acd_transcripts WHERE work_item_id = $1`,
    [call.workItemId],
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].leg_id, call.agentLegId);
  assert.equal(rows.rows[0].source, "live");
  assert.equal(rows.rows[0].track, "outbound");
});

test("annotations and business artifacts can link with only a Core work-item reference", async () => {
  const call = await coreCall();
  const first = await upsertWorkItemAnnotation(pool, {
    workItemId: call.workItemId,
    notes: "Needs follow-up",
    tags: ["follow-up"],
    actorId: "supervisor-1",
  });
  const second = await upsertWorkItemAnnotation(pool, {
    workItemId: call.workItemId,
    notes: "Resolved",
    tags: ["resolved"],
    actorId: "supervisor-2",
  });
  assert.equal(first.work_item_id, second.work_item_id);
  assert.equal(second.notes, "Resolved");

  await pool.query(`
    CREATE TABLE form_submissions (id UUID PRIMARY KEY, interaction_id TEXT);
    CREATE TABLE aa_workflow_sessions (id UUID PRIMARY KEY, interaction_id TEXT NOT NULL UNIQUE);
    CREATE TABLE aa_ai_handoff_events (id UUID PRIMARY KEY, interaction_id TEXT);
    CREATE TABLE quality_evaluations (id UUID PRIMARY KEY, interaction_id TEXT NOT NULL);
    CREATE TABLE quality_ai_jobs (id UUID PRIMARY KEY, interaction_id TEXT);
  `);
  await ensureAcdArtifactSchema(pool);

  for (const table of [
    "form_submissions",
    "aa_workflow_sessions",
    "aa_ai_handoff_events",
    "quality_evaluations",
    "quality_ai_jobs",
  ]) {
    await pool.query(`INSERT INTO ${table} (id, work_item_id) VALUES ($1,$2)`, [
      randomUUID(),
      call.workItemId,
    ]);
    const linked = await pool.query(
      `SELECT work_item_id FROM ${table} WHERE work_item_id = $1`,
      [call.workItemId],
    );
    assert.equal(linked.rowCount, 1, `${table} should accept a Core-only link`);
    const retiredColumn = await pool.query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1
          AND column_name = 'interaction_id'`,
      [table],
    );
    assert.equal(retiredColumn.rowCount, 0, `${table} should expose only the Core link`);
  }
});

test("hold intents validate the live agent leg and use one server-timestamped transition", async () => {
  const agentId = randomUUID();
  await seedAgent(pool, agentId);
  const call = await coreCall({ agentId });
  const requestId = randomUUID();
  const before = Date.now();
  const first = await recordHoldIntent(pool, {
    interactionId: call.workItemId,
    agentId,
    action: "hold",
    requestId,
  });
  const duplicate = await recordHoldIntent(pool, {
    interactionId: call.workItemId,
    agentId,
    action: "hold",
    requestId,
  });
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.eventId, first.eventId);
  const held = await pool.query(
    `SELECT e.occurred_at, l.state
       FROM acd_events e JOIN acd_legs l ON l.id = (e.payload->>'leg_id')::uuid
      WHERE e.id = $1`,
    [first.eventId],
  );
  assert.equal(held.rowCount, 1);
  assert.equal(held.rows[0].state, "held");
  assert.ok(new Date(held.rows[0].occurred_at).getTime() >= before);
  assert.equal(
    Number((await pool.query(`SELECT COUNT(*) AS count FROM acd_events WHERE type='hold_started' AND work_item_id=$1`, [call.workItemId])).rows[0].count),
    1,
  );

  await assert.rejects(
    recordHoldIntent(pool, {
      interactionId: call.workItemId,
      agentId: randomUUID(),
      action: "unhold",
    }),
    { status: 403 },
  );
  const resumed = await recordHoldIntent(pool, {
    interactionId: call.workItemId,
    agentId,
    action: "unhold",
  });
  assert.equal(resumed.state, "active");
  const leg = await pool.query(`SELECT state FROM acd_legs WHERE id=$1`, [call.agentLegId]);
  assert.equal(leg.rows[0].state, "bridged");
});

test("agent hold plays configured customer media and stops it on unhold", async () => {
  const agentId = randomUUID();
  await seedAgent(pool, agentId);
  const call = await coreCall({ agentId });
  const provider = makeFakeProvider();
  const held = await recordHoldIntent(pool, {
    interactionId: call.workItemId,
    agentId,
    action: "hold",
    provider,
    holdSettings: {
      media_name: "agent-hold.wav",
      announcement_enabled: true,
      announcement_text: "Please stay on the line.",
      announcement_voice: "AWS.Polly.Joanna",
      announcement_language: "en-US",
      announcement_interval_seconds: 30,
    },
  });
  assert.ok(held.sagaId);
  const speak = provider.calls.find((entry) => entry.operation === "agent_hold_speak_announcement");
  assert.match(speak.endpoint, new RegExp(`${encodeURIComponent(call.customerCallId)}/actions/speak$`));
  assert.equal(speak.request.target_legs, "self");

  await applySagaEvent(pool, {
    workItemId: call.workItemId,
    name: "media.speak_ended",
    role: "customer",
    provider,
  });
  const music = provider.calls.find((entry) => entry.operation === "agent_hold_start_music");
  assert.match(music.endpoint, new RegExp(`${encodeURIComponent(call.customerCallId)}/actions/playback_start$`));
  assert.equal(music.request.media_name, "agent-hold.wav");

  await recordHoldIntent(pool, {
    interactionId: call.workItemId,
    agentId,
    action: "unhold",
    provider,
  });
  const stop = provider.calls.find((entry) => entry.operation === "agent_hold_stop_audio");
  assert.match(stop.endpoint, new RegExp(`${encodeURIComponent(call.customerCallId)}/actions/playback_stop$`));
  assert.equal(
    (await pool.query(`SELECT state FROM acd_sagas WHERE id=$1`, [held.sagaId])).rows[0].state,
    "succeeded",
  );
});
