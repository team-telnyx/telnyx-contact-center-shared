import test from "node:test";
import assert from "node:assert/strict";
import { waitForRoomPlayback } from "../lib/video/playback-gate.mjs";
import { TelnyxAvatarClient } from "../lib/ai/telnyx-avatar-client.mjs";

test("a disconnecting error listener cannot hide the original avatar startup failure", async () => {
  const client = new TelnyxAvatarClient();
  const failure = new Error("Conference playback failed");
  const started = new Promise((_, reject) => { client.rejectStart = reject; });
  client.on("agent.error", () => { void client.endConversation(); });
  client.fail(failure);
  await assert.rejects(started, error => error === failure);
});

test("greeting waits for publication and matching playback receipts from all recipients", async () => {
  const received = new Map([["customer", "stale"]]); const order = []; let probes = 0;
  await waitForRoomPlayback({ publish: async () => { await new Promise(resolve => setTimeout(resolve, 5)); order.push("published"); }, participants: () => ["customer", "agent"], received,
    send: async ({ nonce }, ids) => { assert.equal(order[0], "published"); assert.deepEqual(ids, ["customer", "agent"]); received.set("customer", nonce); if (++probes > 1) received.set("agent", nonce); } });
  assert.equal(probes, 2);
});
test("missing playback does not start a clipped greeting", async () => {
  await assert.rejects(waitForRoomPlayback({ publish: async () => {}, participants: () => ["customer"], received: new Map(), send: async () => {}, timeoutMs: 10 }), /audio playback was not ready/);
});
test("AI-first allows a delayed room admission before starting the playback timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const received = new Map(); let joined = false, completed = false, probes = 0;
  const pending = waitForRoomPlayback({ publish: async () => {}, participants: () => joined ? ["customer"] : [], received,
    send: async ({ nonce }) => { probes++; received.set("customer", nonce); } }).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(20000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false); assert.equal(probes, 0);
  joined = true;
  t.mock.timers.tick(100); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(100); await pending;
  assert.equal(probes, 1);
});
test("an empty room has a bounded admission timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const pending = assert.rejects(waitForRoomPlayback({ publish: async () => {}, participants: () => [], received: new Map(), send: async () => assert.fail("must not broadcast to an empty room") }), /audio playback was not ready/);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(45000); await pending;
});
test("avatar media acknowledgement follows downstream playback and is not sent after teardown", async () => {
  const client = new TelnyxAvatarClient(); const sent = [];
  client.pc = { connectionState: "connected" }; client.stream = { getTracks: () => [{ readyState: "live" }, { readyState: "live" }] };
  client.video = { play: async () => {}, readyState: 2 }; client.send = message => sent.push(message.type);
  let release; client.beforeMediaReady = () => new Promise(resolve => { release = resolve; });
  const pending = client.acknowledgeMedia(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, []); release(); await pending; assert.deepEqual(sent, ["avatar.media.ready"]);
  client.mediaReady = false;
  const stopped = client.acknowledgeMedia(); await new Promise(resolve => setImmediate(resolve));
  client.generation++; release(); await stopped; assert.equal(sent.length, 1);
});
