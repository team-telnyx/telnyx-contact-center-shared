import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseVisionSource, sourceKey, visionImageFrame } from "../lib/video/vision-policy.mjs";
import { DEFAULT_VIDEO_AI, videoAiSchema, validateVideoConferenceConfig } from "../lib/video/conference-config.mjs";
import { validateAvatarImage, listTelnyxAvatars } from "../lib/ai/telnyx-avatars.mjs";
import { readFile } from "node:fs/promises";
import { hasJoinedConferenceAgent } from "../lib/video/conference-presence.mjs";

test("agent-join policy requires a bound agent actually present in the room", () => {
  const member = {id:"admission", role:"agent", participant_id:"agent-peer"};
  const participant = {participantId:"agent-peer", admissionId:"admission", self:false};
  assert.equal(hasJoinedConferenceAgent([member]), false, "acceptance without room presence leaves AI active");
  assert.equal(hasJoinedConferenceAgent([{...member, participant_id:null}], [participant]), false, "an unused join token is insufficient");
  assert.equal(hasJoinedConferenceAgent([member], [{...participant, admissionId:"forged"}]), false);
  assert.equal(hasJoinedConferenceAgent([{...member, role:"customer"}], [participant]), false);
  assert.equal(hasJoinedConferenceAgent([member], [{...participant, self:true}]), false);
  assert.equal(hasJoinedConferenceAgent([member], [participant]), true, "camera-off agents still count once joined and bound");
  assert.equal(hasJoinedConferenceAgent([], [participant]), false, "a revoked agent is not admitted");
});

const config = { ...DEFAULT_VIDEO_AI.vision, mode: "live" };
const source = (role, kind = "camera", generation = 1) => ({ participantId: role + "-id", streamKey: kind === "camera" ? "self" : "screen", generation, role, type: `${role}-${kind}`, available: true, consented: true });
test("automatic Vision uses authorized screens, preserves a chosen screen and never guesses between two screens", () => {
  const customer = source("customer"), agent = source("agent"), cScreen = source("customer", "screen"), aScreen = source("agent", "screen");
  assert.equal(chooseVisionSource({ sources: [customer, agent], config }), customer);
  assert.equal(chooseVisionSource({ sources: [customer, cScreen], config }), cScreen);
  assert.equal(chooseVisionSource({ sources: [customer, cScreen, aScreen], config }), null);
  assert.equal(chooseVisionSource({ sources: [customer, cScreen, aScreen], config, current: cScreen }), cScreen);
  assert.equal(chooseVisionSource({ sources: [customer, aScreen], config, current: cScreen }), aScreen);
  assert.equal(chooseVisionSource({ sources: [customer], config, current: cScreen }), customer);
});
test("manual pins pause on source loss, revoke, replacement or transfer without selecting another person", () => {
  const customer = source("customer"), agent = source("agent"); const pinned = sourceKey(customer);
  for (const sources of [[agent], [{ ...customer, consented: false }, agent], [{ ...customer, available: false }, agent], [source("customer", "camera", 2), agent]])
    assert.equal(chooseVisionSource({ sources, config: { ...config, selection: "manual" }, pinned }), null);
  assert.equal(chooseVisionSource({ sources: [customer, agent], config: { ...config, selection: "manual" }, pinned }), customer);
});
test("disabled, upload-only and disallowed Vision sources never produce a live selection", () => {
  for (const mode of ["disabled", "uploads"]) assert.equal(chooseVisionSource({ sources: [source("customer")], config: { ...config, mode } }), null);
  assert.equal(chooseVisionSource({ sources: [source("agent", "screen")], config: { ...config, allowedSources: ["customer-camera"] } }), null);
  assert.equal(chooseVisionSource({ sources: [source("ai")], config }), null);
});
test("Vision wire frames contain only images and respect the complete JSON message limit", () => {
  const frame = visionImageFrame("data:image/jpeg;base64,YQ==");
  assert.equal(frame.item.buffer, true); assert.equal(frame.item.content[0].type, "input_image");
  assert.throws(() => visionImageFrame("https://attacker.invalid/image"), /Invalid/);
  assert.throws(() => visionImageFrame("data:image/svg+xml;base64,YQ=="), /Invalid/);
  assert.throws(() => visionImageFrame("data:image/jpeg;base64," + "A".repeat(1024 * 1024)), /1 MiB/);
});
test("conference defaults preserve queue routing and require an explicit video assistant", () => {
  const ai = videoAiSchema.parse({}); assert.equal(ai.afterAgentJoins, "muted"); assert.equal(ai.vision.mode, "disabled"); assert.equal(ai.vision.preferredCamera, "customer-camera");
  assert.throws(() => validateVideoConferenceConfig({ enabled: true, routing: { destination: "assistant", queueId: "q" }, ai }), /Select a video AI assistant/);
  assert.throws(() => validateVideoConferenceConfig({ enabled: true, routing: { destination: "agent", queueId: "q" }, ai }), /destination agent/);
});
test("avatar uploads validate actual bytes, dimensions, limits and name", async () => {
  const image = await readFile(new URL("../public/images/avatars/telnyx/elena.png", import.meta.url));
  assert.equal(validateAvatarImage(image, "Fixture").mime, "image/png");
  assert.throws(() => validateAvatarImage(Buffer.from("not an image"), "Fixture"), /valid JPEG/);
  assert.throws(() => validateAvatarImage(image, " "), /name/);
  assert.throws(() => validateAvatarImage(Buffer.alloc(10 * 1024 * 1024 + 1), "Fixture"), /10 MiB/);
});
test("avatar catalog follows provider pagination and retains dynamic IDs and custom ownership metadata", async () => {
  const pages = [];
  const entries = await listTelnyxAvatars({ request: async path => { pages.push(path); const n = pages.length;
    return { data: [{ id: n === 1 ? "new-stock-person" : "avatar_custom", name: "Person", avatar_type: n === 1 ? "stock" : "custom", image_url: "https://example.test/preview" }], meta: { total_pages: 2 } }; } });
  assert.equal(pages.length, 2); assert.equal(entries[1].type, "custom"); assert.equal(entries[0].id, "new-stock-person");
});
