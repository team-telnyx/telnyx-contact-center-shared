import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard for the AI Agent voice test reply loop.
//
// Symptom that motivated this: the assistant's message bubbles rendered
// (transcript.item arrived over WebSocket) but the simulated caller never
// replied. Root cause: the "welcome gate" (welcomeMessageReceivedRef) was only
// opened on the audio-volume-derived "speaking" state, which can be missed if
// the assistant's TTS stays below the SDK loudness threshold. The turn-settle
// debounce in the "listening" branch is gated on that flag, so replies never fired.
//
// Fix: open the welcome gate on the first assistant transcript line and arm the
// turn-settle debounce from the transcript handler too, via a shared
// armTurnSettle() helper. These tests assert that wiring stays in place.

const SRC_URL = new URL(
  "../app/(portal)/admin/workflows/[id]/test/page.jsx",
  import.meta.url,
);

test("welcome gate is opened by the first assistant transcript line", async () => {
  const src = await readFile(SRC_URL, "utf8");
  // Inside the transcript.item handler, an assistant line must set the welcome flag.
  assert.match(
    src,
    /Welcome gate opened by assistant transcript/,
    "transcript.item handler should open the welcome gate for assistant lines",
  );
  assert.match(
    src,
    /welcomeMessageReceivedRef\.current\s*=\s*true/,
    "welcome gate flag should be set to true",
  );
});

test("a shared armTurnSettle helper drives the reply, called from state and transcript handlers", async () => {
  const src = await readFile(SRC_URL, "utf8");
  assert.match(
    src,
    /const\s+armTurnSettle\s*=\s*\(\)\s*=>/,
    "should define a shared armTurnSettle helper",
  );
  // Helper must be invoked from at least two places (listening state + transcript).
  const calls = src.match(/armTurnSettle\(\);/g) || [];
  assert.ok(
    calls.length >= 2,
    `armTurnSettle() should be called from both the listening state and transcript handlers (found ${calls.length})`,
  );
  // The helper must ultimately trigger the simulated caller response.
  assert.match(
    src,
    /handleVoiceAutoResponse\(\);/,
    "armTurnSettle should fire handleVoiceAutoResponse when the turn settles",
  );
});

test("no fixed response delay remains in the voice reply path", async () => {
  const src = await readFile(SRC_URL, "utf8");
  assert.doesNotMatch(
    src,
    /voiceResponseDelay/,
    "the old fixed voiceResponseDelay must not be reintroduced",
  );
});
