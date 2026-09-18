import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// the reference workflow request: when the caller confirms the pickup facility IS the
// requesting facility (a transfer/dispatch center calling on behalf of the
// hospital it already gave as caller_facility), pickup_facility should be
// filled from caller_facility automatically instead of asking the caller to
// repeat the same name. The analyzer LLM can't do this copy itself: an
// already-completed slot's value is stripped from its prompt context
// entirely outside the read-back correction path, so caller_facility's
// value is invisible to the model while the Pickup Information stage is
// being analyzed.

function guardSection(route, startMarker, endMarker) {
  const start = route.indexOf(startMarker);
  const end = route.indexOf(endMarker);
  return route.slice(start, end);
}

const sixthSection = (route) => guardSection(route, "Sixth guard:", "Seventh guard:");
const seventhSection = (route) => guardSection(route, "Seventh guard:", "Process completed items");

test("sixth and seventh guards exist, in order, after the fifth guard and before completed-items processing", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const fifthIdx = route.indexOf("Fifth guard:");
  const sixthIdx = route.indexOf("Sixth guard:");
  const seventhIdx = route.indexOf("Seventh guard:");
  const processIdx = route.indexOf("Process completed items");
  assert.ok(fifthIdx > -1 && sixthIdx > fifthIdx, "sixth guard must be defined after the fifth guard");
  assert.ok(seventhIdx > sixthIdx, "seventh guard must be defined after the sixth guard");
  assert.ok(processIdx > seventhIdx, "seventh guard must run before completed-items processing");
});

test("sixth guard keys off the pickup_same_as_requesting_facility slot and a truthy answer", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = sixthSection(route);

  assert.match(section, /slot_name === "pickup_same_as_requesting_facility"/);
  assert.match(section, /return v === true \|\| \/\^\(true\|yes\)\$\/i\.test\(String\(v \?\? ""\)\);/);
});

test("sixth guard requires the confirmation to clear confidenceThreshold before copying (regression, Codex P1)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = sixthSection(route);

  assert.match(section, /if \(typeof c\.confidence === "number" && c\.confidence < confidenceThreshold\) return false;/);
});

// Reported live: the LLM extracted extracted_value: true at 0.85 confidence
// (above confidenceThreshold) for pickup_same_as_requesting_facility from
// the utterance "I want to transfer. One patient Talisis." - text with no
// relation to the question at all. This silently copied "Sutter Transfer
// Center" (the caller's own facility, a transfer center) onto
// pickup_facility, which then permanently could not resolve an address
// (transfer centers are structurally excluded from lookup_addresses),
// breaking the call with no visible error. The model's self-reported
// confidence isn't a reliable signal of genuine certainty for this
// high-consequence auto-copy.

test("sixth guard requires recognizable affirmative language before treating a truthy extracted_value as confirmed (regression, live bug)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = sixthSection(route);

  assert.match(
    section,
    /const AFFIRMATIVE_LANGUAGE_RE = \/\\b\(yes\|yeah\|yep\|yup\|correct\|right\|affirmative\|sure\|same\|it is\|we do\|that's it\|exactly\)\\b\/i;/
  );
  assert.match(section, /if \(AFFIRMATIVE_LANGUAGE_RE\.test\(transcript\) && !NEGATION_RE\.test\(transcript\)\) \{/);
});

// Codex review (round 3, P1): presence of an affirmative token alone isn't
// enough - "No, that's not the same facility" and "I'm not sure" both
// contain a listed word ("same", "sure") despite being denials. This guard
// exists specifically because the model's own true/false classification
// can't be trusted, so it can't assume the model got the surrounding
// negation right either. Any negation word blocks the copy outright, even
// alongside an affirmative token.

test("sixth guard also requires the absence of negation language, not just the presence of an affirmative token (regression, Codex P1 round 3)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = sixthSection(route);

  assert.match(
    section,
    /const NEGATION_RE = \/\\b\(no\|not\|never\|none\|nope\|nah\|negative\|different\|another\|separate\|elsewhere\)\\b\|n't\\b\/i;/
  );
});

test("NEGATION_RE correctly identifies denials that contain an affirmative-sounding token", () => {
  const NEGATION_RE = /\b(no|not|never|none|nope|nah|negative|different|another|separate|elsewhere)\b|n't\b/i;
  assert.ok(NEGATION_RE.test("No, that's not the same facility."));
  assert.ok(NEGATION_RE.test("I'm not sure."));
  assert.ok(NEGATION_RE.test("It isn't the same place."));
  assert.equal(NEGATION_RE.test("Yes, that's correct."), false);
});

// Codex review (round 4, P1): explicit no/not forms aren't the only way to
// deny sameness - "It is a different facility" and "It is over at another
// facility" both contain "it is" (an accepted affirmative phrase) while
// using NEITHER "no" nor "not" anywhere. These are semantic denials via
// contrast, not negation, and the previous NEGATION_RE would have let both
// through.

test("NEGATION_RE catches the exact live-reported contrast-word denials that contain no explicit no/not form", () => {
  const NEGATION_RE = /\b(no|not|never|none|nope|nah|negative|different|another|separate|elsewhere)\b|n't\b/i;
  assert.ok(NEGATION_RE.test("It is a different facility."));
  assert.ok(NEGATION_RE.test("It is over at another facility."));
  assert.ok(NEGATION_RE.test("It's a separate building."));
  assert.ok(NEGATION_RE.test("It's elsewhere, not with us."));
  // Must still accept genuine confirmations that don't mention a contrast.
  assert.equal(NEGATION_RE.test("Yes, it is the same facility."), false);
  assert.equal(NEGATION_RE.test("It is."), false);
});

// Codex review (round 2, P1): completed.source_text is generated by the
// SAME LLM call that produced the (possibly hallucinated) boolean and is
// never verified against what was actually said - checking it is not a
// real backstop, since a hallucinated "true" can come with an equally
// hallucinated supporting quote. The check must run against the TRUSTED
// transcript for this pass instead.
test("validates against the trusted transcript, not completed.source_text (regression, Codex P1 round 2)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = sixthSection(route);

  assert.doesNotMatch(section, /AFFIRMATIVE_LANGUAGE_RE\.test\(String\(c\.source_text/);
  assert.doesNotMatch(section, /AFFIRMATIVE_LANGUAGE_RE\.test\(String\(requestingFacilityRawCompletion\.source_text/);
});

// Codex review (round 2, P2): when the language check rejects a raw "true"
// completion, that completion must not be left to silently complete via
// the normal completed-items path with no copy - an already-completed
// boolean is never re-sent to the analyzer, so the copy could never be
// retried and the caller would have to repeat the facility name. It must
// be rejected outright (kept open) instead.
test("rejects (keeps retryable) a raw true completion that fails the language check, instead of letting it silently complete (regression, Codex P2 round 2)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = sixthSection(route);

  assert.match(section, /\} else \{/);
  assert.match(section, /bleedRejectedItemIds\.add\(requestingFacilityRawCompletion\.item_id\);/);
});

test("AFFIRMATIVE_LANGUAGE_RE correctly rejects the exact live false-positive utterance and accepts genuine affirmatives, including the broadened phrasings", async () => {
  const AFFIRMATIVE_LANGUAGE_RE = /\b(yes|yeah|yep|yup|correct|right|affirmative|sure|same|it is|we do|that's it|exactly)\b/i;
  assert.equal(AFFIRMATIVE_LANGUAGE_RE.test("I want to transfer. One patient Talisis."), false);
  assert.ok(AFFIRMATIVE_LANGUAGE_RE.test("Yes, that's correct."));
  assert.ok(AFFIRMATIVE_LANGUAGE_RE.test("Yeah, same facility."));
  assert.ok(AFFIRMATIVE_LANGUAGE_RE.test("That's right."));
  assert.ok(AFFIRMATIVE_LANGUAGE_RE.test("It is."));
  assert.ok(AFFIRMATIVE_LANGUAGE_RE.test("We do."));
  assert.ok(AFFIRMATIVE_LANGUAGE_RE.test("Exactly."));
});

test("sixth guard defers to a direct pickup_facility completion in the same response (regression, same pattern as guards 4/5)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = sixthSection(route);

  assert.match(
    section,
    /const pickupAlreadyCompletedDirectly = pickupFacilityItem\s*\n\s*\? \(analysisResult\.completed_items \|\| \[\]\)\.some\(\s*\n\s*\(c\) => c !== confirmedSame && c\.item_id === pickupFacilityItem\.item_id\s*\n\s*\)\s*\n\s*: false;/
  );
  assert.match(section, /if \(pickupFacilityItem && !pickupAlreadyCompletedDirectly\) \{/);
});

test("sixth guard uses a same-response caller_facility value directly when it's a first-time capture clearing threshold (regression, Codex P2)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = sixthSection(route);

  assert.match(section, /const isCorrection = callerFacilityItem\.current_status === "completed";/);
  assert.match(
    section,
    /const clearsThreshold =\s*\n\s*typeof callerFacilityCompletionThisPass\.confidence !== "number" \|\|\s*\n\s*callerFacilityCompletionThisPass\.confidence >= confidenceThreshold;/
  );
  assert.match(section, /if \(!isCorrection && clearsThreshold\) \{/);
  assert.match(section, /currentCallerFacility = callerFacilityCompletionThisPass\.extracted_value;/);
});

test("sixth guard falls back to a fresh DB read only when caller_facility isn't touched this pass (regression, Codex P1)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = sixthSection(route);

  assert.match(
    section,
    /SELECT slots_filled ->> 'caller_facility' AS caller_facility FROM aa_workflow_sessions WHERE id = \$1/
  );
  assert.match(section, /currentCallerFacility = freshRow\?\.caller_facility \?\? slotsFilled\.caller_facility;/);
});

test("sixth guard rejects (not silently drops) the confirmation when it can't safely copy, keeping the item open (regression, Codex P2)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = sixthSection(route);

  assert.match(section, /if \(!callerFacilityUnsettled && hasMeaningfulExtractedValue\(currentCallerFacility\)\) \{/);
  assert.match(section, /\} else \{/);
  assert.match(section, /bleedRejectedItemIds\.add\(confirmedSame\.item_id\);/);
  // The comment must not overclaim a seamless retry - buildWorkflowAnalysisUserPrompt
  // explicitly tells the model not to extract from prior "recent conversation" lines,
  // so a later pass does not silently reprocess this same utterance.
  assert.match(section, /this is NOT a seamless/);
  assert.match(section, /buildWorkflowAnalysisUserPrompt explicitly tells the/);
  assert.match(section, /model not to extract values from a transcript line/);
});

test("seventh guard resolves the now-moot comparison once pickup_facility has a value from elsewhere, so it never permanently blocks (regression, Codex P2)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = seventhSection(route);

  assert.match(
    section,
    /const requestingFacilityOpenItem = allPendingItems\.find\(\s*\n\s*\(i\) => i\.slot_name === "pickup_same_as_requesting_facility"\s*\n\s*\);/
  );
  assert.match(
    section,
    /if \(pickupHasValueThisPass \|\| hasMeaningfulExtractedValue\(slotsFilled\.pickup_facility\)\) \{/
  );
  assert.match(section, /extracted_value: false,/);
});

test("seventh guard does not re-fire when the boolean was already answered (with a non-rejected entry) in this same pass", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = seventhSection(route);

  assert.match(
    section,
    /const alreadyAnsweredThisPass = Boolean\(\s*\n\s*requestingFacilityOpenItem &&\s*\n\s*\(analysisResult\.completed_items \|\| \[\]\)\.some\(\s*\n\s*\(c\) => c\.item_id === requestingFacilityOpenItem\.item_id && !bleedRejectedItemIds\.has\(c\.item_id\)\s*\n\s*\)\s*\n\s*\);/
  );
  assert.match(section, /if \(requestingFacilityOpenItem && !alreadyAnsweredThisPass\) \{/);
});

// Codex review (round 3, P2): a completed_items entry the Sixth guard
// already rejected (bleedRejectedItemIds - a hallucinated "true" that
// failed the affirmative-language check) is skipped entirely in the
// completed-items loop, so it never actually answers anything. The
// PREVIOUS alreadyAnsweredThisPass check still counted it as "answered",
// which wrongly stopped this guard from resolving the boolean as moot even
// when pickup_facility was already resolved some other way in the exact
// same response - stranding it open forever.

test("seventh guard treats a rejected boolean completion as unanswered, so it can still resolve the item as moot", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = seventhSection(route);

  assert.match(section, /!bleedRejectedItemIds\.has\(c\.item_id\)/);
});

// Codex review (round 3, P2 follow-up): bleedRejectedItemIds is a Set of
// item_ids, not entry references. Simply appending a fresh "false" entry
// and deleting the item_id from that Set would ALSO un-reject the
// still-present, hallucinated "true" entry from the Sixth guard - exposing
// it to the completed-items loop instead of the intended "false". The
// existing entry must be overwritten in place, not left alongside a new one.

test("seventh guard overwrites an existing (rejected) completed_items entry in place rather than leaving a stale duplicate", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = seventhSection(route);

  assert.match(
    section,
    /const existingEntry = \(analysisResult\.completed_items \|\| \[\]\)\.find\(\s*\n\s*\(c\) => c\.item_id === requestingFacilityOpenItem\.item_id\s*\n\s*\);/
  );
  assert.match(section, /if \(existingEntry\) \{\s*\n\s*existingEntry\.extracted_value = false;/);
  assert.match(section, /bleedRejectedItemIds\.delete\(requestingFacilityOpenItem\.item_id\);/);
});

// Codex review (PR #1387, P1 x3): the synthesized pickup_facility copy had
// no provenance, so a later correction to caller_facility or to
// pickup_same_as_requesting_facility left it silently stale - feeding MCP
// lookup/dispatch with the wrong facility. Fixed with:
//  - a derived_from_slot marker column (migration below),
//  - the Sixth guard writing it AS PART OF the same atomic claim UPDATE
//    that persists the copy (not a separate pass, which could stamp a
//    manual edit that won the claim race instead - Codex P1),
//  - both manual-edit routes (item/[id]/complete, slot/[name]) clearing it
//    on any manual override (Codex P1), and
//  - a shared reconcileDerivedSlots() pass (see
//    tests/derived-slot-reconciliation.test.mjs for its behavior) called
//    from ALL THREE paths that can change either premise - not just the
//    transcript-analyze route (Codex P1: "premise-edit paths must perform
//    the same invalidation atomically").

test("postgres-schema.mjs adds the derived_from_slot column to aa_workflow_item_status", async () => {
  const schema = await read("../lib/postgres-schema.mjs");
  assert.match(
    schema,
    /ALTER TABLE aa_workflow_item_status ADD COLUMN IF NOT EXISTS derived_from_slot TEXT;/
  );
});

test("sixth guard's synthesized completion carries derived_from_slot ON the entry itself, written by the same atomic claim (regression, Codex P1)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const section = sixthSection(route);

  // No separate post-loop stamping pass or side-channel array - the value
  // travels with the completed_items entry so the SAME UPDATE that claims
  // status IN ('pending','suggested') also writes derived_from_slot.
  assert.match(section, /derived_from_slot: "caller_facility",/);
  assert.doesNotMatch(route, /derivedSlotStamps/);

  const updateBlockStart = route.indexOf("const { rowCount: autoCompleteClaimed }");
  assert.ok(updateBlockStart > -1);
  const updateBlock = route.slice(updateBlockStart, updateBlockStart + 900);
  assert.match(updateBlock, /derived_from_slot = \$7,/);
  assert.match(updateBlock, /completed\.derived_from_slot \?\? null,/);
  assert.match(updateBlock, /AND status IN \('pending', 'suggested'\)/);
});

test("any normal completion clears a stale derived_from_slot marker in analyze/route.js (regression, Codex P1)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // The main auto-complete UPDATE (parameterized, defaults to NULL via
  // completed.derived_from_slot ?? null) and the suggested-correction-
  // confirmation UPDATE (unconditional NULL) both clear it - any completion
  // through either path is, by definition, this item's own answer.
  assert.match(route, /derived_from_slot = \$7,/);
  assert.match(route, /alternatives = NULL, derived_from_slot = NULL, updated_at = NOW\(\)/);
});

test("analyze/route.js POST() calls the shared reconcileDerivedSlots instead of inlining the logic (regression, Codex P1)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(
    route,
    /import \{ reconcileDerivedSlots \} from "@\/lib\/agent-assist\/derived-slot-reconciliation\.mjs";/
  );
  assert.match(
    route,
    /const \{ updates: derivedUpdates \} = await reconcileDerivedSlots\(\{ client, sessionId: workflowSession\.id \}\);/
  );
});

test("manual item-complete route clears derived_from_slot on override and calls reconcileDerivedSlots atomically (regression, Codex P1)", async () => {
  const route = await read("../app/api/agent-assist/workflow/item/[id]/complete/route.js");
  assert.match(
    route,
    /import \{ reconcileDerivedSlots \} from "@\/lib\/agent-assist\/derived-slot-reconciliation\.mjs";/
  );
  assert.match(route, /is_manual_edit = TRUE,\s*\n\s*alternatives = NULL,\s*\n\s*derived_from_slot = NULL,/);
  assert.match(
    route,
    /const \{ updates: derivedUpdates \} = await reconcileDerivedSlots\(\{ client, sessionId: workflowSession\.id \}\);/
  );
  // Called before COMMIT, in the same transaction as the manual write.
  const reconcileIdx = route.indexOf("await reconcileDerivedSlots(");
  const commitIdx = route.indexOf('await client.query("COMMIT")');
  assert.ok(reconcileIdx > -1 && commitIdx > reconcileIdx, "must reconcile before COMMIT");
});

test("manual item-complete route demotes a completed session back to in_progress when reconciliation drops it below 100% (regression, Codex P1)", async () => {
  const route = await read("../app/api/agent-assist/workflow/item/[id]/complete/route.js");
  const ifIdx = route.indexOf("if (completionPercentage === 100) {");
  const commitIdx = route.indexOf('await client.query("COMMIT")', ifIdx);
  assert.ok(ifIdx > -1 && commitIdx > ifIdx);
  const block = route.slice(ifIdx, commitIdx);
  assert.match(block, /\} else \{/);
  assert.match(
    block,
    /SET status = 'in_progress', completed_at = NULL\s*\n\s*WHERE id = \$1 AND status = 'completed'/
  );
});

test("manual slot-update route clears derived_from_slot on override, calls reconcileDerivedSlots atomically, recalculates progress AFTER reconciliation, and demotes a stuck-completed session (regression, Codex P1/P2)", async () => {
  const route = await read("../app/api/agent-assist/workflow/slot/[name]/route.js");
  assert.match(
    route,
    /import \{ reconcileDerivedSlots \} from "@\/lib\/agent-assist\/derived-slot-reconciliation\.mjs";/
  );
  assert.match(route, /is_manual_edit = TRUE,\s*\n\s*alternatives = NULL,\s*\n\s*derived_from_slot = NULL,/);
  assert.match(
    route,
    /derivedUpdates = \(await reconcileDerivedSlots\(\{ client, sessionId: workflowSession\.id \}\)\)\.updates;/
  );

  // Reconciliation, THEN completion-percentage recalc, THEN COMMIT - in
  // that order, not percentage-before-reconciliation (Codex P2).
  const reconcileIdx = route.indexOf("await reconcileDerivedSlots(");
  const statsIdx = route.indexOf("COUNT(*) FILTER (WHERE status = 'completed') as completed");
  const commitIdx = route.indexOf('await client.query("COMMIT")');
  assert.ok(reconcileIdx > -1 && statsIdx > reconcileIdx, "completion percentage must be recalculated AFTER reconciliation");
  assert.ok(commitIdx > statsIdx, "must reconcile and recalculate before COMMIT");

  assert.match(
    route,
    /if \(completionPercentage < 100\) \{[\s\S]*?SET status = 'in_progress', completed_at = NULL[\s\S]*?WHERE id = \$1 AND status = 'completed'/
  );
});

test("manual slot-update route re-reads the full slots_filled document before marking the response authoritative (regression, Codex P2)", async () => {
  const route = await read("../app/api/agent-assist/workflow/slot/[name]/route.js");
  assert.match(
    route,
    /import \{ readSlotsFilled, runAndPersistSlotMcpBindings \} from "@\/lib\/agent-assist\/slot-mcp-execute";/
  );
  const derivedBlockIdx = route.lastIndexOf("if (derivedUpdates.length > 0) {");
  assert.ok(derivedBlockIdx > -1);
  const block = route.slice(derivedBlockIdx, derivedBlockIdx + 300);
  assert.match(block, /slotsFilled = await readSlotsFilled\(workflowSession\.id\);/);
  assert.match(block, /slotsFilledAuthoritative = true;/);
});

// Codex review (PR #1387, P1): a session RESTART reset is_manual_edit but
// left derived_from_slot untouched, and the independent prefill writers
// (call-flow "Workflow data prefill", AI handoff) never touched it either -
// a genuinely independent completion in the NEW session could inherit a
// stale marker from the PREVIOUS session and get wrongly reopened by
// reconciliation before the new run ever answers the comparison question.

test("session restart clears derived_from_slot alongside is_manual_edit", async () => {
  const route = await read("../app/api/agent-assist/workflow/start/route.js");
  assert.match(
    route,
    /is_manual_edit = FALSE, derived_from_slot = NULL,\s*\n\s*updated_at = NOW\(\)\s*\n\s*WHERE session_id = \$1/
  );
});

test("call-flow workflow-data-prefill completions clear derived_from_slot unconditionally", async () => {
  const route = await read("../app/api/agent-assist/workflow/start/route.js");
  const insertIdx = route.indexOf("for (const completion of workflowPrefill.itemCompletions)");
  assert.ok(insertIdx > -1);
  const insertBlock = route.slice(insertIdx, insertIdx + 2200);
  assert.match(insertBlock, /derived_from_slot = NULL,\s*\n\s*updated_at = NOW\(\)/);
});

test("AI handoff completions clear derived_from_slot unconditionally", async () => {
  const source = await read("../lib/agent-assist/ai-handoff-processor.js");
  assert.match(source, /derived_from_slot = NULL,\s*\n\s*updated_at = NOW\(\)/);
});

// Codex review (PR #1388, P1): reconcileDerivedSlots' optimistic-concurrency
// guard only works if EVERY writer of aa_workflow_sessions.slots_filled
// bumps slots_version - otherwise a stale reconciliation snapshot's version
// check passes anyway even though the document underneath it changed. Two
// writers in start/route.js (the session-restart reset and the call-flow
// prefill write) replaced/merged slots_filled without touching
// slots_version at all.

test("session restart bumps slots_version alongside the slots_filled reset (regression, Codex P1)", async () => {
  const route = await read("../app/api/agent-assist/workflow/start/route.js");
  assert.match(
    route,
    /slots_filled = CASE WHEN aa_workflow_sessions\.status = 'completed' THEN \$\d+::jsonb ELSE aa_workflow_sessions\.slots_filled END,\s*\n(?:[^\n]*\n)*?\s*slots_version = CASE WHEN aa_workflow_sessions\.status = 'completed' THEN COALESCE\(aa_workflow_sessions\.slots_version, 0\) \+ 1 ELSE aa_workflow_sessions\.slots_version END,/
  );
});

test("call-flow workflow-data-prefill's slots_filled merge bumps slots_version (regression, Codex P1)", async () => {
  const route = await read("../app/api/agent-assist/workflow/start/route.js");
  const idx = route.indexOf("SET slots_filled = COALESCE(slots_filled, '{}'::jsonb) || $2::jsonb,");
  assert.ok(idx > -1);
  const block = route.slice(idx, idx + 200);
  assert.match(block, /slots_version = COALESCE\(slots_version, 0\) \+ 1,/);
});

// Codex review (PR #1388, P1): a data-modifying-CTE design for making the
// session and item_status writes atomic turned out to be unsound - Postgres
// applies a CTE's UPDATE unconditionally, regardless of what the outer
// query's own WHERE clause matches, so the CTE's effects were NOT undone
// when the outer (session) write was rejected. Replaced with real row-level
// locking, deferred until a row is actually about to be written (Codex
// review, P2 round 2: locking every derived row up front - even no-op ones
// - wastes a lock and widens a deadlock window against callers with the
// opposite lock order). See tests/derived-slot-reconciliation.test.mjs for
// the full behavioral and structural coverage - not duplicated here.
