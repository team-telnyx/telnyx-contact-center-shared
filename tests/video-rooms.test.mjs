import { test } from "node:test";
import assert from "node:assert/strict";
import { compositionLayout, createRoomsClient, VideoRoomsError } from "../lib/video/rooms.mjs";

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init.method, body, headers: init.headers });
    const result = await handler({ url: String(url), method: init.method, body });
    const status = result?.status || 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(result?.json ?? { data: {} }) };
  };
  return { fetchImpl, calls };
}

test("compositionLayout keeps two regions: customer main, agent picture-in-picture or side by side", () => {
  const pip = compositionLayout("pip", { main: "cust", secondary: "agent" });
  assert.deepEqual(Object.keys(pip), ["main", "pip"]);
  assert.equal(pip.main.width, 1280); assert.equal(pip.pip.width, 320); assert.equal(pip.pip.height, 180);
  assert.equal(pip.pip.x_pos, 1280 - 320 - 24); assert.equal(pip.pip.z_pos, 1);
  const split = compositionLayout("split", { main: "cust", secondary: "agent" });
  assert.deepEqual(split.left.video_sources, ["cust"]); assert.deepEqual(split.right.video_sources, ["agent"]);
  assert.equal(split.left.width + split.right.width, 1280);
  const single = compositionLayout("pip", { main: "cust" });
  assert.deepEqual(Object.keys(single), ["main"]);
  assert.throws(() => compositionLayout("pip", {}), (error) => error instanceof VideoRoomsError && error.status === 400);
});

test("rooms client sends the documented room, token and composition payloads with the API key server-side", async () => {
  const { fetchImpl, calls } = fakeFetch(({ url, body }) => {
    if (url.endsWith("/rooms")) return { json: { data: { id: "room-1", unique_name: body.unique_name, enable_recording: body.enable_recording } } };
    if (url.includes("/generate_join_client_token")) return { json: { data: { token: "jwt", refresh_token: "refresh", token_expires_at: "2026-09-17T20:00:00Z" } } };
    if (url.includes("/refresh_client_token")) return { json: { data: { token: "jwt2", token_expires_at: "2026-09-17T20:15:00Z" } } };
    if (url.endsWith("/room_compositions")) return { json: { data: { id: "comp-1", status: "enqueued", audio_sources: body.audio_sources } } };
    if (url.includes("/sess-ended/actions/end")) return { status: 422, json: { errors: [{ detail: "No private_ip for room" }] } };
    if (url.includes("/actions/end")) return { json: { data: { result: "ok" } } };
    return { status: 404, json: { errors: [{ detail: "not found" }] } };
  });
  const rooms = createRoomsClient({ apiKey: "KEY", fetchImpl });
  const room = await rooms.createRoom({ uniqueName: "cc-video-1", enableRecording: true, webhookUrl: "https://cc.example.com/api/video/webhook" });
  assert.equal(room.id, "room-1");
  assert.deepEqual(calls[0].body, { unique_name: "cc-video-1", max_participants: 4, enable_recording: true, webhook_event_url: "https://cc.example.com/api/video/webhook", webhook_timeout_secs: 20 });
  assert.equal(calls[0].headers.Authorization, "Bearer KEY");
  const join = await rooms.generateJoinToken("room-1");
  assert.deepEqual(join, { token: "jwt", refreshToken: "refresh", expiresAt: "2026-09-17T20:00:00Z", refreshExpiresAt: null });
  assert.deepEqual(calls[1].body, { token_ttl_secs: 900, refresh_token_ttl_secs: 3600 });
  const refreshed = await rooms.refreshJoinToken("room-1", "refresh");
  assert.equal(refreshed.token, "jwt2"); assert.equal(refreshed.refreshToken, "refresh");
  const composition = await rooms.createComposition({ sessionId: "sess-1", layout: "split", main: "cust", secondary: "agent" });
  assert.equal(composition.id, "comp-1");
  const request = calls.at(-1).body;
  assert.equal(request.session_id, "sess-1"); assert.equal(request.format, "mp4"); assert.equal(request.resolution, "1280x720");
  assert.deepEqual(request.audio_sources, ["*"]);
  assert.deepEqual(Object.keys(request.video_layout), ["left", "right"]);
  assert.deepEqual(await rooms.endSession("sess-1"), { result: "ok" });
  await assert.rejects(rooms.endSession("sess-ended"), (error) => error instanceof VideoRoomsError && error.status === 502 && error.providerStatus === 422 && /No private_ip for room/.test(error.message));
  await assert.rejects(rooms.getComposition("missing"), (error) => error instanceof VideoRoomsError && error.status === 404 && /not found/.test(error.message));
});

test("rooms client refuses to run without an API key", async () => {
  const rooms = createRoomsClient({ apiKey: "", fetchImpl: async () => { throw new Error("must not be called"); } });
  await assert.rejects(rooms.createRoom({ uniqueName: "x" }), (error) => error.status === 503);
});
