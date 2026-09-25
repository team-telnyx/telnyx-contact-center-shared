import {createMobileScreenGrant, validateMobileScreenGrant, refreshMobileScreenGrant, verifyScreenGrant, signScreenGrant} from "../lib/video/mobile-screen.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool, seedAgent, seedQueue, makeTxRunner } from "./helpers/acd-test-db.mjs";
import { heartbeatAgentSession } from "../lib/acd/sessions.mjs";
import { routeOne } from "../lib/acd/router.mjs";
import { actOnTextWork, createChatWork, NATIVE_TEXT_PROVIDER } from "../lib/acd/text-lifecycle.mjs";
import { completeAcdWrapup } from "../lib/acd/wrapup.mjs";
import { readAgentSnapshot } from "../lib/acd/stream.mjs";
import { checkInvariants } from "../lib/acd/lifecycle.mjs";
import { interactionCapabilities } from "../lib/acd/interaction-channels.mjs";
import { clearSagaDeadlineWakeups, sweepDueSagas } from "../lib/acd/saga-engine.mjs";
import { messagingTransferTargets, transferTextWork } from "../lib/acd/text-transfer.mjs";
import { readTextInteractions } from "../lib/acd/text-desktop.mjs";
import { parseChannelPolicies } from "../lib/acd/channel-policy.mjs";
import { NATIVE_LIFECYCLE_CHANNELS, MESSAGING_CHANNELS, channelDefinition } from "../lib/acd/channel-registry.mjs";
import {
  agentJoinToken, applyVideoRoomEvent, createVideoWork, customerJoinToken, endVideoRoom, endVideoSupervision, provisionVideoRoom, refreshJoinToken, setVideoSupervisionMode, startVideoSupervision,
  readVideoDetail, readVideoSession, readVideoWidgetState, videoRecordingStreamPath,
} from "../lib/video/lifecycle.mjs";

const pool = await prepareAcdTestPool("acd_core_test_native_video");
await pool.query(`CREATE TABLE IF NOT EXISTS cc_wrapup_codes(id text PRIMARY KEY,name text,is_active boolean DEFAULT true);
  CREATE TABLE IF NOT EXISTS cc_queue_wrapup_codes(queue_id text,wrapup_code_id text);
  ALTER TABLE cc_wrapup_codes ADD COLUMN IF NOT EXISTS icon text, ADD COLUMN IF NOT EXISTS color text;`);
const withTx = makeTxRunner(pool);
after(async () => { clearSagaDeadlineWakeups(); await pool.end(); });

function fakeRooms() {
  const calls = [];
  const prefix = randomUUID().slice(0, 8);
  let rooms = 0, compositions = 0;
  return {
    calls,
    roomId: (n = 1) => `room-${prefix}-${n}`,
    compositionId: (n = 1) => `comp-${prefix}-${n}`,
    async createRoom(input) { calls.push(["createRoom", input]); return { id: `room-${prefix}-${++rooms}`, unique_name: input.uniqueName }; },
    async deleteRoom(id) { calls.push(["deleteRoom", id]); return {}; },
    async generateJoinToken(roomId) { calls.push(["token", roomId]); return { token: `jwt-${roomId}`, refreshToken: "refresh", expiresAt: null, refreshExpiresAt: null }; },
    async refreshJoinToken(roomId, refreshToken) { calls.push(["refresh", roomId, refreshToken]); return { token: "jwt-2", refreshToken }; },
    async endSession(sessionId) { calls.push(["endSession", sessionId]); return { result: "ok" }; },
    async createComposition(input) { calls.push(["createComposition", input]); return { id: `comp-${prefix}-${++compositions}`, status: "enqueued" }; },
    async getComposition(id) { calls.push(["getComposition", id]); return { id, status: "completed", duration_secs: 42, size_mb: 3.5, resolution: "1280x720", download_url: "https://s3.example/x" }; },
  };
}

async function fixture({ channel = "video", agentMax = 1, weight = 1 } = {}) {
  const agentId = randomUUID(), queueId = randomUUID();
  await seedAgent(pool, agentId, { voiceReady: false });
  await pool.query("UPDATE users SET telephony_credentials_id=NULL WHERE id=$1", [agentId]);
  await seedQueue(pool, queueId, [agentId]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,$2,true,$3,$4)", [agentId, channel, agentMax, weight]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,$2,true,$3,$4)", [queueId, channel, agentMax, weight]);
  const ready = await heartbeatAgentSession(pool, { agentId, sessionId: randomUUID(), ready: { [channel]: true } });
  return { agentId, queueId, ready, create: (options = {}) => withTx((tx) => channel === "video"
    ? createVideoWork(tx, { queueId, customerName: "Video visitor", recording: { enabled: true, layout: "pip" }, ...options })
    : createChatWork(tx, { queueId })) };
}

async function act(work, agentId, action, data = {}) {
  const current = (await pool.query("SELECT * FROM acd_work_items WHERE id=$1", [work.id])).rows[0];
  const offer = (await pool.query("SELECT id FROM acd_offers WHERE work_item_id=$1 AND agent_id=$2 ORDER BY generation DESC LIMIT 1", [work.id, agentId])).rows[0];
  return actOnTextWork(pool, { workItemId: work.id, agentId, commandId: randomUUID(), expectedVersion: current.version, action, channel: "video", offerId: offer?.id, ...data });
}

const roomEvent = (type, payload, id = randomUUID()) => ({ eventId: id, eventType: type, occurredAt: new Date().toISOString(), payload });
let sessionId = "";
const newSession = () => { sessionId = `sess-${randomUUID().slice(0, 8)}`; return sessionId; };

test("video is a released, exclusive native-lifecycle channel that stays out of the messaging set", () => {
  assert.ok(NATIVE_LIFECYCLE_CHANNELS.includes("video"));
  assert.ok(!MESSAGING_CHANNELS.includes("video"));
  const definition = channelDefinition("video");
  assert.equal(definition.viewer, "video"); assert.equal(definition.family, "video");
  assert.equal(definition.capabilities.recordings, true); assert.equal(definition.capabilities.conversation, false);
  assert.deepEqual(definition.capacity, { weight: 1, exclusive: true, maxParallel: 1 });
  const policies = (channels) => channels.map((channel) => ({ channel, enabled: false, maxConcurrent: 1, weight: 1 }));
  assert.throws(() => parseChannelPolicies([...policies(["voice", "chat", "email", "whatsapp", "sms"]), { channel: "video", enabled: true, maxConcurrent: 2, weight: 1 }]), /Invalid channel policy/);
  assert.equal(parseChannelPolicies([...policies(["voice", "chat", "email", "whatsapp", "sms"]), { channel: "video", enabled: true, maxConcurrent: 1, weight: 1 }]).length, 6);
});

test("video work is routed, accepted, joined by both sides, ended by the agent and wrapped up", async () => {
  const rooms = fakeRooms(); newSession();
  const f = await fixture();
  assert.equal(f.ready.ready.video, true);
  const work = await f.create();
  assert.equal(work.channel, "video");
  const session = await readVideoSession(pool, work.id);
  assert.equal(session.state, "starting"); assert.equal(session.recording_layout, "pip");
  await assert.rejects(customerJoinToken(pool, { workItemId: work.id, rooms }), (error) => error.status === 409);
  const provisioned = await provisionVideoRoom(pool, { workItemId: work.id, rooms });
  assert.equal(provisioned.room_id, rooms.roomId()); assert.equal(provisioned.state, "waiting");
  assert.equal(rooms.calls[0][1].uniqueName, `cc-video-${work.id}`); assert.equal(rooms.calls[0][1].enableRecording, true);
  assert.equal((await provisionVideoRoom(pool, { workItemId: work.id, rooms })).room_id, rooms.roomId());
  const customer = await customerJoinToken(pool, { workItemId: work.id, rooms });
  assert.deepEqual(customer, { roomId: rooms.roomId(), token: `jwt-${rooms.roomId()}`, refreshToken: "refresh", expiresAt: null, refreshExpiresAt: null });

  const routed = await routeOne(pool, work.id);
  assert.equal(routed.routed, true); assert.equal(routed.agentId, f.agentId);
  const offered = (await readTextInteractions(pool, f.agentId)).interactions;
  assert.equal(offered.length, 1); assert.equal(offered[0].channel, "video"); assert.equal(offered[0].state, "ringing");
  await assert.rejects(agentJoinToken(pool, { workItemId: work.id, agentId: f.agentId, rooms }), (error) => error.status === 403);
  const pendingDetail = await readVideoDetail(pool, { workItemId: work.id, agentId: f.agentId });
  assert.ok(new Date(pendingDetail.offer.deadline_at).getTime() > Date.now());
  await actOnTextWork(pool, { workItemId: work.id, agentId: f.agentId, channel: "video", action: "accept",
    commandId: randomUUID(), expectedVersion: pendingDetail.work.version, offerId: pendingDetail.offer.id });
  assert.equal((await pool.query("SELECT state FROM acd_work_items WHERE id=$1", [work.id])).rows[0].state, "active");
  assert.equal((await agentJoinToken(pool, { workItemId: work.id, agentId: f.agentId, rooms })).roomId, rooms.roomId());
  const detail = await readVideoDetail(pool, { workItemId: work.id, agentId: f.agentId });
  assert.equal(detail.customerName, "Video visitor"); assert.equal(detail.video.roomId, rooms.roomId()); assert.equal(detail.assignmentState, "active");
  const widgetState = await readVideoWidgetState(pool, { id: randomUUID(), runtime_state: "active", conversation_id: work.conversation_id });
  assert.equal(widgetState.handoff.status, "connected"); assert.equal(widgetState.room.id, rooms.roomId());

  // Room webhooks: session, both participants, per-participant recordings.
  await applyVideoRoomEvent(pool, roomEvent("video.room.session.started", { room_id: rooms.roomId(), session_id: sessionId }), { rooms });
  await applyVideoRoomEvent(pool, roomEvent("video.room.participant.joined", { room_id: rooms.roomId(), session_id: sessionId, participant_id: "p-cust", context: JSON.stringify({ role: "customer", name: "Video visitor" }) }), { rooms });
  await applyVideoRoomEvent(pool, roomEvent("video.room.participant.joined", { room_id: rooms.roomId(), session_id: sessionId, participant_id: "p-agent", context: JSON.stringify({ role: "agent", name: "Agent" }) }), { rooms });
  for (const [participant, type, id] of [["p-cust", "video", "rec-cv"], ["p-cust", "audio", "rec-ca"], ["p-agent", "video", "rec-av"], ["p-agent", "audio", "rec-aa"]]) {
    await applyVideoRoomEvent(pool, roomEvent("video.room.recording.started", { room_id: rooms.roomId(), session_id: sessionId, participant_id: participant, recording_id: id, type }), { rooms });
  }
  const live = await readVideoSession(pool, work.id);
  assert.equal(live.state, "active"); assert.equal(live.room_session_id, sessionId);
  assert.equal(live.participants.length, 2); assert.equal(live.recordings.length, 4);

  // Agent ends the call: ACD wrap-up plus the room session is closed. The
  // visitor's client notices within milliseconds and leaves too; only one of
  // the two racing calls may ask Telnyx to end the session (the second gets
  // 422 "No private_ip for room" otherwise).
  const ended = await act(work, f.agentId, "disconnect");
  assert.equal(ended.ok, true);
  await Promise.all([
    endVideoRoom(pool, { workItemId: work.id, rooms, actor: f.agentId, reason: "agent_ended" }),
    endVideoRoom(pool, { workItemId: work.id, rooms, actor: "customer", reason: "customer_left" }),
  ]);
  assert.equal(rooms.calls.filter(([name, id]) => name === "endSession" && id === sessionId).length, 1, "the room session is ended once");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_events WHERE work_item_id=$1 AND type='video_room_ended'", [work.id])).rows[0].n, 1);
  assert.equal((await readAgentSnapshot(pool, f.agentId)).agent.status, "Wrapup");
  assert.equal((await readVideoWidgetState(pool, { id: randomUUID(), runtime_state: "active", conversation_id: work.conversation_id })).handoff.status, "disconnected");

  // Telnyx confirms the end and the recordings; the composition is requested once everything completed.
  await applyVideoRoomEvent(pool, roomEvent("video.room.session.ended", { room_id: rooms.roomId(), session_id: sessionId, ended_reason: "Ended from API", duration_secs: 60 }), { rooms });
  assert.ok(!rooms.calls.some(([name]) => name === "createComposition"));
  for (const [id, codec] of [["rec-ca", "opus"], ["rec-aa", "opus"], ["rec-cv", "vp8"]]) {
    await applyVideoRoomEvent(pool, roomEvent("video.room.recording.completed", { room_id: rooms.roomId(), session_id: sessionId, recording_id: id, codec, duration_secs: 60, size_mb: 1 }), { rooms });
  }
  assert.ok(!rooms.calls.some(([name]) => name === "createComposition"));
  await applyVideoRoomEvent(pool, roomEvent("video.room.recording.completed", { room_id: rooms.roomId(), session_id: sessionId, recording_id: "rec-av", codec: "vp8", duration_secs: 55, size_mb: 2 }), { rooms });
  const composition = rooms.calls.find(([name]) => name === "createComposition");
  assert.ok(composition, "composition requested after the last recording completed");
  assert.equal(composition[1].sessionId, sessionId); assert.equal(composition[1].layout, "pip");
  assert.equal(composition[1].main, "rec-cv"); assert.equal(composition[1].secondary, "rec-av");
  const afterRequest = await readVideoSession(pool, work.id);
  assert.equal(afterRequest.composition_id, rooms.compositionId()); assert.equal(afterRequest.composition_state, "enqueued");
  // A retried completion webhook must not request a second composition.
  await applyVideoRoomEvent(pool, roomEvent("video.room.recording.completed", { room_id: rooms.roomId(), session_id: sessionId, recording_id: "rec-av", codec: "vp8", duration_secs: 55, size_mb: 2 }), { rooms });
  assert.equal(rooms.calls.filter(([name]) => name === "createComposition").length, 1);

  const completedEvent = roomEvent("video.room.composition.completed", { composition_id: rooms.compositionId(), download_url: "https://s3.example/comp-1.mp4" });
  await applyVideoRoomEvent(pool, completedEvent, { rooms });
  await applyVideoRoomEvent(pool, completedEvent, { rooms });
  const recordings = (await pool.query("SELECT * FROM acd_recordings WHERE work_item_id=$1", [work.id])).rows;
  assert.equal(recordings.length, 1);
  assert.equal(recordings[0].provider, "telnyx_video"); assert.equal(recordings[0].provider_recording_id, rooms.compositionId());
  assert.equal(recordings[0].format, "mp4"); assert.equal(recordings[0].recording_url, videoRecordingStreamPath(rooms.compositionId()));
  assert.equal(recordings[0].provider_metadata.duration_secs, 42); assert.equal(recordings[0].provider_metadata.recordings.length, 4);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_events WHERE work_item_id=$1 AND type='recording_saved'", [work.id])).rows[0].n, 1);
  const history = (await pool.query("SELECT recording_url, metadata->'recording'->>'recording_id' AS recording_id FROM acd_history_interactions WHERE work_item_id=$1", [work.id])).rows[0];
  assert.equal(history.recording_url, videoRecordingStreamPath(rooms.compositionId())); assert.equal(history.recording_id, rooms.compositionId());

  await completeAcdWrapup(pool, { workItemId: work.id, expectedAgentId: f.agentId, wrapupCodeId: "resolved" });
  assert.equal((await pool.query("SELECT state FROM acd_work_items WHERE id=$1", [work.id])).rows[0].state, "completed");
  assert.equal((await readAgentSnapshot(pool, f.agentId)).agent.status, "Available");
  assert.deepEqual(await checkInvariants(pool), {});
});

test("a video call transfers to another agent inside the same room and the visitor sees the new agent", async () => {
  const rooms = fakeRooms();
  const source = await fixture(), target = await fixture();
  const work = await source.create();
  await provisionVideoRoom(pool, { workItemId: work.id, rooms });
  await routeOne(pool, work.id); await act(work, source.agentId, "accept");
  const targets = await messagingTransferTargets(pool, { workItemId: work.id, agentId: source.agentId, channel: "video" });
  assert.ok(targets.agents.some((agent) => agent.id === target.agentId));
  const version = (await pool.query("SELECT version FROM acd_work_items WHERE id=$1", [work.id])).rows[0].version;
  assert.deepEqual(await transferTextWork(pool, { workItemId: work.id, agentId: source.agentId, queueId: target.queueId, targetAgentId: target.agentId, expectedVersion: version, commandId: randomUUID(), channel: "video" }), { ok: true });
  const widget = { id: randomUUID(), runtime_state: "active", conversation_id: work.conversation_id };
  assert.equal((await readVideoWidgetState(pool, widget)).handoff.status, "assigned");
  assert.equal((await readVideoSession(pool, work.id)).room_id, rooms.roomId());
  await act(work, target.agentId, "accept");
  const state = await readVideoWidgetState(pool, widget);
  assert.equal(state.handoff.status, "connected"); assert.equal(state.room.id, rooms.roomId());
  assert.equal((await agentJoinToken(pool, { workItemId: work.id, agentId: target.agentId, rooms })).roomId, rooms.roomId());
  await assert.rejects(agentJoinToken(pool, { workItemId: work.id, agentId: source.agentId, rooms }), (error) => error.status === 403);
  // A refresh token the previous agent remembers is no key to the room either.
  assert.equal((await refreshJoinToken(pool, { workItemId: work.id, refreshToken: "refresh", agentId: target.agentId, rooms })).roomId, rooms.roomId());
  await assert.rejects(refreshJoinToken(pool, { workItemId: work.id, refreshToken: "refresh", agentId: source.agentId, rooms }), (error) => error.status === 403);
  await completeAcdWrapup(pool, { workItemId: work.id, expectedAgentId: source.agentId, wrapupCodeId: "resolved" });
  assert.equal(rooms.calls.filter(([name]) => name === "endSession").length, 0, "a transfer keeps the room session alive");
  assert.deepEqual(await checkInvariants(pool), {});
});

test("a visitor leaving the queue abandons the work item; the room end webhook is idempotent", async () => {
  const rooms = fakeRooms(); newSession();
  const f = await fixture();
  const work = await f.create();
  await provisionVideoRoom(pool, { workItemId: work.id, rooms });
  await applyVideoRoomEvent(pool, roomEvent("video.room.session.started", { room_id: rooms.roomId(), session_id: sessionId }), { rooms });
  await applyVideoRoomEvent(pool, roomEvent("video.room.session.ended", { room_id: rooms.roomId(), session_id: sessionId, ended_reason: "all participants left" }), { rooms });
  assert.equal((await pool.query("SELECT state FROM acd_work_items WHERE id=$1", [work.id])).rows[0].state, "abandoned");
  assert.equal((await pool.query("SELECT state FROM acd_conversations WHERE id=$1", [work.conversation_id])).rows[0].state, "closed");
  await applyVideoRoomEvent(pool, roomEvent("video.room.session.ended", { room_id: rooms.roomId(), session_id: sessionId }), { rooms });
  assert.equal((await readVideoSession(pool, work.id)).state, "ended");
  // The session already ended on the provider side: a late leave must not call the API again.
  await endVideoRoom(pool, { workItemId: work.id, rooms, actor: "customer", reason: "customer_left" });
  assert.equal(rooms.calls.filter(([name]) => name === "endSession").length, 0);
  // And a provider that answers "already gone" is not an error worth logging.
  const gone = fakeRooms(); const warned = [];
  const originalWarn = console.warn; console.warn = (...args) => warned.push(args.join(" "));
  try {
    gone.endSession = async () => { throw Object.assign(new Error("Telnyx video POST /room_sessions/x/actions/end failed (422): No private_ip for room"), { status: 502, providerStatus: 422 }); };
    await pool.query("UPDATE acd_video_sessions SET ended_at=NULL WHERE work_item_id=$1", [work.id]);
    await endVideoRoom(pool, { workItemId: work.id, rooms: gone, actor: "customer", reason: "customer_left" });
  } finally { console.warn = originalWarn; }
  assert.deepEqual(warned, []);
  assert.ok((await readVideoSession(pool, work.id)).ended_at);
  assert.deepEqual(await applyVideoRoomEvent(pool, roomEvent("video.room.session.ended", { room_id: "room-unknown" }), { rooms }), { handled: false, reason: "unknown_room" });
  assert.equal((await routeOne(pool, work.id)).routed, false);
  assert.deepEqual(await checkInvariants(pool), {});
});

test("an agent on a video call is not offered chat, and a chatting agent is not offered video", async () => {
  const video = await fixture(), chatQueueId = randomUUID();
  await seedQueue(pool, chatQueueId, [video.agentId]);
  await pool.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,2,0.33)", [video.agentId]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,2,0.33)", [chatQueueId]);
  await heartbeatAgentSession(pool, { agentId: video.agentId, sessionId: randomUUID(), ready: { video: true, chat: true } });
  const call = await video.create();
  await routeOne(pool, call.id); await act(call, video.agentId, "accept");
  const chat = await withTx((tx) => createChatWork(tx, { queueId: chatQueueId }));
  assert.equal((await routeOne(pool, chat.id)).routed, false, "exclusive video blocks chat offers");
  await act(call, video.agentId, "disconnect");
  await completeAcdWrapup(pool, { workItemId: call.id, expectedAgentId: video.agentId, wrapupCodeId: "resolved" });
  assert.equal((await routeOne(pool, chat.id)).routed, true);
  await actOnTextWork(pool, { workItemId: chat.id, agentId: video.agentId, commandId: randomUUID(), channel: "chat",
    expectedVersion: (await pool.query("SELECT version FROM acd_work_items WHERE id=$1", [chat.id])).rows[0].version, action: "accept",
    offerId: (await pool.query("SELECT id FROM acd_offers WHERE work_item_id=$1 ORDER BY generation DESC LIMIT 1", [chat.id])).rows[0].id });
  const second = await video.create();
  assert.equal((await routeOne(pool, second.id)).routed, false, "an active chat blocks the exclusive video offer");
  assert.deepEqual(await checkInvariants(pool), {});
});

test("an unanswered video offer releases the exclusive reservation and the work item is re-offered", async () => {
  const f = await fixture();
  await pool.query("UPDATE cc_queues SET agent_answer_timeout_secs=1 WHERE id=$1", [f.queueId]);
  const work = await f.create();
  const first = await routeOne(pool, work.id);
  assert.equal(first.routed, true);
  await pool.query("UPDATE acd_offers SET deadline_at=now()-interval '1 second' WHERE work_item_id=$1", [work.id]);
  await pool.query("UPDATE acd_sagas SET deadline_at=now()-interval '1 second' WHERE work_item_id=$1", [work.id]);
  await sweepDueSagas(pool, { provider: NATIVE_TEXT_PROVIDER });
  assert.equal((await pool.query("SELECT state FROM acd_offers WHERE work_item_id=$1", [work.id])).rows[0].state, "no_answer");
  assert.equal((await pool.query("SELECT state FROM acd_work_items WHERE id=$1", [work.id])).rows[0].state, "queued");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_reservations WHERE agent_id=$1 AND state<>'released'", [f.agentId])).rows[0].n, 0, "the video reservation is released on timeout");
  assert.equal((await pool.query("SELECT workflow_state FROM acd_agent_state WHERE agent_id=$1", [f.agentId])).rows[0].workflow_state, "idle");
  // Like chat, an agent who just let an offer expire is skipped for 30 seconds.
  assert.equal((await routeOne(pool, work.id)).routed, false);
  await pool.query("UPDATE acd_offers SET terminal_at=now()-interval '31 seconds' WHERE work_item_id=$1", [work.id]);
  const second = await routeOne(pool, work.id);
  assert.equal(second.routed, true, "the same agent can be offered the call again");
  assert.deepEqual(await checkInvariants(pool), {});
});

test("a supervisor monitors, whispers and barges into a video call; leaving the room ends the supervision", async () => {
  const rooms = fakeRooms(); newSession();
  const f = await fixture();
  const work = await f.create();
  await provisionVideoRoom(pool, { workItemId: work.id, rooms });
  assert.equal((await routeOne(pool, work.id)).routed, true);
  await act(work, f.agentId, "accept");
  // Not active until the agent is in the room.
  await assert.rejects(startVideoSupervision(pool, { workItemId: work.id, supervisorId: "sup-1", name: "Sam", mode: "monitor", rooms }), (error) => error.status === 409);
  await applyVideoRoomEvent(pool, roomEvent("video.room.session.started", { room_id: rooms.roomId(), session_id: sessionId }), { rooms });
  await applyVideoRoomEvent(pool, roomEvent("video.room.participant.joined", { room_id: rooms.roomId(), session_id: sessionId, participant_id: "p-agent", context: JSON.stringify({ role: "agent", name: "Agent" }) }), { rooms });
  await assert.rejects(startVideoSupervision(pool, { workItemId: work.id, supervisorId: "sup-1", mode: "listen", rooms }), (error) => error.status === 400);
  const join = await startVideoSupervision(pool, { workItemId: work.id, supervisorId: "sup-1", name: "Sam", mode: "monitor", rooms });
  assert.equal(join.roomId, rooms.roomId()); assert.equal(join.context.role, "supervisor"); assert.equal(join.context.name, "Sam"); assert.equal(join.context.mode, "monitor"); assert.ok(join.context.supervisionId);
  assert.equal((await readVideoSession(pool, work.id)).supervision.mode, "monitor");
  assert.equal((await readVideoDetail(pool, { workItemId: work.id, agentId: f.agentId })).video.supervision.mode, "monitor");
  const widget = { id: randomUUID(), runtime_state: "active", conversation_id: work.conversation_id };
  assert.deepEqual((await readVideoWidgetState(pool, widget)).supervision, { mode: "monitor", name: null }, "the visitor learns the mode but not who monitors");
  // A second supervisor is refused; the first one switches modes and refreshes tokens.
  await assert.rejects(startVideoSupervision(pool, { workItemId: work.id, supervisorId: "sup-2", mode: "monitor", rooms }), (error) => error.status === 409);
  await assert.rejects(setVideoSupervisionMode(pool, { workItemId: work.id, supervisorId: "sup-2", mode: "barge" }), (error) => error.status === 409);
  assert.equal((await setVideoSupervisionMode(pool, { workItemId: work.id, supervisorId: "sup-1", mode: "barge" })).mode, "barge");
  // A mode change races with a re-claim: the write is conditioned on the seat read, so the loser gets 409.
  const racing = { query: async (text, params) => { if (/^UPDATE acd_video_sessions SET supervision=\$2::jsonb/.test(text) && /supervision->>'id'/.test(text)) params = [params[0], params[1], "someone-else", params[3]]; return pool.query(text, params); } };
  await assert.rejects(setVideoSupervisionMode(racing, { workItemId: work.id, supervisorId: "sup-1", mode: "whisper" }), (error) => error.status === 409);
  assert.equal((await readVideoSession(pool, work.id)).supervision.mode, "barge");
  assert.deepEqual((await readVideoWidgetState(pool, widget)).supervision, { mode: "barge", name: "Sam" });
  assert.equal((await refreshJoinToken(pool, { workItemId: work.id, refreshToken: "refresh", supervisorId: "sup-1", rooms })).roomId, rooms.roomId());
  await assert.rejects(refreshJoinToken(pool, { workItemId: work.id, refreshToken: "refresh", supervisorId: "sup-2", rooms }), (error) => error.status === 403);
  // A late "left" webhook of an earlier supervision does not clear the current one; the current one's does.
  await applyVideoRoomEvent(pool, roomEvent("video.room.participant.joined", { room_id: rooms.roomId(), session_id: sessionId, participant_id: "p-sup", context: JSON.stringify(join.context) }), { rooms });
  await applyVideoRoomEvent(pool, roomEvent("video.room.participant.left", { room_id: rooms.roomId(), session_id: sessionId, participant_id: "p-old", context: JSON.stringify({ ...join.context, supervisionId: "stale" }), left_reason: "left" }), { rooms });
  assert.equal((await readVideoSession(pool, work.id)).supervision.mode, "barge", "a stale supervisor's webhook is ignored");
  await applyVideoRoomEvent(pool, roomEvent("video.room.participant.left", { room_id: rooms.roomId(), session_id: sessionId, participant_id: "p-sup", context: JSON.stringify(join.context), left_reason: "left" }), { rooms });
  assert.equal((await readVideoSession(pool, work.id)).supervision, null);
  assert.equal(await endVideoSupervision(pool, { workItemId: work.id, supervisorId: "sup-1" }), null);
  // An "end" from an older tab (another supervision id) leaves the current seat alone.
  const again = await startVideoSupervision(pool, { workItemId: work.id, supervisorId: "sup-1", name: "Sam", mode: "monitor", rooms });
  assert.equal(await endVideoSupervision(pool, { workItemId: work.id, supervisorId: "sup-1", supervisionId: "older-tab" }), null);
  await assert.rejects(setVideoSupervisionMode(pool, { workItemId: work.id, supervisorId: "sup-1", supervisionId: "older-tab", mode: "whisper" }), (error) => error.status === 409);
  assert.equal((await readVideoSession(pool, work.id)).supervision.id, again.context.supervisionId);
  assert.equal((await endVideoSupervision(pool, { workItemId: work.id, supervisorId: "sup-1", supervisionId: again.context.supervisionId })).mode, "monitor");
  assert.equal((await readVideoSession(pool, work.id)).supervision, null);
  const events = (await pool.query("SELECT type FROM acd_events WHERE work_item_id=$1 AND type LIKE 'video_supervision_%' ORDER BY occurred_at", [work.id])).rows.map((row) => row.type);
  assert.deepEqual(events, ["video_supervision_started", "video_supervision_mode", "video_supervision_ended", "video_supervision_started", "video_supervision_ended"]);
  assert.equal((await readVideoSession(pool, work.id)).participants.find((p) => p.participant_id === "p-sup").role, "supervisor");
  // Two supervisors racing for the seat: exactly one wins; a token failure leaves no phantom seat.
  const race = await Promise.allSettled([
    startVideoSupervision(pool, { workItemId: work.id, supervisorId: "sup-3", mode: "monitor", rooms }),
    startVideoSupervision(pool, { workItemId: work.id, supervisorId: "sup-4", mode: "monitor", rooms }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const winner = race.find((r) => r.status === "fulfilled").value.supervision.supervisorId;
  await endVideoSupervision(pool, { workItemId: work.id, supervisorId: winner });
  const broken = { ...rooms, generateJoinToken: async () => { throw Object.assign(new Error("provider down"), { status: 502 }); } };
  await assert.rejects(startVideoSupervision(pool, { workItemId: work.id, supervisorId: "sup-5", mode: "monitor", rooms: broken }), /provider down/);
  assert.equal((await readVideoSession(pool, work.id)).supervision, null);
  assert.deepEqual(await checkInvariants(pool), {});
});

test("active video calls are supervisable in the live feed; voice still needs a leg", () => {
  assert.equal(interactionCapabilities({ channel: "video", state: "active", conversationId: "c" }).supervision, true);
  assert.equal(interactionCapabilities({ channel: "video", state: "queued", conversationId: "c" }).supervision, false);
  assert.equal(interactionCapabilities({ channel: "voice", state: "active" }).supervision, false);
  assert.equal(interactionCapabilities({ channel: "voice", state: "active", agentCallControlId: "leg" }).supervision, true);
});

test('mobile screen capability is signed, assignment-bound, expiring and revoked when its assignment ends', async () => {
 const previous=process.env.NEXTAUTH_SECRET;process.env.NEXTAUTH_SECRET='screen-test-signing-secret';
 try {
  const f=await fixture(), rooms=fakeRooms();const work=await f.create();
  await provisionVideoRoom(pool,{workItemId:work.id,rooms});await routeOne(pool,work.id);
  const codeId=randomUUID();
  await pool.query("INSERT INTO cc_wrapup_codes(id,name,icon,color) VALUES($1,'Resolved','IconCircleCheck','#00E5AA')",[codeId]);
  await pool.query("INSERT INTO cc_queue_wrapup_codes(queue_id,wrapup_code_id) VALUES($1,$2)",[f.queueId,codeId]);
  const offered=await readVideoDetail(pool,{workItemId:work.id,agentId:f.agentId});
  assert.deepEqual(offered.wrapupCodes,[{id:codeId,name:'Resolved',icon:'IconCircleCheck',color:'#00E5AA'}]);
  assert.ok(offered.offer.id);assert.ok(Array.isArray(offered.wrapupCodes));
  await assert.rejects(createMobileScreenGrant(pool,{workItemId:work.id,agentId:f.agentId,rooms}),e=>e.status===403);
  await act(work,f.agentId,'accept');
  const result=await createMobileScreenGrant(pool,{workItemId:work.id,agentId:f.agentId,rooms});
  const claims=await validateMobileScreenGrant(pool,result.screenCapability);
  assert.equal(claims.agentId,f.agentId);assert.equal(claims.roomId,rooms.roomId());
  assert.throws(()=>verifyScreenGrant(result.screenCapability+'x'),e=>e.status===403);
  assert.throws(()=>verifyScreenGrant(signScreenGrant(claims,Date.now()-3700000)),e=>e.status===403);
  const refreshed=await refreshMobileScreenGrant(pool,{capability:result.screenCapability,refreshToken:result.join.refreshToken},rooms);
  assert.equal(refreshed.token,'jwt-2');
  await pool.query("UPDATE acd_text_assignments SET state='wrapup' WHERE segment_id=$1",[claims.assignmentId]);
  await assert.rejects(validateMobileScreenGrant(pool,result.screenCapability),e=>e.status===403);
  await assert.rejects(refreshMobileScreenGrant(pool,{capability:result.screenCapability,refreshToken:'refresh'},rooms),e=>e.status===403);
 } finally { if(previous===undefined)delete process.env.NEXTAUTH_SECRET;else process.env.NEXTAUTH_SECRET=previous; }
});

test('registered video alerts extend mobile presence without extending the SIP lease', async () => {
 const f=await fixture(); const id=randomUUID(), device=randomUUID();
 await pool.query("UPDATE users SET refresh_tokens=$2 WHERE id=$1",[f.agentId,JSON.stringify([{sessionId:'mobile-video'}])]);
 await pool.query("INSERT INTO cc_mobile_devices(device_id,user_id,alert_token,auth_session_id,kind,bundle_identifier,environment) VALUES($1,$2,'alert','mobile-video','ios','test.video','development')",[device,f.agentId]);
 const endpoint=(await pool.query(`INSERT INTO cc_voice_endpoints(id,agent_id,auth_session_id,device_id,kind,label,secret_hash)
 VALUES($1,$2,'mobile-video',$3,'ios','iPhone','hash') RETURNING *`,[id,f.agentId,device])).rows[0];
 const result=await heartbeatAgentSession(pool,{agentId:f.agentId,sessionId:id,deviceId:device,voiceEndpoint:endpoint,ready:{video:true},videoPushReady:true});
 assert.equal(result.expiresInSeconds,3600);assert.equal(result.ready.video,true);
 const voice=(await pool.query('SELECT expires_at FROM cc_voice_endpoints WHERE id=$1',[id])).rows[0];
 assert.ok(new Date(voice.expires_at)-Date.now()<60000);
 await pool.query("UPDATE users SET refresh_tokens='[]' WHERE id=$1",[f.agentId]);
 const withdrawn=await heartbeatAgentSession(pool,{agentId:f.agentId,sessionId:id,deviceId:device,voiceEndpoint:endpoint,ready:{video:true},videoPushReady:true});
 assert.equal(withdrawn.expiresInSeconds,45);
});
