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

test("transcription confidence is preserved across interim replacement and final update", () => {
  resetActiveCallStore();
  const store = useActiveCallStore.getState();

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "utterance-confidence",
    transcript: "name is less",
    confidence: 0.62,
    is_final: false,
  });

  store.addTranscription({
    call_control_id: "call-control-1",
    transcription_track: "inbound",
    transcription_key: "utterance-confidence",
    transcript: "name is Leszek",
    confidence: 0.91,
    is_final: true,
    speech_final: true,
  });

  const { transcriptions } = useActiveCallStore.getState();
  assert.equal(transcriptions.length, 1);
  assert.equal(transcriptions[0].transcript, "name is Leszek");
  assert.equal(transcriptions[0].confidence, 0.91);
});
