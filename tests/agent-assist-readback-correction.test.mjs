import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildWorkflowAnalysisSystemPrompt } from "../lib/agent-assist/workflow-prompts.js";
import { mentionsCorrectionTrigger, matchesReadBackAffirmativeHints } from "../lib/agent-assist/readback.mjs";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Reproduces: at the final read-back ("We're transferring Mike Anderson...
// from Saint Mary's Hospital ... to Johnny Hospital ...") the caller says
// "destination facility name is incorrect, change it to John Muir Hospital."
// Before this feature, an already-completed slot was excluded from the
// analyzer entirely (see the pending-items query: only status IN ('pending',
// 'suggested')), so the LLM never even saw destination_facility_name as a
// candidate and the correction was silently dropped.

test("buildWorkflowAnalysisSystemPrompt adds the correction section ONLY at the read-back stage", () => {
  const completedItem = {
    item_id: "dest-facility",
    type: "slot",
    label: "Destination facility name",
    slot_name: "destination_facility",
    stage_name: "Destination",
    current_status: "completed",
    completed_value: "Johnny Hospital",
    completion_trigger: "customer",
  };

  const readBackPrompt = buildWorkflowAnalysisSystemPrompt({
    pendingItems: [completedItem],
    slotsFilled: { destination_facility: "Johnny Hospital" },
    isReadBackStage: true,
  });
  assert.match(readBackPrompt, /Correction Handling \(Read-Back Stage\)/);
  assert.match(readBackPrompt, /ALREADY CONFIRMED/);
  assert.match(readBackPrompt, /"Johnny Hospital"/);
  assert.match(readBackPrompt, /EXPLICITLY states the existing value is wrong/);

  // Same already-completed item, but NOT flagged as the read-back stage (the
  // default/every-other-stage case) — the correction section must not appear,
  // even though the item itself is still annotated as already confirmed.
  const midCallPrompt = buildWorkflowAnalysisSystemPrompt({
    pendingItems: [completedItem],
    slotsFilled: { destination_facility: "Johnny Hospital" },
  });
  assert.doesNotMatch(midCallPrompt, /Correction Handling/);
  // The "already confirmed" item annotation is independent of stage — it only
  // depends on the item being marked completed with a value, so it still shows.
  assert.match(midCallPrompt, /ALREADY CONFIRMED/);
});

test("correction section always includes phonetic-mishearing tolerance", () => {
  const prompt = buildWorkflowAnalysisSystemPrompt({
    pendingItems: [{
      item_id: "dest-facility",
      type: "slot",
      label: "Destination facility name",
      slot_name: "destination_facility",
      stage_name: "Destination",
      current_status: "completed",
      completed_value: "Johnny Hospital",
    }],
    slotsFilled: { destination_facility: "Johnny Hospital" },
    isReadBackStage: true,
  });
  assert.match(prompt, /phonetic-mishearing tolerance/);
  // No continuation leniency unless correctionInProgress is also set.
  assert.doesNotMatch(prompt, /A correction is already in progress/);
});

// Reproduces the live regression: STT mangled "John Muir Hospital" into a
// different name on each retry ("Twin Hill", "Stonemere", "John Miller",
// "Tornio"). Only the utterance that repeated an explicit correction trigger
// ("First mission facility is Stonemere Hospital" — following "that's not
// correct... incorrect") got applied; later bare restatements of yet another
// garbled name were dropped because they didn't repeat the trigger phrase.
test("correctionInProgress adds continuation leniency for a bare restated value", () => {
  const prompt = buildWorkflowAnalysisSystemPrompt({
    pendingItems: [{
      item_id: "dest-facility",
      type: "slot",
      label: "Destination facility name",
      slot_name: "destination_facility",
      stage_name: "Destination",
      current_status: "completed",
      completed_value: "Johnny Hospital",
    }],
    slotsFilled: { destination_facility: "Johnny Hospital" },
    isReadBackStage: true,
    correctionInProgress: true,
  });
  assert.match(prompt, /A correction is already in progress/);
  assert.match(prompt, /WITHOUT repeating "that's wrong" again/);
});

test("mentionsCorrectionTrigger matches explicit correction language, not plain restatements", () => {
  assert.equal(mentionsCorrectionTrigger("No. That's not correct. Uh, decision facility is incorrect."), true);
  assert.equal(mentionsCorrectionTrigger("Please change it to John Muir Hospital."), true);
  assert.equal(mentionsCorrectionTrigger("Actually, it's John Muir Hospital."), true);
  // A bare restated value (the continuation case) does NOT itself count as a
  // new trigger — continuation leniency comes from a trigger EARLIER in
  // recentContext, not from re-matching on every subsequent utterance.
  assert.equal(mentionsCorrectionTrigger("Stonemere Hospital."), false);
  assert.equal(mentionsCorrectionTrigger("The technician facility name is John Miller."), false);
});

test("live analyze route only re-includes completed slots as correction candidates at the read-back stage", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");

  // Detection reuses the same isReadBackItem helper already used to keep the
  // read-back item open, checked against ANY currently-pending item — but
  // gated on every slot ALSO being collected. A read-back item (e.g. "Confirm
  // all information is correct") stays pending for the entire call, so
  // without the "no slot-type item is pending" clause this would be true from
  // the very first utterance, re-including every completed slot as a
  // correction candidate the whole call (this exact bug caused a pickup-stage
  // address utterance to bleed into destination_facility — destination_facility
  // was in view as a "correction candidate" while pickup was still in progress).
  //
  // A pending/suggested slot with a value ALREADY in slots_filled is exempt —
  // that's a correction awaiting confirmation, not a genuine open gap. Without
  // this, confirming one correction (e.g. date of birth) would flip
  // isReadBackStage back to false and hide every OTHER slot from being
  // corrected until that one confirmation resolved — only one correction could
  // ever be in flight at a time.
  assert.match(
    route,
    /const isReadBackStage =\s*\n\s*!pendingItems\.some\(\s*\n\s*\(item\) => item\.type === "slot" && !hasMeaningfulExtractedValue\(slotsFilled\[item\.slot_name\]\)\s*\n\s*\) &&\s*\n\s*pendingItems\.some\(\(item\) =>/
  );

  // Gated on isReadBackStage; excludes accumulating notes slots (those already
  // have their own always-on re-inclusion via completedNotesItems).
  assert.match(
    route,
    /const correctionCandidateItems = isReadBackStage\s*\n\s*\? completedSlotRows\.filter\(\(it\) => !isAccumulatingSlot\(it\)\)\s*\n\s*: \[\];/
  );

  // Included in both the lookup list (analyzerItems) and the LLM-facing list
  // (narrowedAnalyzerItems), unaffected by stage-distance narrowing — a
  // correction to an early-stage slot must stay visible even once
  // currentStageOrder sits at the final Confirmation stage.
  assert.match(route, /const analyzerItems = \[\.\.\.relevantPendingItems, \.\.\.completedNotesItems, \.\.\.correctionCandidateItems\]/);
  assert.match(route, /const narrowedAnalyzerItems = \[\.\.\.narrowedRelevantPendingItems, \.\.\.completedNotesItems, \.\.\.correctionCandidateItems\]/);

  // Passed through to the analyzer so the prompt can gate the correction
  // instructions on it.
  assert.match(route, /isReadBackStage,\s*\n\s*correctionInProgress,\s*\n\s*recentContext:/);

  // correctionInProgress: a correction trigger phrase ("incorrect", "change
  // it", ...) in this utterance OR a recent one, only while at read-back.
  assert.match(route, /const correctionInProgress =\s*\n\s*isReadBackStage &&/);
  assert.match(route, /mentionsCorrectionTrigger\(transcript\)/);
  assert.match(route, /recentContext\.some\(\(c\) => mentionsCorrectionTrigger\(c\?\.text\)\)/);
});

test("workflow-analyzer threads isReadBackStage and correctionInProgress through to the prompt builder", async () => {
  const source = await read("../lib/agent-assist/workflow-analyzer.js");
  assert.match(source, /isReadBackStage = false,/);
  assert.match(source, /correctionInProgress = false,/);
  assert.match(source, /isReadBackStage,\s*\n\s*correctionInProgress,\s*\n\s*bleedGuardSlot,/);
});

test("a correction is ALWAYS surfaced as suggested (highlighted, pending confirmation), never silently auto-completed or silently dropped", async () => {
  // Reproduces the live report: "We need to change it to destination
  // facility... Stonemere" scored 0.92 confidence (above threshold) and was
  // auto-applied as the new "completed" value — silently replacing a correct
  // value with a garbled one, with no visible flag that anything had changed
  // ("Interaction Details are moving but nothing changed"). Confidence alone
  // isn't a reliable signal for a correction, so every correction — regardless
  // of confidence — must go through "suggested" (the existing confirm-chip
  // UI), not straight to "completed". This also supersedes the earlier fix
  // that dropped low-confidence corrections outright: dropping silently left
  // the agent unaware anything was attempted at all; surfacing it as
  // "suggested" is strictly more informative without the auto-apply risk.
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");

  const correctionBranchIndex = route.indexOf('if (item.current_status === "completed") {');
  assert.notEqual(correctionBranchIndex, -1, "the correction-candidate branch must exist");

  const autoCompleteIndex = route.indexOf("if (completed.confidence >= confidenceThreshold) {");
  assert.ok(
    correctionBranchIndex < autoCompleteIndex,
    "the correction branch must run BEFORE the generic auto-complete branch, so a correction candidate never reaches it"
  );

  // The correction branch itself, up to its own closing `continue`, must not
  // contain a confidence-threshold gate — every correction is treated the
  // same way regardless of how confident the model was.
  const isCorrectionIndex = route.indexOf("is_correction: true", correctionBranchIndex);
  const continueIndex = route.indexOf("continue;", isCorrectionIndex);
  const correctionBranchSource = route.slice(correctionBranchIndex, continueIndex);
  // confidence_threshold is still recorded as a data field (for the UI), but
  // there must be no confidence COMPARISON gating which branch runs.
  assert.doesNotMatch(correctionBranchSource, /completed\.confidence\s*[<>=]/);
  assert.match(correctionBranchSource, /status = 'suggested'/);
  assert.match(correctionBranchSource, /completed_at = NULL/);
  assert.match(correctionBranchSource, /is_correction: true/);
});

test("suggestion-target-resolver targets a named completed slot for correction, and the suggestion route has a deterministic line for it", async () => {
  // Companion to the analyze-side correction handling above: once the value
  // itself can be corrected, the SUGGESTED RESPONSE side also needs to ask
  // "what should it be?" for that specific slot instead of falling back to
  // the read-back item's own generic/LLM-improvised line (reported live as
  // "I apologize for the confusion... What information needs to be fixed?"
  // — never mentioning the slot at all).
  const resolverSource = await read("../lib/agent-assist/suggestion-target-resolver.mjs");
  assert.match(resolverSource, /import \{ mentionsCorrectionTrigger, isReadBackItem \} from "\.\/readback\.mjs";/);
  assert.match(resolverSource, /function findCorrectionTargetSlot\(/);
  assert.match(resolverSource, /mode: "collect_correction"/);
  assert.match(resolverSource, /reason: "correction_requested"/);
  // Gated on leadStageOrder === null (every slot filled) — corrections are
  // only meaningful once normal collection is done, same scope as the
  // analyze-side correction handling (read-back stage only).
  assert.match(
    resolverSource,
    /if \(leadStageOrder === null && !readBackAlreadyConfirmed\(stages, itemStatuses\)\) \{\s*\n\s*const correctionTarget = findCorrectionTargetSlot/
  );

  const suggestionRoute = await read("../app/api/agent-assist/workflow/generate-suggestion/route.js");
  assert.match(suggestionRoute, /targetMode === "collect_correction"/);
  assert.match(suggestionRoute, /What should it be instead/);
});

test("confirm_slot for a correction shows the NEW proposed value, not the stale old one still in slots_filled", async () => {
  // Once a correction is captured, it's surfaced as "suggested" (see the
  // always-suggested test above) — which routes through the EXISTING
  // confirm_slot flow. But slots_filled still holds the OLD value (a
  // "suggested" item is deliberately not written to slots_filled until
  // confirmed), so without this fix capturedSlotValue would tell the agent to
  // confirm the stale value being corrected, not the new one awaiting
  // confirmation. Must NOT disturb the existing, separately-tested case where
  // slots_filled legitimately holds a MORE RECENT agent-corrected value than
  // a stale itemStatus.extracted_value (a completely different scenario —
  // see "confirm slot suggestions prefer corrected filled slot values over
  // stale suggested captures" in agent-assist-suggestion-target-contract.test.mjs).
  const suggestionRoute = await read("../app/api/agent-assist/workflow/generate-suggestion/route.js");
  assert.match(suggestionRoute, /if \(itemStatus\?\.is_correction\) \{/);

  const storeSource = await read("../lib/stores/workflow-store.js");
  assert.match(storeSource, /is_correction: update\.is_correction === true,/);
});

test("the final 'confirm all information is correct' item requires the CUSTOMER's own affirmative, not the agent's recitation", () => {
  // Without this, the item's completion_trigger was "agent" with empty hints
  // — meaning it could complete the moment the agent recited the read-back
  // script (which itself contains the words "is that correct?"), well before
  // the customer ever actually confirmed anything. That would move the
  // workflow past read-back prematurely, so a later correction would never
  // trigger a re-read-back of the updated summary.
  const prompt = buildWorkflowAnalysisSystemPrompt({
    pendingItems: [{
      item_id: "confirm-all",
      type: "question",
      label: "Confirm all information is correct",
      stage_name: "Confirmation",
      current_status: "pending",
    }],
    slotsFilled: {},
    isReadBackStage: true,
  });
  assert.match(prompt, /Final Confirmation Requires a Customer Affirmative/);
  assert.match(prompt, /ONLY when the CUSTOMER gives a clear, unambiguous affirmative/);
  assert.match(prompt, /The agent's own recitation of the read-back script/);
  assert.match(prompt, /A correction request/);

  // Not present outside the read-back stage.
  const midCallPrompt = buildWorkflowAnalysisSystemPrompt({
    pendingItems: [{
      item_id: "confirm-all",
      type: "question",
      label: "Confirm all information is correct",
      stage_name: "Confirmation",
      current_status: "pending",
    }],
    slotsFilled: {},
  });
  assert.doesNotMatch(midCallPrompt, /Final Confirmation Requires a Customer Affirmative/);
});

test("the read-back suggestion's client-side dedup key includes the merged (slots_filled + pending corrections) map, so a correction refreshes it", async () => {
  // Reproduces the live report: the read-back panel kept showing a stale
  // destination facility name after it was corrected and confirmed. Root
  // cause: the dedup key that decides whether to regenerate a suggestion is
  // [item.id, targetMode, blockedItem.id, itemStatus.extracted_value] — fine
  // for a normal slot-collection suggestion (whose text depends only on ITS
  // OWN captured value), but the read-back item's text is a SUMMARY built
  // from every OTHER slot (buildReadBackSuggestion), and its own itemStatus
  // stays "none" all call. So once generated, item.id/mode/itemStatus never
  // change again — the dedup Set silently blocked ever regenerating it, no
  // matter how many other slots got corrected afterward.
  //
  // Keyed on the MERGED map (mergeReadBackSlots), not raw slots_filled: a
  // correction candidate's proposed value lives only in itemStatuses
  // (is_correction) until confirmed, so keying on raw slots_filled alone would
  // miss the moment a NEW correction is first suggested.
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");

  assert.match(source, /import \{ isReadBackItem \} from "@\/lib\/agent-assist\/readback\.mjs";/);
  assert.match(source, /const isReadBackTarget = isReadBackItem\(\{/);
  assert.match(source, /const readBackSlots = isReadBackTarget\s*\n\s*\? mergeReadBackSlots\(stages, itemStatuses, slotsFilled\)\s*\n\s*: slotsFilled;/);
  assert.match(source, /isReadBackTarget \? JSON\.stringify\(readBackSlots\) : ""/);
  // The suggestion request itself must use the merged map too, so the
  // generated text shows pending corrections, not just confirmed values.
  assert.match(source, /slotsFilled: readBackSlots,/);
});

test("mergeReadBackSlots overlays pending correction values on top of confirmed slots_filled", async () => {
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.match(source, /function mergeReadBackSlots\(stages, itemStatuses, slotsFilled\)/);
  assert.match(source, /if \(!status\?\.is_correction\) continue;/);
});

test("correction candidates are excluded from the individual confirm_slot flow (folded into read-back instead)", async () => {
  // Once a correction is suggested, it must NOT ALSO surface as a separate
  // "I captured X as Y, please confirm" card — that value is folded into the
  // read-back summary (mergeReadBackSlots) and confirmed all at once when the
  // customer gives the final read-back affirmative.
  const resolverSource = await read("../lib/agent-assist/suggestion-target-resolver.mjs");
  assert.match(
    resolverSource,
    /return \(\s*\n\s*item\?\.type === "slot" &&\s*\n\s*status\?\.status === "suggested" &&\s*\n\s*hasMeaningfulValue\(status\?\.extracted_value\) &&\s*\n\s*!status\?\.is_correction\s*\n\s*\);/
  );
});

test("all pending corrections auto-promote to completed when the customer gives the final read-back affirmative", async () => {
  // "as soon as customer confirms that read-back information is correct,
  // moves to confirmation/reference number" — every other still-pending
  // correction candidate is promoted in the SAME breath as the read-back
  // item completing, so the caller isn't asked to separately re-confirm each
  // one after already accepting the whole updated summary.
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(route, /const readBackJustConfirmed = updates\.some\(\(u\) => \{/);
  assert.match(route, /WHERE ist\.session_id = \$1 AND ist\.status = 'suggested' AND i\.type = 'slot'/);
  // Only a correction candidate (already has a slots_filled value) is swept
  // up — a genuine first-time low-confidence suggestion (no slots_filled
  // entry yet) still needs its own individual confirmation.
  assert.match(route, /if \(!hasMeaningfulExtractedValue\(slotsFilled\[row\.slot_name\]\)\) continue; \/\/ not a correction candidate/);
});

test("a stale in-flight read-back suggestion request is discarded if the merged slots moved on before it resolves", async () => {
  // Reported live: a confirmed DOB correction, and separately a confirmed IV
  // drips correction, both reverted to their OLD value in the read-back text
  // right after being confirmed — even though the DB already had the correct
  // value. Root cause: Fix 5's staleness guard only checks the read-back
  // item's OWN status flipping to "completed" — but that item's status
  // barely changes even as its CONTENT (the whole summary) changes across
  // corrections. Two overlapping generate-suggestion requests for the
  // read-back item (one from before a correction confirmed, one from after)
  // could both be in flight; without this fix, whichever resolves LAST wins,
  // even if it was requested against an older, now-stale snapshot.
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.match(source, /if \(isReadBackTarget\) \{/);
  assert.match(
    source,
    /const latestReadBackSlots = mergeReadBackSlots\(latestState\.stages, latestState\.itemStatuses, latestState\.slotsFilled\);/
  );
  assert.match(source, /if \(JSON\.stringify\(latestReadBackSlots\) !== JSON\.stringify\(readBackSlots\)\) return;/);
});

test("the read-back target always regenerates (bypasses the 'already generated' Set gate), correctness relying on the freshness check instead", async () => {
  // Reported live a THIRD time (destination facility, after DOB and IV
  // drips): the content-based dedup key can transiently equal neither the
  // pre- nor post-correction key, because React can apply itemStatuses and
  // slots_filled from the SAME analyze response across separate renders —
  // the effect can fire with itemStatuses already reflecting is_correction:
  // false (correction resolved to a regular completion) while slots_filled
  // hasn't updated yet in THAT render, producing an inconsistent in-between
  // snapshot. Rather than keep patching key comparison, the read-back target
  // just always regenerates (it's a free template, not an LLM call) and
  // relies on the resolution-time freshness check (previous test) plus
  // upsertSuggestionByTarget's no-op-on-identical-text behavior for
  // correctness and efficiency.
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.match(source, /if \(isReadBackTarget \|\| !generatedTargetKeysRef\.current\.has\(targetKey\)\) \{/);
  assert.match(source, /if \(!isReadBackTarget\) generatedTargetKeysRef\.current\.add\(targetKey\);/);
});

test("the read-back item is exempt from stage-distance narrowing, so it stays visible even when currentStageOrder regresses", async () => {
  // Reported live: the customer clearly said "yes, all information is
  // correct" but the read-back item never completed — stuck forever. Root
  // cause: currentStageOrder (used to narrow the analyzer's input to nearby
  // stages) is computed from the EARLIEST still-open/unconfirmed SLOT
  // (currentTargetItem). If ANY earlier-stage slot regresses to "suggested"
  // (this session had FOUR: caller's first name, patient name, DOB, weight —
  // all captured but never promoted past "suggested"), currentStageOrder
  // snaps back to that early stage. The read-back item ("Confirm all
  // information is correct") is a non-slot PENDING item in the FINAL stage —
  // it doesn't qualify for the existing "suggested" exemption (it's pending,
  // not suggested) — so narrowing's stage-distance cutoff (currentStageOrder
  // + 1) excluded it from the analyzer's view entirely, making it impossible
  // to ever complete no matter what the customer said.
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(
    route,
    /item\.current_status === "suggested" \|\|\s*\n\s*\(item\.stage_order \?\? 0\) <= currentStageOrder \+ NARROW_STAGE_LOOKAHEAD \|\|\s*\n\s*isReadBackItem\(\{/
  );
});

test("matchesReadBackAffirmativeHints matches the item's own configured hints as a substring, nothing else", () => {
  const confirmAllItem = {
    hints: ["yes that's correct", "that's right", "correct", "yes", "sounds good", "everything is correct", "confirmed", "looks good"],
  };
  assert.equal(matchesReadBackAffirmativeHints("All information is correct.", confirmAllItem), true);
  assert.equal(matchesReadBackAffirmativeHints("Yes, that's correct.", confirmAllItem), true);
  assert.equal(matchesReadBackAffirmativeHints("K. All information is correct.", confirmAllItem), true);
  assert.equal(matchesReadBackAffirmativeHints("", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("No, something is not correct.", confirmAllItem), true); // contains "correct" — the caller of this function is responsible for the surrounding context, not this substring check
  assert.equal(matchesReadBackAffirmativeHints("The pickup facility is Saint Mary's.", confirmAllItem), false);
  // No hints configured on the item -> never matches.
  assert.equal(matchesReadBackAffirmativeHints("All information is correct.", { hints: [] }), false);
  assert.equal(matchesReadBackAffirmativeHints("All information is correct.", {}), false);
});

test("analyze route applies a deterministic read-back-affirmative backstop when the LLM misses the completion", async () => {
  // Reproduces the live report: the customer clearly said "All information is
  // correct" — the item was correctly in the analyzer's view (narrowing,
  // isReadBackStage, and completion_trigger were all correctly satisfied —
  // beforeCount/afterCount and correctionInProgress all checked out in the
  // log) — yet the LLM's response came back `updates: 0`. Rather than keep
  // relying solely on the model's judgment for this one, single,
  // extremely high-value completion, fall back to a deterministic check
  // against the item's own hints when customer-spoken at the read-back stage
  // and the LLM didn't already flag it this turn.
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(route, /if \(isReadBackStage && speakerType === "customer"\) \{/);
  assert.match(
    route,
    /const readBackConfirmItem = pendingItems\.find\(\s*\n\s*\(item\) =>\s*\n\s*item\.completion_trigger === "customer" &&/
  );
  assert.match(route, /matchesReadBackAffirmativeHints\(transcript, readBackConfirmItem\)/);
  // Must not double-apply if the LLM ALREADY completed it this same turn.
  assert.match(route, /const alreadyHandledThisTurn =/);
  assert.match(route, /!alreadyHandledThisTurn &&/);
});
