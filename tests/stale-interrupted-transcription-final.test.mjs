import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routerSource = readFileSync("lib/agent-assist-transcription-router.mjs", "utf8");

test("the canonical Agent Assist router does not infer transcript finality from speaker or call-leg switching", () => {
  assert.doesNotMatch(routerSource, /activeConversationTracks/);
  assert.doesNotMatch(routerSource, /closeInterruptedTranscription/);
  assert.doesNotMatch(routerSource, /isStaleInterruptedTranscriptionFinal/);
  assert.doesNotMatch(routerSource, /markConversationTranscriptionClosed/);
  assert.match(routerSource, /const isMessageFinal = isUtteranceFinal\(transcriptionData\)/);
  assert.match(routerSource, /isUtteranceFinal,\n  normalizeTranscriptionLeg/);
});
