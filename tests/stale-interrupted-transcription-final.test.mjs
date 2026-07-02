import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routerSource = readFileSync("lib/agent-assist-transcription-router.mjs", "utf8");
const webhookHandlerSource = readFileSync("lib/contact-center/webhook-handler.js", "utf8");

for (const [name, source] of [
  ["agent assist router", routerSource],
  ["contact center webhook handler", webhookHandlerSource],
]) {
  test(`${name} does not infer transcript finality from speaker/call-leg switching`, () => {
    assert.doesNotMatch(source, /activeConversationTracks/);
    assert.doesNotMatch(source, /closeInterruptedTranscription/);
    assert.doesNotMatch(source, /isStaleInterruptedTranscriptionFinal/);
    assert.doesNotMatch(source, /markConversationTranscriptionClosed/);
    assert.match(source, /const isMessageFinal = hasSpeechFinal[\s\S]*\? transcriptionData\.speech_final === true[\s\S]*: isProviderFinal/);
  });
}
