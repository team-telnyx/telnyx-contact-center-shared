import test from "node:test";
import assert from "node:assert/strict";
import { videoStartErrorMessage } from "../lib/video/start-error.mjs";
import { shouldStartVideoAiService } from "../lib/runtime/video-ai-service.mjs";

test("video startup distinguishes service, network and media failures", () => {
  const copy = { media: "Check camera access", generic: "Please reconnect" };
  assert.equal(videoStartErrorMessage({ status: 503, message: "AI service unavailable" }, copy), "AI service unavailable");
  assert.equal(videoStartErrorMessage({ name: "NotAllowedError" }, copy), copy.media);
  assert.equal(videoStartErrorMessage(new TypeError("Failed to fetch"), copy), copy.generic);
  assert.equal(videoStartErrorMessage(new Error("ICE failed"), copy), copy.generic);
});

test("Video AI is integrated by default in development and production worker roles", () => {
  for (const NODE_ENV of ["production", "development"]) {
    assert.equal(shouldStartVideoAiService({ NODE_ENV }), true);
    assert.equal(shouldStartVideoAiService({ NODE_ENV, PROCESS_ROLE: "worker" }), true);
    assert.equal(shouldStartVideoAiService({ NODE_ENV, PROCESS_ROLE: "web" }), false);
    assert.equal(shouldStartVideoAiService({ NODE_ENV, PROCESS_ROLE: "streaming" }), false);
    assert.equal(shouldStartVideoAiService({ NODE_ENV, VIDEO_AI_EXTERNAL_WORKER: "true" }), false);
    assert.equal(shouldStartVideoAiService({ NODE_ENV, VIDEO_CONFERENCE_AI_ENABLED: "false" }), false);
  }
});
