import assert from "node:assert/strict";
import test from "node:test";

import useActiveCallStore from "../lib/stores/active-call-store.js";

function resetActiveCallStore() {
  useActiveCallStore.setState({
    call: { id: "test-call" },
    originalCallControlId: "call-control-1",
    transcriptions: [],
  });
}

test("interim transcription updates replace the open bubble instead of appending revised hypotheses", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "utterance-1",
    transcript: "I would like",
    is_final: false,
  });

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "utterance-1",
    transcript: "I would",
    is_final: false,
  });

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "utterance-1",
    transcript: "I would like to go to the forest",
    is_final: false,
  });

  const { transcriptions } = useActiveCallStore.getState();
  assert.equal(transcriptions.length, 1);
  assert.equal(transcriptions[0].transcript, "I would like to go to the forest");
});

test("final transcription update closes the same bubble with the final transcript", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "utterance-2",
    transcript: "can you hear",
    is_final: false,
  });

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "utterance-2",
    transcript: "can you hear me",
    is_final: true,
    speech_final: true,
  });

  const { transcriptions } = useActiveCallStore.getState();
  assert.equal(transcriptions.length, 1);
  assert.equal(transcriptions[0].transcript, "can you hear me");
  assert.equal(transcriptions[0].isFinal, true);
});

test("transcription confidence is normalized and preserved on transcript bubbles", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "utterance-confidence",
    transcript: "reset my password",
    is_final: false,
    confidence: "0.874",
    source: "telnyx_standalone_stt_websocket",
    provider: "deepgram",
    model: "nova-3",
    language: "en",
  });

  let { transcriptions } = useActiveCallStore.getState();
  assert.equal(transcriptions.length, 1);
  assert.equal(transcriptions[0].confidence, 0.874);
  assert.equal(transcriptions[0].source, "telnyx_standalone_stt_websocket");
  assert.equal(transcriptions[0].provider, "deepgram");
  assert.equal(transcriptions[0].model, "nova-3");
  assert.equal(transcriptions[0].language, "en");

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "utterance-confidence",
    transcript: "reset my password please",
    is_final: true,
    speech_final: true,
    confidence: 0.91,
  });

  ({ transcriptions } = useActiveCallStore.getState());
  assert.equal(transcriptions.length, 1);
  assert.equal(transcriptions[0].confidence, 0.91);
  assert.equal(transcriptions[0].isFinal, true);
});

test("invalid or missing transcription confidence does not create a misleading zero-confidence value", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "utterance-invalid-confidence",
    transcript: "hello",
    is_final: true,
    confidence: "not-a-number",
  });

  const { transcriptions } = useActiveCallStore.getState();
  assert.equal(transcriptions.length, 1);
  assert.equal(transcriptions[0].confidence, undefined);
});


test("contact center metadata updates keep agent assist language metadata live", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  store.setContactCenterMetadata({
    metadata: {
      caller_language: "en",
      agent_language: "pl",
    },
  });

  const { contactCenter } = useActiveCallStore.getState();
  assert.deepEqual(contactCenter.metadata, {
    caller_language: "en",
    agent_language: "pl",
  });
});

test("a customer utterance is NOT appended to a stale open bubble after the agent has spoken (turn boundary)", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  // 1) Customer speaks; speech_final is lost so the bubble never finalizes.
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "cust-1",
    transcript: "weighs around one hundred and fifty pounds, female, it's",
    is_final: false,
  });

  // 2) Agent speaks across THREE finalized bubbles.
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "outbound",
    transcription_key: "agent-1",
    transcript: "Sorry. Could you repeat",
    is_final: true,
    speech_final: true,
  });
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "outbound",
    transcription_key: "agent-2",
    transcript: "And what is, uh, the gender",
    is_final: true,
    speech_final: true,
  });
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "outbound",
    transcription_key: "agent-3",
    transcript: "What will be the facility name for the pickup?",
    is_final: true,
    speech_final: true,
  });

  // 3) Customer speaks again. Even though the server (under the lost-speech_final
  //    failure mode) reused the SAME key, the client must start a NEW bubble.
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "cust-1",
    transcript: "Northgate Presbyterian Hospital Dent",
    is_final: false,
  });

  const { transcriptions } = useActiveCallStore.getState();
  // Consecutive agent finals are coalesced into one bubble by design, so the
  // agent turn is asserted as a block rather than by bubble count. What must
  // hold is the turn boundary itself: the customer's stale bubble closes and
  // the later customer speech starts a new one after the agent's.
  const tracks = transcriptions.map((item) => item.track);
  assert.deepEqual([...new Set(tracks)], ["inbound", "outbound"]);
  assert.equal(tracks[0], "inbound");
  assert.equal(tracks[tracks.length - 1], "inbound");
  assert.ok(tracks.slice(1, -1).every((track) => track === "outbound"),
    "the agent turn sits between the two customer utterances");
  assert.equal(transcriptions.filter((item) => item.track === "inbound").length, 2,
    "the customer's two utterances are never merged across the agent turn");
  const agentText = transcriptions.filter((item) => item.track === "outbound")
    .map((item) => item.transcript).join(" ");
  for (const line of ["Sorry. Could you repeat", "And what is, uh, the gender",
    "What will be the facility name for the pickup?"]) {
    assert.ok(agentText.includes(line), `the agent turn keeps "${line}"`);
  }

  // The stale customer bubble was closed and keeps only its original text.
  assert.equal(
    transcriptions[0].transcript,
    "weighs around one hundred and fifty pounds, female, it's",
  );
  assert.equal(transcriptions[0].isFinal, true);

  // The new customer utterance is the LAST bubble, after the agent's lines.
  const last = transcriptions[transcriptions.length - 1];
  assert.equal(last.track, "inbound");
  assert.equal(last.transcript, "Northgate Presbyterian Hospital Dent");
  assert.notEqual(last.id, transcriptions[0].id);
  assert.notEqual(last.transcriptionKey, transcriptions[0].transcriptionKey);
  assert.equal(last.originalTranscriptionKey, "cust-1");
});

test("split transcription bubbles with a reused server key keep later chunks merged", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "cust-reused",
    transcript: "first stale utterance",
    is_final: false,
  });
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "outbound",
    transcription_key: "agent-boundary",
    transcript: "can you repeat that",
    is_final: true,
    speech_final: true,
  });
  const splitId = store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "cust-reused",
    transcript: "second utterance",
    is_final: false,
  });
  const updateId = store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "cust-reused",
    transcript: "second utterance updated",
    is_final: false,
  });

  const { transcriptions } = useActiveCallStore.getState();
  assert.equal(transcriptions.length, 3);
  assert.equal(updateId, splitId);
  assert.equal(transcriptions[2].transcript, "second utterance updated");
  assert.equal(transcriptions[2].transcriptionKey, splitId);
  assert.equal(transcriptions[2].originalTranscriptionKey, "cust-reused");
});

test("analysis updates for a reused server key target the split bubble", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "cust-analysis",
    transcript: "first stale utterance",
    is_final: false,
  });
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "outbound",
    transcription_key: "agent-analysis-boundary",
    transcript: "can you repeat that",
    is_final: true,
    speech_final: true,
  });
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "cust-analysis",
    transcript: "second utterance",
    is_final: false,
  });

  store.updateTranscriptionAnalysis("cust-analysis", {
    intent: "schedule_transport",
    sentiment: "neutral",
  });

  const { transcriptions } = useActiveCallStore.getState();
  assert.equal(transcriptions[0].intent, null);
  assert.equal(transcriptions[2].intent, "schedule_transport");
  assert.equal(transcriptions[2].sentiment, "neutral");
});

test("analysis updates prefer a newer exact reused server key over older split fallback", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "cust-analysis",
    transcript: "first stale utterance",
    is_final: false,
  });
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "outbound",
    transcription_key: "agent-analysis-boundary",
    transcript: "can you repeat that",
    is_final: true,
    speech_final: true,
  });
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "cust-analysis",
    transcript: "second utterance",
    is_final: true,
    speech_final: true,
  });
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "outbound",
    transcription_key: "agent-analysis-boundary-2",
    transcript: "anything else",
    is_final: true,
    speech_final: true,
  });
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "cust-analysis",
    transcript: "third exact utterance",
    is_final: true,
    speech_final: true,
  });

  store.updateTranscriptionAnalysis("cust-analysis", {
    intent: "confirm_pickup",
    sentiment: "positive",
  });

  const { transcriptions } = useActiveCallStore.getState();
  assert.equal(transcriptions[2].intent, null);
  assert.equal(transcriptions[4].intent, "confirm_pickup");
  assert.equal(transcriptions[4].sentiment, "positive");
});

test("consecutive interim chunks on the same leg still merge into one open bubble", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "same-bubble",
    transcript: "I would",
    is_final: false,
  });
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "same-bubble",
    transcript: "I would like a transport",
    is_final: false,
  });

  const { transcriptions } = useActiveCallStore.getState();
  assert.equal(transcriptions.length, 1);
  assert.equal(transcriptions[0].transcript, "I would like a transport");
});

test("a repeated final on the same leg with identical text is deduped (no duplicate row)", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  // First final (segment-end).
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "dup-1",
    transcript: "Sarah Thompson.",
    is_final: true,
  });
  // Same final re-delivered (speech_final / duplicate WS message), different key.
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "dup-1b",
    transcript: "Sarah Thompson.",
    is_final: true,
    speech_final: true,
  });

  const { transcriptions } = useActiveCallStore.getState();
  assert.equal(transcriptions.length, 1);
  assert.equal(transcriptions[0].transcript, "Sarah Thompson.");
});

test("a legit repeat of the same phrase across turns is NOT deduped", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "no-1",
    transcript: "No.",
    is_final: true,
  });
  // Agent speaks in between (other leg), so the customer's next "No." is a real
  // separate answer, not a duplicate.
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "outbound",
    transcription_key: "agent-1",
    transcript: "Any other aircraft currently responding?",
    is_final: true,
  });
  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "no-2",
    transcript: "No.",
    is_final: true,
  });

  const { transcriptions } = useActiveCallStore.getState();
  assert.equal(transcriptions.length, 3);
});
