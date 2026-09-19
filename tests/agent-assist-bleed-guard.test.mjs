import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("bleed guard prompt section is injected when bleedGuardSlot is provided", async () => {
  const src = await read("../lib/agent-assist/workflow-prompts.js");

  // buildWorkflowAnalysisSystemPrompt accepts bleedGuardSlot
  assert.match(src, /bleedGuardSlot = null/);

  // bleedGuardStr is built from bleedGuardSlot
  assert.match(src, /const bleedGuardStr = bleedGuardSlot/);
  assert.match(src, /Stray Fragment Guard/);
  assert.match(src, /bleedGuardSlot\.slotName/);
  assert.match(src, /bleedGuardSlot\.value/);

  // bleedGuardStr is included in the returned prompt
  assert.match(src, /\$\{bleedGuardStr\}/);
});

test("analyze route passes bleedGuardSlot derived from recently completed slots", async () => {
  const src = await read("../app/api/agent-assist/workflow/analyze/route.js");

  // Query fetches completed_at and extracted_value
  assert.match(src, /ist\.completed_at/);
  assert.match(src, /ist\.extracted_value as completed_value/);

  // BLEED_WINDOW_MS constant
  assert.match(src, /BLEED_WINDOW_MS/);

  // bleedGuardSlot is derived and passed to analyzeWorkflowTranscript
  assert.match(src, /bleedGuardSlot/);
  assert.match(src, /recentlyCompletedSlot/);

  // Numeric gate: bleed guard only fires for numeric/ordinal fragments, never
  // for clear boolean answers like "No" or "Yes"
  assert.match(src, /NUMERIC_FRAGMENT_RE/);
  assert.match(src, /isNumericFragment/);
});

test("analyzer forwards bleedGuardSlot to buildWorkflowAnalysisSystemPrompt", async () => {
  const src = await read("../lib/agent-assist/workflow-analyzer.js");

  assert.match(src, /bleedGuardSlot = null/);
  assert.match(src, /bleedGuardSlot,/);
});

// Codex review (on 0ca0274274): a batched multi-utterance request now shares
// ONE DB transaction across every utterance (see analyzeOneUtterance).
// Postgres's NOW()/CURRENT_TIMESTAMP is frozen at the TRANSACTION'S START
// time — the same value for every call within it — not the moment a given
// statement actually executes. If completed_at used NOW(), a slot completed
// partway through a slow multi-utterance batch (each utterance can involve
// several seconds of LLM latency) would be stamped with the batch's START
// time instead of its true completion moment. A LATER utterance in the same
// batch computing `Date.now() - completed_at` for the BLEED_WINDOW_MS
// freshness check (real JS wall-clock vs. that frozen timestamp) would then
// see an inflated age, silently defeating the guard exactly when the batch
// is slow enough to matter. clock_timestamp() advances with real wall-clock
// time even inside a single transaction, so it must be used for any
// completed_at write that can feed the bleed guard's completedSlotRows
// query (filtered to i.type = 'slot').
test("completed_at writes that feed the bleed guard use clock_timestamp(), not NOW() (transaction-safe under batching)", async () => {
  const src = await read("../app/api/agent-assist/workflow/analyze/route.js");

  // Auto-complete branch (high-confidence slot completion).
  assert.match(
    src,
    /SET status = 'completed',\s*\n\s*completed_at = clock_timestamp\(\),\s*\n\s*completed_by = \$1,\s*\n\s*extracted_value = \$2,/
  );
  // Read-back-confirmed correction-promotion sweep (readBackJustConfirmed).
  // Asserted as a property rather than a byte-exact statement: the column list
  // legitimately grows, but this write must keep advancing with wall-clock
  // time and must keep addressing one item of the current session.
  const promotion = src.match(
    /UPDATE aa_workflow_item_status\s*\n\s*SET status = 'completed',[\s\S]{0,400}?WHERE session_id = \$2 AND item_id = \$3`,\s*\n\s*\[speakerType \|\| "customer", workflowSession\.id, row\.item_id\]/
  );
  assert.ok(promotion, "the read-back promotion sweep must still exist");
  assert.match(promotion[0], /completed_at = clock_timestamp\(\)/);
  assert.doesNotMatch(promotion[0], /completed_at = NOW\(\)/);
  assert.match(promotion[0], /alternatives = NULL/);

  // Every item-status completion feeds the guard, so none of them may fall
  // back to NOW(). Session-level completion is a different table and is not
  // read by the freshness check.
  for (const statement of src.matchAll(/UPDATE aa_workflow_item_status[\s\S]{0,600}?`/g)) {
    assert.doesNotMatch(
      statement[0],
      /completed_at = NOW\(\)/,
      "an item-status completion must advance with wall-clock time",
    );
  }
});
