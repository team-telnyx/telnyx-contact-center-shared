import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mentionsCorrectionTrigger } from "../lib/agent-assist/readback.mjs";

// an earlier fix follow-up ("not fixed well enough", the reference workflow retest Aug 11): the agent's
// authority over slot values mid-call. Four defects, one theme — once a value
// was captured, neither the agent's own edit nor a spoken correction could
// reliably replace it:
//   1. a high-confidence correction rendered crossed-out with no confirm
//      affordance (UI recomputed review-worthiness from confidence < threshold,
//      ignoring the route's own low_confidence/is_correction flags),
//   2. the analyzer could overwrite an agent's manual edit (no completed_by
//      guard anywhere on its writes),
//   3. completeItem never synced the store's slotsFilled, so read-back and
//      dispatch prefills kept the pre-edit value,
//   4. mentionsCorrectionTrigger missed common correction phrasings, so the
//      correction window never opened.

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("correction phrasings verified missing in live testing now open the window", () => {
  const nowMatch = [
    "change the room number to 302",
    "update the room to 302",
    "let me update the room number",
    "let me fix that",
    "it's actually 302",
    "it should be 302",
    "the room needs to be changed",
    "make that 302",
    "scratch that",
    "I misspoke",
    "my bad",
    "sorry, 302 not 203",
    "302, not 203",
  ];
  for (const phrase of nowMatch) {
    assert.equal(mentionsCorrectionTrigger(phrase), true, `expected trigger: "${phrase}"`);
  }
});

test("everyday speech does not open the correction window", () => {
  const noMatch = [
    "everything is correct",
    "no need to change anything",
    "don't need to update it",
    "make sure to send the fax",
    "I am not sure",
    "the patient is stable",
    "thank you so much",
    "Stonemere Hospital.",
    "The technician facility name is John Miller.",
    // An apology plus ordinary uncertainty is NOT a value contrast (Codex
    // review on #1361): only "sorry, X not Y" where X is a value token opens
    // the window.
    "Sorry, I am not sure",
    "Sorry, I do not know the room number",
    "sorry, I'm not sure",
    "sorry, that's not necessary",
  ];
  for (const phrase of noMatch) {
    assert.equal(mentionsCorrectionTrigger(phrase), false, `false positive: "${phrase}"`);
  }
});

test("an apology with a genuine value contrast still opens the window", () => {
  assert.equal(mentionsCorrectionTrigger("sorry, Huron not Hearne"), true);
  assert.equal(mentionsCorrectionTrigger("sorry, it was 302 not 203"), true);
});

// Reported live: caller repeated "No, pickup facility is Delta" and "Pickup
// facility name is not Sutter Amador Surgery Center" across FIVE separate
// utterances trying to correct a wrong pickup_facility value already
// completed. None matched any pattern above (the existing "no, wait/
// actually" pattern requires one of those two exact words right after
// "no"), so the correction window never opened and the bare restated value
// ("Delta") instead landed on the nearest unrelated open slot
// (pickup_department).
test("'No, <field> is <value>' and '<field> is not <value>' open the correction window (regression, live bug)", () => {
  assert.equal(mentionsCorrectionTrigger("No. Pickup facility is delta."), true);
  assert.equal(mentionsCorrectionTrigger("No, pickup facility is delta"), true);
  assert.equal(
    mentionsCorrectionTrigger("Pickup facility name is not Sutter, Amador Surgery Center."),
    true
  );
  assert.equal(mentionsCorrectionTrigger("The pickup facility isn't correct."), true);
  // A bare "No." alone (answering an open yes/no slot) must NOT open the
  // correction window - only a leading "no" WITH a later restatement does.
  assert.equal(mentionsCorrectionTrigger("No."), false);
  assert.equal(mentionsCorrectionTrigger("No"), false);
});

// Codex review (PR #1391, P2 x2): mentionsCorrectionTrigger feeds
// findCorrectionTargetSlot in suggestion-target-resolver.mjs directly, with
// NO other gate protecting against a false positive there (unlike the
// analyze-route correction path, which additionally requires the LLM to
// explicitly agree a value is wrong). "No, the pickup facility is
// operational" and "The patient is not on oxygen" both matched the round-3
// patterns despite being ordinary descriptive statements, not value
// corrections - which would have hijacked the suggestion panel with a
// bogus "please confirm the pickup facility" prompt mid-call.
test("descriptive/state statements using the same is/is-not shape as a correction do NOT open the window (regression, Codex P2)", () => {
  const noMatch = [
    "No, the pickup facility is operational.",
    "No, the room is ready.",
    "No, the facility is open.",
    "The pickup facility isn't available on Sunday.",
    "The patient is not on oxygen.",
    "The room isn't ready yet.",
  ];
  for (const phrase of noMatch) {
    assert.equal(mentionsCorrectionTrigger(phrase), false, `false positive: "${phrase}"`);
  }
  // Genuine corrections using the SAME sentence shape must still trigger.
  assert.equal(mentionsCorrectionTrigger("No, the pickup facility is Delta."), true);
  assert.equal(mentionsCorrectionTrigger("The pickup facility is not Sutter General."), true);
});

// Codex review (PR #1391, round 3, 3 findings, all confirmed live):
//   1. "scheduled" was on the excluded-predicate list, but it's also a real,
//      configured transport_timing value - "No, transport timing is
//      scheduled" is a GENUINE correction the list wrongly excluded.
//   2. An adverb between "is" and the predicate ("is currently operational",
//      "is definitely ready") defeated the exclusion entirely - the
//      lookahead only ever inspected the token immediately after "is".
//   3. findCorrectionTargetSlot in suggestion-target-resolver.mjs calls this
//      function with up to the last 8 transcripts joined with " \n"
//      (latestConversationText), not one utterance. A bare ^ (no multiline
//      flag) only matched the very start of that whole blob, so a genuine
//      "No, <field> is <value>" correction was recognized only when it
//      happened to be the very first of the last 8 lines.
test("modifier words, a genuine 'scheduled' value, and multi-utterance blobs are all handled (regression, Codex round 3)", () => {
  // Finding 1: "scheduled" is a real slot value, not a descriptive predicate.
  assert.equal(mentionsCorrectionTrigger("No, transport timing is scheduled."), true);

  // Finding 2: a modifier adverb between "is" and the predicate must not
  // defeat the descriptive-statement exclusion.
  const stillNoMatch = [
    "No, the pickup facility is currently operational.",
    "No, the room is definitely ready.",
    "The pickup facility isn't currently available.",
  ];
  for (const phrase of stillNoMatch) {
    assert.equal(mentionsCorrectionTrigger(phrase), false, `false positive: "${phrase}"`);
  }
  // A modifier preceding a genuine value must still trigger - only the
  // excluded predicate words are gated, not modifiers in general.
  assert.equal(mentionsCorrectionTrigger("No, the pickup facility is actually Delta."), true);

  // Finding 3: a correction buried mid-blob (not the first line) must still
  // be recognized when joined the same way suggestion-target-resolver.mjs's
  // latestConversationText joins the last 8 transcripts.
  const blobWithCorrection = [
    "Patient's first name is Michael.",
    "The transport is scheduled for tomorrow.",
    "No, pickup facility is Delta.",
  ].join(" \n");
  assert.equal(mentionsCorrectionTrigger(blobWithCorrection), true);

  const blobWithoutCorrection = [
    "The room is currently available.",
    "The patient is stable.",
  ].join(" \n");
  assert.equal(mentionsCorrectionTrigger(blobWithoutCorrection), false);
});

test("UI: review state comes from the analyzer's flags, not only a local confidence comparison", async () => {
  const cmp = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  // Both computations (snapshot + render) accept the route's own flags. A
  // 0.97-confidence correction with a 0.95 threshold must still show the
  // amber Confirm affordance.
  const flagGate = /status\.low_confidence === true \|\|\s*\n?\s*status\.is_correction === true \|\|/g;
  const hits = cmp.match(flagGate) || [];
  assert.ok(hits.length >= 2, `expected the flag gate in snapshot AND render, found ${hits.length}`);
});

test("UI: a suggested status wins over the slots_filled fallback, so a pending correction un-crosses", async () => {
  const cmp = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  // Old form crossed the row out because slots_filled still holds the OLD
  // value while the correction is pending.
  assert.doesNotMatch(
    cmp,
    /const isCompleted = status\.status === "completed" \|\| isSlotFilledFromWorkflowState\(item, slotsFilled\);/
  );
  const suggestedWins = cmp.match(/!isSuggested && isSlotFilledFromWorkflowState\(item, slotsFilled\)/g) || [];
  assert.ok(suggestedWins.length >= 2, `expected the suggested-wins guard in snapshot AND render, found ${suggestedWins.length}`);
  // And the pending correction is labeled for the agent.
  assert.match(cmp, /isSuggested && status\.is_correction === true && \(/);
  assert.match(cmp, />\s*Correction\s*</);
});

test("analyzer: MANUALLY-edited slots are excluded from correction candidates, spoken captures stay correctable", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // A manual edit is identified by is_manual_edit=TRUE, set ONLY by the
  // manual complete/slot routes — NOT inferred from completed_by='agent' +
  // confidence_score=1. That pair is not unique to a manual edit: the
  // auto-complete branch can ALSO write completed_by='agent' (the agent
  // SPOKE the value) with an LLM confidence of exactly 1.0 for an
  // unambiguous utterance, which a confidence-based heuristic cannot tell
  // apart from a manual edit and would wrongly block it from ever being
  // corrected again.
  assert.match(route, /const isManualAgentRow = \(row\) => row\?\.is_manual_edit === true;/);
  assert.match(route, /!isAccumulatingSlot\(it\) && !isManualAgentRow\(it\)/);
  assert.doesNotMatch(route, /it\.completed_by !== "agent"/);
  assert.doesNotMatch(route, /Number\(row\?\.confidence_score \?\? 1\) >= 1/);
  // The candidate query selects the marker column so the filter has data.
  assert.match(route, /ist\.status as current_status, ist\.completed_by, ist\.confidence_score, ist\.is_manual_edit,/);
});

// Reported/verified this session: completed_by='agent' + confidence_score=1
// is NOT unique to a manual edit — the auto-complete branch writes exactly
// that pair when the AGENT SPOKE a value and the LLM's own confidence clamp
// (Math.min(1, Math.max(0, item.confidence))) permits an unambiguous
// extraction to score exactly 1.0. A confidence-based isManualAgentRow would
// wrongly treat that spoken slot as a manual edit and block it from ever
// being corrected again — the exact an earlier fix symptom, reintroduced for this
// narrower case. The is_manual_edit column is set ONLY by the two manual
// routes, so it cannot be confused with a spoken capture regardless of the
// LLM's reported confidence.
test("isManualAgentRow: an agent-SPOKEN slot at confidence 1.0 is NOT treated as a manual edit", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // Confirms the exact predicate in the route (also pinned by the sibling
  // "MANUALLY-edited slots" test above), then exercises the SAME logic
  // directly against both real-world row shapes.
  assert.match(route, /const isManualAgentRow = \(row\) => row\?\.is_manual_edit === true;/);
  const isManualAgentRow = (row) => row?.is_manual_edit === true;

  // Agent-SPOKEN capture: auto-complete branch wrote completed_by='agent'
  // with the LLM's own (maximal) confidence — is_manual_edit stays FALSE,
  // the column's default, because that branch never touches it.
  assert.equal(
    isManualAgentRow({ completed_by: "agent", confidence_score: 1, is_manual_edit: false }),
    false,
    "an agent-spoken value at confidence 1.0 must remain correctable"
  );
  // Actual manual edit: the manual routes set is_manual_edit=TRUE alongside
  // the same completed_by/confidence_score pair.
  assert.equal(
    isManualAgentRow({ completed_by: "agent", confidence_score: 1, is_manual_edit: true }),
    true,
    "a manually-typed value must stay protected"
  );
});

test("manual routes set is_manual_edit=TRUE so the analyzer can tell a typed edit apart from a spoken one", async () => {
  const completeRoute = await read("../app/api/agent-assist/workflow/item/[id]/complete/route.js");
  const slotRoute = await read("../app/api/agent-assist/workflow/slot/[name]/route.js");
  assert.match(completeRoute, /is_manual_edit = TRUE,/);
  assert.match(slotRoute, /is_manual_edit = TRUE,/);
});

test("analyzer: every status write is guarded so an agent action during the LLM window survives", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // Correction branch refuses manual rows at the SQL level, keyed on the
  // same is_manual_edit column isManualAgentRow uses in JS.
  assert.match(route, /AND is_manual_edit IS NOT TRUE/);
  assert.doesNotMatch(route, /AND NOT \(completed_by = 'agent' AND COALESCE\(confidence_score, 1\) >= 1\)/);
  assert.doesNotMatch(route, /AND completed_by IS DISTINCT FROM 'agent'/);
  assert.match(route, /if \(correctionClaimed === 0\) continue;/);
  // Auto-complete and suggest branches refuse rows no longer pending/suggested
  // (an agent completed them mid-window), and a refused write is dropped from
  // the response instead of being reported to the client.
  const statusGuards = route.match(/AND status IN \('pending', 'suggested'\)/g) || [];
  assert.ok(statusGuards.length >= 2, `expected status guards on auto-complete and suggest branches, found ${statusGuards.length}`);
  assert.match(route, /if \(autoCompleteClaimed === 0\) continue;/);
  assert.match(route, /if \(suggestClaimed === 0\) continue;/);
});

test("analyzer: the response never carries the request-start slots snapshot", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // Empty-delta path re-reads the live row before responding, so a manual
  // edit committed during the LLM window is what the client receives.
  assert.match(route, /No delta from this batch/);
  const freshReads = route.match(/SELECT slots_filled FROM aa_workflow_sessions WHERE id = \$1/g) || [];
  assert.ok(freshReads.length >= 2, `expected fresh re-reads on both batch paths, found ${freshReads.length}`);
});

test("store: completeItem mirrors the edit into slotsFilled and stamps the edit time", async () => {
  const store = await read("../lib/stores/workflow-store.js");
  assert.match(store, /_agentItemEdits/);
  assert.match(store, /_agentSlotEdits/);
  // The slot map is updated with the agent's value (read-back + dispatch read it).
  assert.match(store, /get\(\)\.updateSlot\(slotItem\.slot_name, value\);/);
});

test("store: a stale in-flight analyze response cannot revert an agent edit", async () => {
  const store = await read("../lib/stores/workflow-store.js");
  assert.match(store, /const requestStartedAt = Date\.now\(\);/);
  // Item updates are skipped when the agent edited after the request began.
  assert.match(store, /\(agentItemEdits\[update\.item_id\] \|\| 0\) > requestStartedAt/);
  // Slot merges drop agent-edited keys the same way.
  assert.match(store, /editedAt > requestStartedAt && slot in incoming/);
});

test("store: updateSlotValue also updates the item status so the checklist follows", async () => {
  const store = await read("../lib/stores/workflow-store.js");
  const idx = store.indexOf("updateSlotValue: async");
  assert.ok(idx > -1);
  const body = store.slice(idx, idx + 3000);
  assert.match(body, /updateItemStatus\(slotItem\.id, \{/);
  assert.match(body, /completed_by: "agent"/);
});

test("analyzer: name-reconciliation clears is_manual_edit along with the rest of the slot (Codex P2 on #1363)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // Reopening a slot for re-collection must not leave a stale TRUE behind —
  // otherwise whatever gets captured next (even a plain spoken value) would
  // be wrongly protected from correction forever.
  assert.match(
    route,
    /alternatives = NULL, completed_by = NULL, is_manual_edit = FALSE, updated_at = NOW\(\)/
  );
});

test("start route: restarting a completed session also clears is_manual_edit (Codex P2 on #1363)", async () => {
  const route = await read("../app/api/agent-assist/workflow/start/route.js");
  // A prior manual edit from the ENDED session must not protect whatever
  // gets captured for that slot in the fresh run, whether spoken, prefilled,
  // or edited again.
  assert.match(
    route,
    /source_transcript = NULL, is_manual_edit = FALSE, derived_from_slot = NULL,\s*\n\s*updated_at = NOW\(\)/
  );
});

test("fresh schema materializes the manual-edit marker without a migration ledger", async () => {
  const schema = await read("../lib/postgres-schema.mjs");
  assert.match(
    schema,
    /ALTER TABLE aa_workflow_item_status ADD COLUMN IF NOT EXISTS is_manual_edit BOOLEAN NOT NULL DEFAULT FALSE;/
  );
  assert.doesNotMatch(schema, /aa_schema_backfills/);
  assert.doesNotMatch(schema, /aa_workflow_item_status_is_manual_edit_backfill/);
});

test("server: the slot route persists an edit to an already-completed item (Codex P1 on #1361)", async () => {
  const route = await read("../app/api/agent-assist/workflow/slot/[name]/route.js");
  // The old `AND status = 'pending'` guard silently skipped the exact rows an
  // agent edits — completed (crossed-out) and suggested ones — so the stale
  // extracted_value survived every refresh and the analyzer still treated the
  // row as AI-owned.
  assert.doesNotMatch(route, /AND item_id = \$3 AND status = 'pending'/);
  assert.match(route, /completed_by = 'agent',/);
  assert.match(route, /confidence_score = 1\.0,/);
  // And the session write merges only the edited key instead of writing back
  // a stale whole-object snapshot.
  assert.match(route, /SET slots_filled = COALESCE\(slots_filled, '\{\}'::jsonb\) \|\| \$1::jsonb/);
  assert.doesNotMatch(route, /SET slots_filled = \$1, updated_at/);
});
