import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkflowAnalysisSystemPrompt } from "../lib/agent-assist/workflow-prompts.js";
import { mentionsCorrectionTrigger } from "../lib/agent-assist/readback.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

// an earlier fix: a captured slot must be correctable at ANY stage, not only during
// the final read-back. Before this, an already-completed slot was invisible to
// the analyzer everywhere except read-back, so a mid-call correction was
// silently dropped.

const completedSlot = {
  item_id: "pickup-facility",
  type: "slot",
  label: "Pickup facility name",
  slot_name: "pickup_facility",
  stage_name: "Pickup",
  current_status: "completed",
  completed_value: "Johnny Hospital",
  completion_trigger: "customer",
};

test("an explicit correction is recognized regardless of stage", () => {
  // These are what open the mid-call correction path.
  assert.equal(mentionsCorrectionTrigger("no wait, that's incorrect"), true);
  assert.equal(mentionsCorrectionTrigger("actually, it's John Mabry Hospital"), true);
  assert.equal(mentionsCorrectionTrigger("I want to change the pickup facility"), true);

  // A plain restatement must NOT — otherwise any later mention of a captured
  // value would reopen it, which is exactly the overwrite hazard the
  // read-back-only scope was protecting against.
  assert.equal(mentionsCorrectionTrigger("John Mabry Hospital"), false);
  assert.equal(mentionsCorrectionTrigger("yes, John Mabry, that's right"), false);
});

test("mid-call correction candidates get the same explicit-correction instructions as read-back", () => {
  const midCall = buildWorkflowAnalysisSystemPrompt({
    pendingItems: [completedSlot],
    slotsFilled: { pickup_facility: "Johnny Hospital" },
    allowCorrections: true,
  });

  assert.match(midCall, /Correction Handling/);
  assert.match(midCall, /ALREADY CONFIRMED/);
  assert.match(midCall, /"Johnny Hospital"/);
  assert.match(midCall, /EXPLICITLY states the existing value is wrong/);
  assert.match(midCall, /a missed correction is safer than a wrong overwrite/);

  // Read-back-specific rules must not leak into a mid-call correction.
  assert.doesNotMatch(midCall, /Final Confirmation Requires a Customer Affirmative/);
});

test("with no correction in play, a completed slot still gets no correction instructions", () => {
  const quiet = buildWorkflowAnalysisSystemPrompt({
    pendingItems: [completedSlot],
    slotsFilled: { pickup_facility: "Johnny Hospital" },
  });
  assert.doesNotMatch(quiet, /Correction Handling/);
});

test("the route only widens the candidate set behind an explicit trigger, and still never auto-applies", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");

  // The widening itself.
  assert.match(route, /const correctionsAllowed = isReadBackStage \|\| correctionRequested;/);

  // The guarantee that survives the widening: candidates come from the
  // completed-slot query, and without a trigger the set is empty, so a
  // completed slot stays out of the analyzer's view exactly as before.
  assert.match(
    route,
    /const correctionCandidateItems = correctionsAllowed\s*\n\s*\? completedSlotRows\.filter/,
  );

  // A returned correction is still surfaced as "suggested" pending
  // confirmation rather than silently overwriting slots_filled — this branch
  // keys on the item being completed, so it applies at every stage.
  assert.match(route, /if \(item\.current_status === "completed"\) \{/);

  // Corrections stay exempt from stage-distance narrowing, so a correction to
  // an early-stage slot survives even when the workflow has moved on.
  assert.match(
    route,
    /const narrowedAnalyzerItems = \[\.\.\.narrowedRelevantPendingItems, \.\.\.completedNotesItems, \.\.\.correctionCandidateItems\]/,
  );
});

// Codex review on #1353: a trigger left anywhere in the recent window kept
// every completed slot exposed turn after turn mid-call, so the customer's
// bare answer to the NEXT question read as a continuation of the earlier
// correction and could flip an already-correct slot back to suggested.
// Mid-call the window is now the current utterance plus the one before it.

function correctionRequested({ transcript, recentContext, isReadBackStage }) {
  const entries = Array.isArray(recentContext) ? recentContext : [];
  const window = isReadBackStage ? entries : entries.slice(-1);
  return (
    mentionsCorrectionTrigger(transcript) ||
    window.some((c) => mentionsCorrectionTrigger(c?.text))
  );
}

test("a mid-call correction expires once collection moves on", () => {
  // Turn 1 — the correction itself.
  assert.equal(
    correctionRequested({ transcript: "no, the pickup is wrong, it's John Mabry", recentContext: [] }),
    true,
  );

  // Turn 2 — STT mangled the corrected value, caller restates it bare. The
  // trigger is one utterance back, so the continuation still applies.
  assert.equal(
    correctionRequested({
      transcript: "John Mabry Hospital",
      recentContext: [{ text: "no, the pickup is wrong, it's John Mabry" }],
    }),
    true,
  );

  // Turn 3 — the agent has moved on and asks the next question. No trigger in
  // this utterance or the previous one.
  assert.equal(
    correctionRequested({
      transcript: "and what is the destination facility?",
      recentContext: [
        { text: "no, the pickup is wrong, it's John Mabry" },
        { text: "John Mabry Hospital" },
      ],
    }),
    false,
  );

  // Turn 4 — the customer's bare destination answer. This is the exact case
  // that could previously reopen the already-correct pickup slot.
  assert.equal(
    correctionRequested({
      transcript: "Northgate Presbyterian",
      recentContext: [
        { text: "no, the pickup is wrong, it's John Mabry" },
        { text: "John Mabry Hospital" },
        { text: "and what is the destination facility?" },
      ],
    }),
    false,
    "a stale correction trigger must not keep completed slots exposed while collection continues",
  );
});

test("read-back keeps the wider window it shipped with", () => {
  // Nothing is left to collect at read-back, so a trigger further back in the
  // window is still a live correction — unchanged from #1281.
  assert.equal(
    correctionRequested({
      transcript: "Northgate Presbyterian",
      recentContext: [
        { text: "no, that's incorrect" },
        { text: "let me read that back to you" },
        { text: "the destination facility" },
      ],
      isReadBackStage: true,
    }),
    true,
  );
});
