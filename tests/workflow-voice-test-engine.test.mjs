import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceTestEngine, detectsEnding } from "../lib/ai/workflow-voice-test-engine.mjs";

const types = (actions) => actions.map((a) => a.type);

test("a greeting opens the caller turn only once the response is done", () => {
  const engine = createVoiceTestEngine();
  assert.equal(engine.phase, "connecting");
  assert.deepEqual(engine.handle({ type: "session.created", session: { conversation_id: "conv-1", audio: { output: { format: { rate: 24000 } } } } }), [
    { type: "session", conversationId: "conv-1", outputRate: 24000 },
  ]);
  assert.equal(engine.phase, "greeting");
  assert.deepEqual(types(engine.handle({ type: "response.created", response: { id: "r1" } })), ["assistant_started"]);
  assert.equal(engine.phase, "assistant");
  const d1 = engine.handle({ type: "response.output_audio_transcript.delta", response_id: "r1", item_id: "i1", delta: "Hello! " });
  const d2 = engine.handle({ type: "response.output_audio_transcript.delta", response_id: "r1", item_id: "i1", delta: "How can I help?" });
  assert.deepEqual(d1, [{ type: "assistant_delta", itemId: "i1", text: "Hello! " }]);
  assert.equal(d2[0].text, "Hello! How can I help?");
  // Audio may keep streaming after the transcript; nothing happens until response.done.
  assert.deepEqual(engine.handle({ type: "response.output_audio.done", response_id: "r1" }), []);
  assert.equal(engine.phase, "assistant");
  const done = engine.handle({ type: "response.done", response: { id: "r1", status: "completed" } });
  assert.deepEqual(done, [
    { type: "assistant_final", responseId: "r1", text: "Hello! How can I help?", interrupted: false },
    { type: "caller_turn", turn: 1, text: "Hello! How can I help?" },
  ]);
  assert.equal(engine.phase, "caller");
  assert.equal(engine.turns, 1);
});

test("the caller's recognised speech and VAD edges are surfaced; multi-item responses are joined in order", () => {
  const engine = createVoiceTestEngine();
  engine.handle({ type: "session.created", session: {} });
  assert.deepEqual(engine.handle({ type: "input_audio_buffer.speech_started" }), [{ type: "user_speaking" }]);
  assert.deepEqual(engine.handle({ type: "input_audio_buffer.speech_stopped" }), [{ type: "user_stopped" }]);
  assert.deepEqual(engine.handle({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: " I live in an apartment. " }), [
    { type: "user_final", itemId: "u1", text: "I live in an apartment." },
  ]);
  engine.handle({ type: "response.created", response: { id: "r2" } });
  engine.handle({ type: "response.output_audio_transcript.delta", item_id: "a", delta: "Got it." });
  engine.handle({ type: "response.output_audio_transcript.delta", item_id: "b", delta: " What heating do you use?" });
  const done = engine.handle({ type: "response.done", response: { id: "r2", status: "completed" } });
  assert.equal(done[0].text, "Got it. What heating do you use?");
  assert.equal(done[1].type, "caller_turn");
});

test("a barge-in (cancelled response) finalises what was heard and does not open a caller turn", () => {
  const engine = createVoiceTestEngine();
  engine.handle({ type: "session.created", session: {} });
  engine.handle({ type: "response.created", response: { id: "r3" } });
  engine.handle({ type: "response.output_audio_transcript.delta", item_id: "x", delta: "Let me explain the tariff" });
  const done = engine.handle({ type: "response.done", response: { id: "r3", status: "cancelled" } });
  assert.deepEqual(done, [{ type: "assistant_final", responseId: "r3", text: "Let me explain the tariff", interrupted: true }]);
  assert.equal(engine.phase, "caller");
  assert.equal(engine.turns, 0);
});

test("an ending phrase completes the test instead of opening another caller turn", () => {
  const engine = createVoiceTestEngine();
  engine.handle({ type: "session.created", session: {} });
  engine.handle({ type: "response.created", response: { id: "r4" } });
  engine.handle({ type: "response.output_audio_transcript.delta", item_id: "y", delta: "Thanks, have a great day!" });
  const done = engine.handle({ type: "response.done", response: { id: "r4", status: "completed" } });
  assert.deepEqual(types(done), ["assistant_final", "ending"]);
  assert.equal(engine.ended, true);
  // Later completed responses (e.g. a farewell after a tool) no longer drive the loop.
  engine.handle({ type: "response.created", response: { id: "r5" } });
  engine.handle({ type: "response.output_audio_transcript.delta", item_id: "z", delta: "Bye." });
  assert.deepEqual(types(engine.handle({ type: "response.done", response: { id: "r5", status: "completed" } })), ["assistant_final"]);
  assert.deepEqual(engine.handle({ type: "session.ended" }), [{ type: "ended" }]);
  assert.equal(engine.phase, "ended");
  assert.equal(detectsEnding("Thank you for calling, how can I help?"), false, "greetings are not endings");
});

test("silent responses, tools, errors and stop() are reported without inventing caller turns", () => {
  const engine = createVoiceTestEngine();
  engine.handle({ type: "session.created", session: {} });
  engine.handle({ type: "response.created", response: { id: "r6" } });
  assert.deepEqual(engine.handle({ type: "response.tool_call.started", tool_call: { name: "lookup" } }), [{ type: "tool", name: "lookup", status: "started" }]);
  assert.deepEqual(engine.handle({ type: "response.tool_call.completed", tool_call: { name: "lookup" }, status: "success" }), [{ type: "tool", name: "lookup", status: "success" }]);
  assert.deepEqual(engine.handle({ type: "response.done", response: { id: "r6", status: "completed" } }), [{ type: "silent_response", responseId: "r6" }]);
  assert.deepEqual(engine.handle({ type: "error", error: { code: "ingress_budget_exceeded", message: "Too fast" } }), [{ type: "error", code: "ingress_budget_exceeded", message: "Too fast" }]);
  assert.deepEqual(engine.handle({ type: "unknown.frame" }), []);
  engine.stop();
  engine.handle({ type: "response.created", response: { id: "r7" } });
  engine.handle({ type: "response.output_audio_transcript.delta", item_id: "q", delta: "Anything else?" });
  assert.deepEqual(types(engine.handle({ type: "response.done", response: { id: "r7", status: "completed" } })), ["assistant_final"]);
});

test("a failed or incomplete response never opens a caller turn (Codex review on #1636)", () => {
  for (const status of ["failed", "incomplete"]) {
    const engine = createVoiceTestEngine();
    engine.handle({ type: "session.created", session: {} });
    engine.handle({ type: "response.created", response: { id: "rf" } });
    engine.handle({ type: "response.output_audio_transcript.delta", item_id: "p", delta: "Your pickup is at" });
    const done = engine.handle({ type: "response.done", response: { id: "rf", status } });
    assert.deepEqual(done, [
      { type: "assistant_final", responseId: "rf", text: "Your pickup is at", interrupted: false, failed: true },
      { type: "response_failed", responseId: "rf", status },
    ], status);
    assert.equal(engine.ended, true);
    // A failed response without any transcript is not reported as a silent turn.
    const silent = createVoiceTestEngine();
    silent.handle({ type: "session.created", session: {} });
    silent.handle({ type: "response.created", response: { id: "rs" } });
    assert.deepEqual(silent.handle({ type: "response.done", response: { id: "rs", status } }), [{ type: "response_failed", responseId: "rs", status }]);
  }
});

test("closing phrases count only as whole words in the last sentence", () => {
  assert.equal(detectsEnding("Got it, Lisa. Goodbye and take care! 👋"), true);
  assert.equal(detectsEnding("Have a great day, goodbye"), true);
  assert.equal(detectsEnding("I'll take care of that. What is your postcode?"), false, "a phrase inside an earlier sentence is not an ending");
  assert.equal(detectsEnding("Take care! Is there anything else I can help with?"), false, "the assistant keeps the conversation open");
  assert.equal(detectsEnding("Let me end the callback request first."), false, "whole words only");
});
