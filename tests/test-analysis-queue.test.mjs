import test from "node:test";
import assert from "node:assert/strict";

import {
  createTestAnalysisQueue,
  applyAnalysisResult,
  toAnalysisLine,
  toAnalysisSpeaker,
} from "../lib/agent-assist/test-analysis-queue.mjs";

// Regression guard for the Test AI Agent slot-detection loop.
//
// Symptom (the internal documentation, 3.1):
// a full simulated chat completed but almost no workflow slots were marked
// recognised, because the page's useEffect analysis loop was cancelled by
// React whenever the assistant's reply arrived while the customer's message
// was still being analysed. The queue below must never lose a job that way.

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Fake analyzer that hands control of every call back to the test. */
function fakeAnalyzer() {
  const calls = [];
  const analyze = (job) => {
    const gate = deferred();
    calls.push({ job, gate });
    return gate.promise;
  };
  return { analyze, calls };
}

const customer = (id, content) => ({ id, role: "user", content });
const agent = (id, content) => ({ id, role: "assistant", content });

test("speaker and line normalisation", () => {
  assert.equal(toAnalysisSpeaker("user"), "customer");
  assert.equal(toAnalysisSpeaker("inbound"), "customer");
  assert.equal(toAnalysisSpeaker("assistant"), "agent");
  assert.equal(toAnalysisSpeaker("outbound"), "agent");
  assert.equal(toAnalysisSpeaker("system"), null);

  assert.equal(toAnalysisLine({ id: "s", role: "system", content: "Starting test" }), null);
  assert.equal(toAnalysisLine({ id: "u", role: "user", content: "   " }), null);
  assert.deepEqual(toAnalysisLine({ id: 7, role: "user", content: " Hi " }), {
    id: "7",
    speaker: "customer",
    text: "Hi",
  });
  // Transcript items use `speaker`/`text`; chat messages use `role`/`content`.
  assert.deepEqual(toAnalysisLine({ id: "t", speaker: "inbound", text: "Hello" }), {
    id: "t",
    speaker: "customer",
    text: "Hello",
  });
});

test("applyAnalysisResult applies completed and suggested updates and merges slots", () => {
  const start = { itemStatuses: {}, slotsFilled: { existing: "kept" } };
  const next = applyAnalysisResult(start, {
    updates: [
      { item_id: "a", status: "completed", confidence: 0.98, extracted_value: "Paris", source_text: "I live in Paris" },
      { item_id: "b", status: "suggested", confidence: 0.7, extracted_value: "85", low_confidence: true, confidence_threshold: 0.95, alternatives: [{ value: "58", confidence: 0.2 }] },
    ],
    slotsFilled: { city: "Paris" },
  });
  assert.equal(next.changed, true);
  assert.equal(next.itemStatuses.a.status, "completed");
  assert.equal(next.itemStatuses.a.value, "Paris");
  assert.equal(next.itemStatuses.a.confidence_score, 0.98);
  assert.equal(next.itemStatuses.b.status, "suggested");
  assert.equal(next.itemStatuses.b.value, "85");
  assert.equal(next.itemStatuses.b.confidence_score, 0.7);
  assert.equal(next.itemStatuses.b.low_confidence, true);
  assert.deepEqual(next.itemStatuses.b.alternatives, [{ value: "58", confidence: 0.2 }]);
  assert.deepEqual(next.slotsFilled, { existing: "kept", city: "Paris" });
  // The input state is not mutated.
  assert.deepEqual(start, { itemStatuses: {}, slotsFilled: { existing: "kept" } });

  // A suggestion never downgrades a completed item; a pending update reopens it.
  const downgraded = applyAnalysisResult(next, {
    updates: [{ item_id: "a", status: "suggested", confidence: 0.5, extracted_value: "Lyon" }],
  });
  assert.equal(downgraded.itemStatuses.a.status, "completed");
  assert.equal(downgraded.itemStatuses.a.value, "Paris");
  assert.equal(downgraded.changed, false);

  // A caller correction (analyze-test, an earlier fix) does replace a completed
  // slot: the item is reopened for review with the new value, and slotsFilled
  // keeps the old value until a later completed update confirms the new one.
  const corrected = applyAnalysisResult(next, {
    updates: [{ item_id: "a", status: "suggested", is_correction: true, low_confidence: true, confidence: 1, extracted_value: "Lyon 69001" }],
    slotsFilled: { existing: "kept", city: "Paris" },
  });
  assert.equal(corrected.changed, true);
  assert.equal(corrected.itemStatuses.a.status, "suggested");
  assert.equal(corrected.itemStatuses.a.is_correction, true);
  assert.equal(corrected.itemStatuses.a.value, "Lyon 69001");
  assert.equal(corrected.slotsFilled.city, "Paris");
  const confirmed = applyAnalysisResult(corrected, {
    updates: [{ item_id: "a", status: "completed", confidence: 0.98, extracted_value: "Lyon 69001" }],
    slotsFilled: { existing: "kept", city: "Lyon 69001" },
  });
  assert.equal(confirmed.itemStatuses.a.status, "completed");
  assert.equal(confirmed.itemStatuses.a.is_correction, false);
  assert.equal(confirmed.slotsFilled.city, "Lyon 69001");

  const reopened = applyAnalysisResult(next, {
    updates: [{ item_id: "a", status: "pending", cleared_reason: "duplicate" }],
  });
  assert.equal(reopened.itemStatuses.a.status, "pending");
  assert.equal(reopened.itemStatuses.a.value, null);
});

test("jobs run one at a time, in arrival order", async () => {
  const { analyze, calls } = fakeAnalyzer();
  const queue = createTestAnalysisQueue({ analyze });

  queue.enqueue(customer("c1", "My name is Anna"));
  queue.enqueue(agent("a1", "Thanks Anna. Where do you live?"));
  queue.enqueue(customer("c2", "In Lyon"));
  await tick();

  assert.equal(calls.length, 1, "only the first job may be in flight");
  assert.equal(calls[0].job.messageId, "c1");
  assert.equal(queue.size(), 2);

  calls[0].gate.resolve({ updates: [], slotsFilled: {} });
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].job.messageId, "a1");

  calls[1].gate.resolve({ updates: [], slotsFilled: {} });
  await tick();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].job.messageId, "c2");
  assert.equal(calls[2].job.speaker, "customer");
  assert.equal(calls[2].job.transcript, "In Lyon");
});

test("regression: an assistant reply enqueued mid-analysis does not drop the customer's slot", async () => {
  const { analyze, calls } = fakeAnalyzer();
  const updates = [];
  const queue = createTestAnalysisQueue({
    analyze,
    onUpdate: (event) => updates.push(event),
  });

  // 1. The simulated caller answers; its analysis starts (slow LLM round trip).
  queue.enqueue(customer("c1", "Around 85 euros a month"));
  await tick();
  assert.equal(calls.length, 1);

  // 2. The assistant replies while that analysis is still in flight. In the
  //    old useEffect loop this re-ran the effect, cancelled run 1 and threw
  //    its result away. Here it only appends.
  queue.enqueue(agent("a1", "Got it. Do you live in a house or an apartment?"));
  await tick();
  assert.equal(calls.length, 1, "the in-flight customer analysis must not be interrupted");

  // 3. The customer's analysis completes with the slot.
  calls[0].gate.resolve({
    updates: [{ item_id: "monthly_bill", status: "completed", confidence: 0.99, extracted_value: "85" }],
    slotsFilled: { monthly_bill: "85" },
  });
  await tick();

  assert.equal(updates.length, 1, "the customer's result must be applied");
  assert.equal(updates[0].message.id, "c1");
  assert.equal(updates[0].itemStatuses.monthly_bill.status, "completed");
  assert.equal(updates[0].itemStatuses.monthly_bill.value, "85");
  assert.deepEqual(updates[0].slotsFilled, { monthly_bill: "85" });
  assert.equal(queue.getState().itemStatuses.monthly_bill.status, "completed");

  // 4. The assistant line is analysed next, with the slot already in its snapshot.
  assert.equal(calls.length, 2);
  assert.equal(calls[1].job.messageId, "a1");
  assert.equal(calls[1].job.itemStatuses.monthly_bill.status, "completed");
  assert.deepEqual(calls[1].job.slotsFilled, { monthly_bill: "85" });

  calls[1].gate.resolve({ updates: [], slotsFilled: { monthly_bill: "85" } });
  await queue.idle();
  assert.equal(queue.getState().itemStatuses.monthly_bill.status, "completed");
});

test("each job carries the last four preceding lines as speaker-labelled recent context", async () => {
  const { analyze, calls } = fakeAnalyzer();
  const queue = createTestAnalysisQueue({ analyze });

  queue.enqueue({ id: "sys", role: "system", content: "Starting chat test" });
  queue.enqueue(customer("c0", "Hello"));
  queue.enqueue(agent("a0", "Welcome! What is your name?"));
  queue.enqueue(customer("c1", "Anna"));
  queue.enqueue(agent("a1", "Where do you live?"));
  queue.enqueue(customer("c2", "Lyon"));
  queue.enqueue(agent("a2", "How much is your monthly bill?"));
  queue.enqueue(customer("c3", "Around 85 euros"));
  await tick();

  // Drain everything so every job is observable.
  for (let i = 0; i < 7; i += 1) {
    calls[i].gate.resolve({ updates: [], slotsFilled: {} });
    await tick();
  }

  const byId = Object.fromEntries(calls.map(({ job }) => [job.messageId, job]));
  assert.ok(!byId.sys, "system lines are never analysed");
  assert.deepEqual(byId.c0.recentContext, []);
  assert.deepEqual(byId.a0.recentContext, [{ speaker: "customer", text: "Hello" }]);
  assert.deepEqual(byId.c3.recentContext, [
    { speaker: "customer", text: "Anna" },
    { speaker: "agent", text: "Where do you live?" },
    { speaker: "customer", text: "Lyon" },
    { speaker: "agent", text: "How much is your monthly bill?" },
  ]);
  // The context is the lines BEFORE the message, not the lines enqueued later.
  assert.deepEqual(byId.c1.recentContext, [
    { speaker: "customer", text: "Hello" },
    { speaker: "agent", text: "Welcome! What is your name?" },
  ]);
});

test("idle() resolves immediately when empty and only after every queued job otherwise", async () => {
  const { analyze, calls } = fakeAnalyzer();
  const queue = createTestAnalysisQueue({ analyze });

  await queue.idle(); // nothing queued: must not hang

  queue.enqueue(customer("c1", "Hello"));
  let settled = false;
  const waiting = queue.idle().then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);

  // A line that arrives while the first job runs is awaited too.
  queue.enqueue(agent("a1", "Hi there"));
  calls[0].gate.resolve({ updates: [] });
  await tick();
  assert.equal(settled, false, "idle must wait for the job enqueued mid-flight");

  calls[1].gate.resolve({ updates: [] });
  await waiting;
  assert.equal(settled, true);
  assert.equal(queue.isBusy(), false);
});

test("duplicate ids are ignored and sync() enqueues only unseen messages", async () => {
  const analysed = [];
  const queue = createTestAnalysisQueue({
    analyze: async (job) => {
      analysed.push(job.messageId);
      return { updates: [] };
    },
  });

  const messages = [
    { id: "s", role: "system", content: "Starting" },
    customer("c1", "Hello"),
    agent("a1", "Hi"),
  ];
  assert.equal(queue.sync(messages), 2);
  assert.equal(queue.enqueue(customer("c1", "Hello again")), false);
  assert.equal(queue.sync([...messages, customer("c2", "Second")]), 1);
  await queue.idle();
  assert.deepEqual(analysed, ["c1", "a1", "c2"]);
  assert.deepEqual(
    queue.getHistory().map((line) => line.id),
    ["c1", "a1", "c2"],
  );
});

test("a failed analysis is retried once, then reported, and never blocks the next job", async () => {
  const { analyze, calls } = fakeAnalyzer();
  const errors = [];
  const updates = [];
  const queue = createTestAnalysisQueue({
    analyze,
    onError: (err, job) => errors.push({ err, id: job?.messageId }),
    onUpdate: (event) => updates.push(event),
  });

  queue.enqueue(customer("c1", "Hello"));
  queue.enqueue(customer("c2", "Anna"));
  await tick();

  // c1: first attempt fails, retry succeeds.
  calls[0].gate.reject(new Error("502 upstream"));
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].job.messageId, "c1", "the same job is retried");
  calls[1].gate.resolve({ updates: [{ item_id: "x", status: "completed", confidence: 1, extracted_value: "ok" }] });
  await tick();
  assert.equal(updates.length, 1);
  assert.equal(errors.length, 0);

  // c2: both attempts fail -> reported once, queue continues.
  assert.equal(calls[2].job.messageId, "c2");
  calls[2].gate.reject(new Error("timeout"));
  await tick();
  calls[3].gate.reject(new Error("timeout again"));
  await queue.idle();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, "c2");
  assert.equal(errors[0].err.message, "timeout again");
  // State from c1 survives the c2 failure.
  assert.equal(queue.getState().itemStatuses.x.status, "completed");
});

test("reset() discards the in-flight result, clears state and releases idle() waiters", async () => {
  const { analyze, calls } = fakeAnalyzer();
  const updates = [];
  const busy = [];
  const queue = createTestAnalysisQueue({
    analyze,
    onUpdate: (event) => updates.push(event),
    onBusyChange: (value) => busy.push(value),
  });

  queue.enqueue(customer("old-1", "Old test answer"));
  await tick();
  const waiting = queue.idle();
  const staleSignal = calls[0].job.signal;

  queue.reset();
  await waiting; // must not hang on the stale job
  assert.equal(staleSignal.aborted, true);

  // New test starts while the stale request is still unresolved.
  queue.enqueue(customer("new-1", "New test answer"));
  calls[0].gate.resolve({
    updates: [{ item_id: "stale", status: "completed", confidence: 1, extracted_value: "no" }],
    slotsFilled: { stale: "no" },
  });
  await tick();
  assert.equal(updates.length, 0, "the stale result must be discarded");
  assert.deepEqual(queue.getState(), { itemStatuses: {}, slotsFilled: {} });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].job.messageId, "new-1");
  assert.deepEqual(calls[1].job.recentContext, [], "history restarts with the new test");
  calls[1].gate.resolve({
    updates: [{ item_id: "fresh", status: "completed", confidence: 1, extracted_value: "yes" }],
    slotsFilled: { fresh: "yes" },
  });
  await queue.idle();
  assert.equal(updates.length, 1);
  assert.deepEqual(queue.getState().slotsFilled, { fresh: "yes" });
  assert.deepEqual(busy, [true, false]);
});
