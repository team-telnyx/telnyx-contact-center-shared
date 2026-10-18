import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Source guards for the Test AI Agent page's slot-analysis wiring
// (the internal documentation, 3.1-3.4).
// The behaviour itself is unit-tested in tests/test-analysis-queue.test.mjs;
// these checks keep the page from drifting back to the cancellable effect.

const PAGE = new URL("../app/(portal)/admin/workflows/[id]/test/page.jsx", import.meta.url);

test("the page analyses through the shared queue, not a cancellable effect", async () => {
  const src = await readFile(PAGE, "utf8");
  assert.match(src, /from\s+["']@\/lib\/agent-assist\/test-analysis-queue\.mjs["']/);
  assert.match(src, /createTestAnalysisQueue\(/);
  // The old effect advanced this index even when its result was discarded.
  assert.doesNotMatch(src, /lastAnalyzedMessageIndexRef/);
  assert.doesNotMatch(src, /analysisRetryTrigger/);
  // Waiting is promise-based, not ref polling.
  assert.doesNotMatch(src, /waitForAnalysisAndDelay/);
  assert.match(src, /analysisQueue\.idle\(\)/);
});

test("chat and voice lines are enqueued where they are appended", async () => {
  const src = await readFile(PAGE, "utf8");
  // Chat: the caller's line and the assistant's reply. Voice (Telnyx
  // conversation WebSocket): each final assistant response, each caller line
  // as Telnyx recognised it, and a text turn typed in MANUAL mode.
  const calls = src.match(/enqueueForAnalysis\((userMessage|aiMessage|assistantMessage|callerMessage|typedMessage)\)/g) || [];
  assert.deepEqual(
    [...new Set(calls)].sort(),
    [
      "enqueueForAnalysis(aiMessage)",
      "enqueueForAnalysis(assistantMessage)",
      "enqueueForAnalysis(callerMessage)",
      "enqueueForAnalysis(typedMessage)",
      "enqueueForAnalysis(userMessage)",
    ],
  );
  // The voice caller waits for the queue, bounded so the assistant is not left in silence.
  assert.match(src, /Promise\.race\(\[\s*analysisQueue\.idle\(\)/);
});

test("the analyze request carries the preceding lines as recentContext", async () => {
  const src = await readFile(PAGE, "utf8");
  const start = src.indexOf("async function analyzeWorkflowMessage(");
  assert.ok(start > -1);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(body, /recentContext:\s*job\.recentContext/);
});

test("Pause is read from a ref inside the auto loop", async () => {
  const src = await readFile(PAGE, "utf8");
  const start = src.indexOf("const processAIResponse = useCallback(");
  assert.ok(start > -1);
  const end = src.indexOf("// Create a new conversation via Telnyx API", start);
  const loop = src.slice(start, end);
  assert.match(loop, /isPausedRef\.current/);
  assert.doesNotMatch(loop, /\|\|\s*isPaused\b/, "the stale closure value must not gate the loop");
});

test("suggested statuses render but never count as completed", async () => {
  const src = await readFile(PAGE, "utf8");
  assert.match(src, /status\.status === "suggested"/);
  const stage = src.slice(src.indexOf("function getStageCompletion("), src.indexOf("async function analyzeWorkflowMessage("));
  assert.match(stage, /status\?\.status === "completed"/);
  assert.doesNotMatch(stage, /suggested/);
  const progress = src.slice(src.indexOf("const completedWorkflowItems ="), src.indexOf("const completedWorkflowItems =") + 200);
  assert.match(progress, /s\?\.status === "completed"/);
});
