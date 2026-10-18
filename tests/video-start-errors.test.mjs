import test from "node:test";
import assert from "node:assert/strict";
import { videoStartErrorMessage } from "../lib/video/start-error.mjs";
import { shouldStartLocalVideoAiService } from "../lib/runtime/video-ai-service.mjs";

test("video startup distinguishes service, network and media failures", () => {
  const copy = { media: "Check camera access", generic: "Please reconnect" };
  assert.equal(videoStartErrorMessage({ status: 503, message: "AI service unavailable" }, copy), "AI service unavailable");
  assert.equal(videoStartErrorMessage({ name: "NotAllowedError" }, copy), copy.media);
  assert.equal(videoStartErrorMessage(new TypeError("Failed to fetch"), copy), copy.generic);
  assert.equal(videoStartErrorMessage(new Error("ICE failed"), copy), copy.generic);
});

test("local production builds require explicit media-worker opt-in", () => {
  assert.equal(shouldStartLocalVideoAiService({ NODE_ENV: "production" }), false);
  assert.equal(shouldStartLocalVideoAiService({ NODE_ENV: "production", VIDEO_AI_LOCAL_WORKER: "true" }), true);
  assert.equal(shouldStartLocalVideoAiService({ NODE_ENV: "development" }), true);
  for (const NODE_ENV of ["production", "development"]) {
    assert.equal(shouldStartLocalVideoAiService({ NODE_ENV, VIDEO_AI_LOCAL_WORKER: "true", VIDEO_AI_EXTERNAL_WORKER: "true" }), false);
    assert.equal(shouldStartLocalVideoAiService({ NODE_ENV, VIDEO_AI_LOCAL_WORKER: "true", VIDEO_CONFERENCE_AI_ENABLED: "false" }), false);
  }
});
