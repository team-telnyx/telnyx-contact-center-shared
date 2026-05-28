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
