import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routerSource = readFileSync("lib/agent-assist-transcription-router.mjs", "utf8");
const webhookHandlerSource = readFileSync("lib/contact-center/webhook-handler.js", "utf8");

test("agent assist router ignores stale finals after another speaker interrupted the bubble", () => {
  assert.match(routerSource, /function isStaleInterruptedTranscriptionFinal/);
  assert.match(routerSource, /current\.track === track/);
  assert.match(routerSource, /!activeTranscriptionMessages\.has\(liveKey\)/);
  assert.match(routerSource, /reason: "stale_interrupted_final"/);
  assert.ok(
    routerSource.indexOf("isStaleInterruptedTranscriptionFinal({ interaction, callControlId, track, isMessageFinal })") <
      routerSource.indexOf("await closeInterruptedTranscription({ interaction, callControlId, track })"),
  );
});

test("contact center webhook handler applies the same stale-final guard before closing interrupted bubbles", () => {
  assert.match(webhookHandlerSource, /function isStaleInterruptedTranscriptionFinal/);
  assert.match(webhookHandlerSource, /current\.track === track/);
  assert.match(webhookHandlerSource, /!activeTranscriptionMessages\.has\(liveKey\)/);
  assert.ok(
    webhookHandlerSource.lastIndexOf("isStaleInterruptedTranscriptionFinal({ interaction, callControlId, track, isMessageFinal })") <
      webhookHandlerSource.lastIndexOf("await closeInterruptedTranscription({ interaction, callControlId, track })"),
  );
});
