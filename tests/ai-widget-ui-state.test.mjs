import assert from "node:assert/strict";
import test from "node:test";

import {
  getAIWidgetStatus,
  normalizeAITranscript,
} from "../lib/ai/widget-ui-state.mjs";

test("maps the authenticated client lifecycle to a ready state", () => {
  assert.deepEqual(
    getAIWidgetStatus({
      connectionState: "connected",
      authState: "authenticated",
      agentState: { state: "listening" },
      callState: null,
    }),
    {
      key: "ready",
      label: "Ready",
      description: "Ready to start a conversation",
      tone: "success",
    }
  );
});

test("uses the object-shaped 0.6 agent state during an active call", () => {
  const status = getAIWidgetStatus({
    connectionState: "connected",
    authState: "authenticated",
    agentState: { state: "thinking", userPerceivedLatencyMs: 420 },
    callState: "active",
  });

  assert.equal(status.key, "thinking");
  assert.equal(status.label, "Thinking");
  assert.equal(status.animated, true);
});

test("connection errors take priority over stale call states", () => {
  const status = getAIWidgetStatus({
    connectionState: "connected",
    authState: "authenticated",
    agentState: { state: "speaking" },
    callState: "active",
    error: "Socket closed",
  });

  assert.equal(status.key, "error");
  assert.equal(status.description, "Socket closed");
});

test("combines consecutive assistant text deltas into one message bubble", () => {
  const transcript = normalizeAITranscript([
    { id: "response-1-1", role: "assistant", content: "Hello", timestamp: "2026-08-04T10:00:00Z" },
    { id: "response-1-2", role: "assistant", content: ", how can I help?", timestamp: "2026-08-04T10:00:01Z" },
  ]);

  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].content, "Hello, how can I help?");
  assert.deepEqual(transcript[0].sourceIds, ["response-1-1", "response-1-2"]);
});

test("starts a new assistant bubble after the user responds", () => {
  const transcript = normalizeAITranscript([
    { id: "a-1", role: "assistant", content: "First", timestamp: "2026-08-04T10:00:00Z" },
    { id: "u-1", role: "user", content: "Continue", timestamp: "2026-08-04T10:00:01Z" },
    { id: "a-2", role: "assistant", content: "Second", timestamp: "2026-08-04T10:00:02Z" },
  ]);

  assert.deepEqual(transcript.map((item) => item.content), ["First", "Continue", "Second"]);
});

test("replaces transcript items with the same id instead of duplicating them", () => {
  const transcript = normalizeAITranscript([
    { id: "user-1", role: "user", content: "Hel", timestamp: "2026-08-04T10:00:00Z" },
    { id: "user-1", role: "user", content: "Hello", timestamp: "2026-08-04T10:00:01Z" },
  ]);

  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].content, "Hello");
});

test("keeps source ids when an assistant transcript item is updated before another delta", () => {
  const transcript = normalizeAITranscript([
    { id: "response-1", role: "assistant", content: "Hel", timestamp: "2026-08-04T10:00:00Z" },
    { id: "response-1", role: "assistant", content: "Hello", timestamp: "2026-08-04T10:00:01Z" },
    { id: "response-2", role: "assistant", content: " there", timestamp: "2026-08-04T10:00:02Z" },
  ]);

  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].content, "Hello there");
  assert.deepEqual(transcript[0].sourceIds, ["response-1", "response-2"]);
});

test("uses stable fallback ids for transcript items without SDK ids", () => {
  const transcript = normalizeAITranscript([
    { role: "assistant", content: "One", timestamp: "2026-08-04T10:00:00Z" },
    { role: "assistant", content: " two", timestamp: "2026-08-04T10:00:01Z" },
    { role: "assistant", content: " three", timestamp: "2026-08-04T10:00:02Z" },
  ]);

  assert.equal(transcript[0].content, "One two three");
  assert.deepEqual(transcript[0].sourceIds, ["assistant-0", "assistant-1", "assistant-2"]);
});

test("keeps a pending typed message until the SDK echoes it", () => {
  const timestamp = new Date("2026-08-04T10:00:00Z");
  const pending = [{ id: "pending-1", content: "Typed message", timestamp, status: "sending" }];

  const beforeEcho = normalizeAITranscript([], pending);
  assert.equal(beforeEcho[0].pending, true);

  const afterEcho = normalizeAITranscript(
    [{ id: "user-1", role: "user", content: "Typed message", timestamp }],
    pending
  );
  assert.equal(afterEcho.length, 1);
  assert.equal(afterEcho[0].id, "user-1");
  assert.equal(afterEcho[0].pending, false);
});
