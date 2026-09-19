import assert from "node:assert/strict";
import test from "node:test";

import {
  getTranscriptionMessageKey,
  isUtteranceFinal,
  resetTranscriptionMessageKeys,
} from "../lib/agent-assist/transcription-turns.mjs";

// an earlier fix: the standalone-STT websocket router and the call.transcription
// webhook both key transcript bubbles through the same activeTranscriptionMessages
// map. PR #1273 changed only the webhook's finality rule, so the two paths
// disagreed and the same utterance was rendered twice.

test("speech_final is the utterance boundary; is_final is only the fallback", () => {
  // Provider sends both: speech_final decides.
  assert.equal(isUtteranceFinal({ speech_final: true, is_final: true }), true);
  assert.equal(isUtteranceFinal({ speech_final: false, is_final: true }), false);

  // The case the webhook and router disagreed on: VAD utterance-end arriving
  // before the provider final. The router closed the bubble, the webhook did not.
  assert.equal(isUtteranceFinal({ speech_final: true, is_final: false }), true);

  // Provider omits speech_final entirely: fall back to is_final.
  assert.equal(isUtteranceFinal({ is_final: true }), true);
  assert.equal(isUtteranceFinal({ is_final: false }), false);

  assert.equal(isUtteranceFinal({}), false);
  assert.equal(isUtteranceFinal(null), false);
  assert.equal(isUtteranceFinal(undefined), false);
});

test("both transcript paths agree on finality, so one utterance keeps one bubble key", () => {
  resetTranscriptionMessageKeys();

  // The same STT event delivered to both paths. Under the divergent rules the
  // router finalized (rotating the shared key) while the webhook did not, so
  // the webhook minted a second UUID for the same utterance.
  const event = { speech_final: true, is_final: false };

  const routerKey = getTranscriptionMessageKey("call-1", "inbound", isUtteranceFinal(event));

  resetTranscriptionMessageKeys();
  const webhookKey = getTranscriptionMessageKey("call-1", "inbound", isUtteranceFinal(event));

  assert.equal(
    routerKey.split(":").slice(0, 2).join(":"),
    webhookKey.split(":").slice(0, 2).join(":"),
    "both paths must target the same live key",
  );
});

test("a rotated bubble key is what starts a second row, and both paths rotate together", () => {
  resetTranscriptionMessageKeys();

  // Interim: bubble opens and stays open on both paths.
  const interim = { speech_final: false, is_final: false };
  const openKey = getTranscriptionMessageKey("call-2", "inbound", isUtteranceFinal(interim));
  assert.equal(
    getTranscriptionMessageKey("call-2", "inbound", isUtteranceFinal(interim)),
    openKey,
    "an unfinished utterance must keep the same bubble",
  );

  // Final: the key rotates exactly once, so the next utterance is a new row and
  // the finished one is not re-rendered.
  const final = { speech_final: true, is_final: true };
  assert.equal(
    getTranscriptionMessageKey("call-2", "inbound", isUtteranceFinal(final)),
    openKey,
    "the finalizing event closes the bubble it belongs to",
  );

  const nextKey = getTranscriptionMessageKey("call-2", "inbound", isUtteranceFinal(interim));
  assert.notEqual(nextKey, openKey, "the next utterance starts a fresh bubble");
});
