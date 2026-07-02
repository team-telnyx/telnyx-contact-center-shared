import assert from "node:assert/strict";
import test from "node:test";

import {
  getTranscriptionMessageKey,
  closeOpposingOpenBubbles,
  normalizeTranscriptionLeg,
  resetTranscriptionMessageKeys,
} from "../lib/agent-assist/transcription-turns.mjs";

const CALL = "v3:exampleCallControlId";

test("a finalized agent turn closes the customer's still-open bubble so the next customer utterance starts a new bubble", () => {
  resetTranscriptionMessageKeys();

  // 1) Customer speaks. speech_final is LOST -> bubble stays open (not final).
  const customerKey1 = getTranscriptionMessageKey(CALL, "inbound", false);
  // Same open utterance keeps the same key while interim.
  assert.equal(getTranscriptionMessageKey(CALL, "inbound", false), customerKey1);

  // 2) Agent speaks and finalizes (speech_final present on the agent leg).
  const agentKey1 = getTranscriptionMessageKey(CALL, "outbound", true);
  assert.notEqual(agentKey1, customerKey1);

  // 3) Customer speaks again. Because the agent turn finalized in between, the
  //    customer's stale open bubble must have been closed -> a NEW key.
  const customerKey2 = getTranscriptionMessageKey(CALL, "inbound", false);
  assert.notEqual(
    customerKey2,
    customerKey1,
    "second customer utterance must not be appended to the pre-agent-turn bubble",
  );
});

test("interim updates on the same leg keep the same bubble until a turn boundary", () => {
  resetTranscriptionMessageKeys();

  const k1 = getTranscriptionMessageKey(CALL, "inbound", false);
  const k2 = getTranscriptionMessageKey(CALL, "inbound", false);
  assert.equal(k1, k2, "consecutive interim chunks share one open bubble");
});

test("a finalized customer turn closes an open agent bubble too (symmetric)", () => {
  resetTranscriptionMessageKeys();

  const agentKey1 = getTranscriptionMessageKey(CALL, "outbound", false); // open, no speech_final
  getTranscriptionMessageKey(CALL, "inbound", true); // customer finalizes
  const agentKey2 = getTranscriptionMessageKey(CALL, "outbound", false);
  assert.notEqual(agentKey2, agentKey1);
});

test("non-inbound agent track names are treated as the agent leg for turn boundaries", () => {
  resetTranscriptionMessageKeys();

  assert.equal(normalizeTranscriptionLeg("inbound"), "inbound");
  assert.equal(normalizeTranscriptionLeg("outbound"), "outbound");
  assert.equal(normalizeTranscriptionLeg("agent"), "outbound");
  assert.equal(normalizeTranscriptionLeg("customer"), "outbound"); // not "inbound" -> agent leg

  const customerKey1 = getTranscriptionMessageKey(CALL, "inbound", false);
  getTranscriptionMessageKey(CALL, "agent", true); // agent leg labelled "agent" finalizes
  const customerKey2 = getTranscriptionMessageKey(CALL, "inbound", false);
  assert.notEqual(customerKey2, customerKey1);
});

test("closeOpposingOpenBubbles only closes other legs of the same call", () => {
  resetTranscriptionMessageKeys();

  getTranscriptionMessageKey(CALL, "inbound", false); // open customer bubble
  const otherCallCustomer = getTranscriptionMessageKey("other-call", "inbound", false);

  const closed = closeOpposingOpenBubbles(CALL, "outbound");
  assert.deepEqual(closed, [`${CALL}:inbound`]);

  // The other call's customer bubble is untouched.
  assert.equal(
    getTranscriptionMessageKey("other-call", "inbound", false),
    otherCallCustomer,
  );
});
