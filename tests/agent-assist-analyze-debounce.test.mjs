import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("analyze effect marks transcriptions as analyzed only when dispatched, not before the debounce timer", async () => {
  const cmp = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  // The fired batch is reserved synchronously INSIDE analyzeIfNew: filter to
  // still-unmarked finals, then mark them all before any await/dispatch. This
  // both avoids dropping utterances (marking is not done before the timer) and
  // prevents a concurrent second batch from clobbering slots_filled.
  assert.match(
    cmp,
    /const batch = finalTranscriptionsToAnalyze\.filter\(\s*\n?\s*\(t\) => !analyzedTranscriptionIdsRef\.current\.has\(t\.id\)\s*\n?\s*\);\s*\n\s*for \(const t of batch\) analyzedTranscriptionIdsRef\.current\.add\(t\.id\);/
  );
  // Dispatch loop iterates the reserved batch.
  assert.match(cmp, /for \(const transcription of batch\) \{\s*\n\s*try \{/);

  // The old pre-timer marking loop (which dropped utterances when the timer
  // was cleared by rapid transcription updates) must be gone: there must be no
  // add() call that sits before setTimeout in the effect body.
  const effectStart = cmp.indexOf("// Analyze new transcriptions as they come in");
  const timerIdx = cmp.indexOf("setTimeout(analyzeIfNew", effectStart);
  const dispatchIdx = cmp.indexOf("analyzeIfNew = async", effectStart);
  assert.ok(effectStart > -1 && timerIdx > effectStart && dispatchIdx > effectStart);
  const beforeDispatch = cmp.slice(effectStart, dispatchIdx);
  assert.doesNotMatch(
    beforeDispatch,
    /analyzedTranscriptionIdsRef\.current\.add/,
    "no id should be marked analyzed before the analyzeIfNew dispatch loop"
  );
});
