import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("analyze effect marks transcriptions as analyzed only when dispatched, not before the debounce timer", async () => {
  const cmp = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  // The invariant, independent of how the debounce is structured: an utterance
  // is recorded as analyzed only at dispatch time, after a re-check against
  // the latest transcript. Marking earlier drops utterances whose timer is
  // cleared by rapid updates; not marking at all lets a second batch clobber
  // slots_filled.
  const effectStart = cmp.indexOf("// Analyze new transcriptions as they come in");
  assert.ok(effectStart > -1, "the analyze effect must exist");
  const effectEnd = cmp.indexOf("useEffect(() => () => {", effectStart);
  const effect = cmp.slice(effectStart, effectEnd > -1 ? effectEnd : undefined);

  const dispatchStart = effect.indexOf("const timer = setTimeout(");
  assert.ok(dispatchStart > -1, "dispatch must be debounced by a timer");

  assert.doesNotMatch(
    effect.slice(0, dispatchStart),
    /analyzedTranscriptionIdsRef\.current\.set/,
    "no id may be marked analyzed before the debounced dispatch",
  );

  const dispatch = effect.slice(dispatchStart);
  const recheck = dispatch.indexOf("needsAnalyze(current)");
  const mark = dispatch.indexOf("analyzedTranscriptionIdsRef.current.set");
  assert.ok(recheck > -1, "dispatch must re-check the latest transcript");
  assert.ok(mark > -1, "dispatch must mark what it is about to analyze");
  assert.ok(recheck < mark, "the re-check must precede the marking");

  // The marked text is the one actually sent, so a grown bubble re-analyzes.
  assert.match(dispatch, /analyzedTranscriptionIdsRef\.current\.set\(current\.id, currentText\)/);
  assert.match(dispatch, /enqueueAnalysis\(\{/);
});

test("a cleared timer never leaves an utterance marked as analyzed", async () => {
  const cmp = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  // Timers are cleared when a bubble changes or disappears. Clearing must only
  // touch the pending map, never the analyzed-ids map, or the utterance is
  // silently lost.
  for (const clear of cmp.matchAll(/clearTimeout\([^)]*\);\s*\n\s*([^\n]*)/g)) {
    assert.doesNotMatch(
      clear[1],
      /analyzedTranscriptionIdsRef\.current\.set/,
      "clearing a debounce must not mark the utterance analyzed",
    );
  }
});
