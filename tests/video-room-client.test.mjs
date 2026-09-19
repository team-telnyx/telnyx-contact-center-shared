import { test } from "node:test";
import assert from "node:assert/strict";
import { joinVideoRoom } from "../lib/video/room-client.mjs";

// A stand-in for @telnyx/video that behaves like the real SDK where it
// matters here: removing a participant keeps their streams and subscriptions,
// and touching the subscription of such a stream throws.
function fakeSdk() {
  const handlers = new Map();
  const state = { status: "connected", localParticipantId: "me", participants: new Map(), streams: new Map(), subscriptions: new Map(), mixedAudioTrack: null };
  const calls = [];
  const emit = (name, ...args) => (handlers.get(name) || []).forEach((handler) => handler(...args));
  const addParticipant = (id, context) => state.participants.set(id, { id, context: JSON.stringify(context), streams: {} });
  let sequence = 0;
  // Every publication gets a fresh stream id, as in the SDK.
  const publish = (participantId, key = "self") => { const id = `${participantId}:${key}:${++sequence}`; state.streams.set(id, { id, key, participantId, origin: "remote", videoTrack: { readyState: "live" }, audioTrack: { readyState: "live" }, isVideoEnabled: true, isAudioEnabled: true }); emit("stream_published", participantId, key); };
  const room = {
    getState: () => state,
    on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); return () => handlers.set(name, (handlers.get(name) || []).filter((item) => item !== handler)); },
    async connect() {},
    async disconnect() {},
    getParticipantStream: (participantId, key) => [...state.streams.values()].filter((stream) => stream.participantId === participantId && stream.key === key).at(-1),
    async addSubscription(participantId, key) {
      calls.push(["add", participantId, key]);
      if (!state.participants.get(participantId)) throw new Error(`No stream registered with the id: ${participantId}:${key}`);
      if (!state.subscriptions.get(participantId)) state.subscriptions.set(participantId, new Map());
      state.subscriptions.get(participantId).set(key, { participantId, key });
      emit("subscription_started", participantId, key);
    },
    async removeSubscription(participantId, key) {
      calls.push(["remove", participantId, key]);
      if (!state.participants.get(participantId)) throw new Error(`No stream registered with the id: ${participantId}:${key}`);
      state.subscriptions.get(participantId)?.delete(key);
      emit("subscription_ended", participantId, key);
    },
    async sendMessage() {}, async addStream() {}, async updateStream() {}, async removeStream() {}, updateClientToken() {},
  };
  // Like the SDK: the participant goes, streams and subscriptions stay.
  const leave = (id) => { state.participants.delete(id); emit("participant_left", id); };
  return { sdk: { initialize: async () => room }, state, calls, addParticipant, publish, leave, emit };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("a participant who left disappears from the view even though the SDK keeps their stream", async () => {
  const fake = fakeSdk(); const snapshots = [];
  fake.addParticipant("me", { role: "customer", name: "Visitor" });
  fake.addParticipant("agent-1", { role: "agent", name: "Agent" });
  fake.publish("agent-1");
  let mode = "barge";
  const controller = await joinVideoRoom({ roomId: "r", token: "t", sdk: fake.sdk, onChange: (s) => snapshots.push(s),
    shouldSubscribe: ({ role }) => role !== "supervisor" || mode === "barge" });
  fake.addParticipant("sup-1", { role: "supervisor", name: "John Wick", mode: "barge" });
  fake.emit("participant_joined", "sup-1"); fake.publish("sup-1");
  await flush();
  assert.deepEqual(snapshots.at(-1).remote.map((r) => r.role).sort(), ["agent", "supervisor"]);
  // The supervisor leaves while barging: no black frame is left behind, no error surfaces.
  fake.leave("sup-1"); await flush();
  assert.deepEqual(snapshots.at(-1).remote.map((r) => r.role), ["agent"]);
  assert.ok([...fake.state.streams.values()].some((stream) => stream.participantId === "sup-1"), "the SDK still holds the stale stream");
  // The server says supervision ended: re-evaluating subscriptions must not touch the stale stream.
  mode = null; const before = fake.calls.length;
  await controller.applySubscriptions(); await flush();
  assert.equal(fake.calls.slice(before).some(([, id]) => id === "sup-1"), false);
  assert.equal(snapshots.at(-1).error, null);
  // The agent transfers away and another agent joins: the old agent's stream is gone, the new one shows.
  fake.leave("agent-1"); fake.addParticipant("agent-2", { role: "agent", name: "Second" }); fake.emit("participant_joined", "agent-2"); fake.publish("agent-2");
  await flush();
  assert.deepEqual(snapshots.at(-1).remote.map((r) => r.name), ["Second"]);
  assert.equal(snapshots.some((s) => s.error), false);
  // The same participant id joining again: the old stream object stays hidden until a new one is published.
  fake.addParticipant("sup-1", { role: "supervisor", name: "John Wick", mode: "barge" }); mode = "barge";
  fake.emit("participant_joined", "sup-1"); await flush();
  assert.equal(snapshots.at(-1).remote.some((r) => r.role === "supervisor"), false, "no black frame from the old stream on rejoin");
  fake.publish("sup-1"); await flush();
  assert.equal(snapshots.at(-1).remote.filter((r) => r.role === "supervisor").length, 1, "the new publication is live");
  fake.leave("sup-1"); await flush();
  // A stream unpublished while its subscription change was in flight (a screen share that stopped) is an expected race.
  fake.addParticipant("agent-4", { role: "agent", name: "Fourth" });
  fake.state.streams.set("agent-4:screen:y", { id: "agent-4:screen:y", key: "screen", participantId: "agent-4", origin: "remote", videoTrack: { readyState: "live" }, audioTrack: null, isVideoEnabled: true, isAudioEnabled: false });
  const liveRoom = await fake.sdk.initialize(); const realAdd = liveRoom.addSubscription;
  liveRoom.addSubscription = async (participantId, key) => { if (key === "screen") { fake.state.streams.delete("agent-4:screen:y"); throw new Error("No stream registered with the id: agent-4:screen:y"); } return realAdd(participantId, key); };
  const errorsBefore = snapshots.filter((s) => s.error).length;
  await controller.applySubscriptions(); await flush();
  assert.equal(snapshots.filter((s) => s.error).length, errorsBefore, "an unpublish race is not an error");
  liveRoom.addSubscription = realAdd;
  // The same SDK message about someone still in the room is a real failure and is shown.
  fake.addParticipant("agent-3", { role: "agent", name: "Third" });
  fake.state.streams.set("agent-3:self:x", { id: "agent-3:self:x", key: "self", participantId: "agent-3", origin: "remote", videoTrack: { readyState: "live" }, audioTrack: { readyState: "live" }, isVideoEnabled: true, isAudioEnabled: true });
  const original = fake.sdk.initialize;
  const room = await original();
  const add = room.addSubscription;
  room.addSubscription = async () => { throw new Error("Invalid state update!"); };
  await controller.applySubscriptions(); await flush();
  assert.match(String(snapshots.at(-1).error?.message || snapshots.findLast((s) => s.error)?.error?.message), /Invalid state update/);
  room.addSubscription = add;
  await controller.leave();
});

test("a supervisor who steps back to monitor leaves the view; stale-stream errors from the SDK are not shown", async () => {
  const fake = fakeSdk(); const snapshots = [];
  fake.addParticipant("me", { role: "agent", name: "Agent" });
  fake.addParticipant("sup-1", { role: "supervisor", name: "Sam", mode: "barge" });
  fake.publish("sup-1");
  let mode = "barge";
  const controller = await joinVideoRoom({ roomId: "r", token: "t", sdk: fake.sdk, onChange: (s) => snapshots.push(s),
    shouldSubscribe: ({ role }) => role !== "supervisor" || mode !== "monitor" });
  await flush();
  assert.equal(snapshots.at(-1).remote.length, 1);
  mode = "monitor"; await controller.applySubscriptions(); await flush();
  assert.equal(snapshots.at(-1).remote.length, 0);
  // A stream whose tracks have ended is treated as gone even without a leave event.
  mode = "barge"; await controller.applySubscriptions(); await flush();
  assert.equal(snapshots.at(-1).remote.length, 1);
  const stream = [...fake.state.streams.values()].find((item) => item.participantId === "sup-1"); stream.videoTrack.readyState = "ended"; stream.audioTrack.readyState = "ended";
  fake.emit("state_changed"); await flush();
  assert.equal(snapshots.at(-1).remote.length, 0);
  // Ended tracks do not exempt the stream from the policy: stepping back to monitor still unsubscribes,
  // so a microphone enabled later is not heard.
  assert.ok(fake.state.subscriptions.get("sup-1")?.get("self"), "still subscribed while barging");
  mode = "monitor"; await controller.applySubscriptions(); await flush();
  assert.equal(Boolean(fake.state.subscriptions.get("sup-1")?.get("self")), false, "unsubscribed in monitor despite ended tracks");
  stream.audioTrack.readyState = "live"; fake.emit("track_enabled", "sup-1", "self", "audio"); await flush();
  assert.equal(Boolean(fake.state.subscriptions.get("sup-1")?.get("self")), false, "a re-enabled track stays unsubscribed in monitor");
  assert.equal(snapshots.some((s) => s.error), false);
  await controller.leave();
});
