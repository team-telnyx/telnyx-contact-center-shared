import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildWorkflowAnalysisSystemPrompt } from "../lib/agent-assist/workflow-prompts.js";
import { mentionsCorrectionTrigger, matchesReadBackAffirmativeHints } from "../lib/agent-assist/readback.mjs";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Reproduces: at the final read-back ("We're transferring Mike Anderson...
// from Saint Mary's Hospital ... to Johnny Hospital ...") the caller says
// "destination facility name is incorrect, change it to John Mabry Hospital."
// Before this feature, an already-completed slot was excluded from the
// analyzer entirely (see the pending-items query: only status IN ('pending',
// 'suggested')), so the LLM never even saw destination_facility_name as a
// candidate and the correction was silently dropped.

test("buildWorkflowAnalysisSystemPrompt adds the correction section at read-back OR when corrections are allowed mid-call", () => {
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
  assert.match(readBackPrompt, /Correction Handling/);
  assert.match(readBackPrompt, /ALREADY CONFIRMED/);
  assert.match(readBackPrompt, /"Johnny Hospital"/);
  assert.match(readBackPrompt, /EXPLICITLY states the existing value is wrong/);

  // Same already-completed item mid-call with no correction in play: the
  // section must stay absent so nothing invites the model to overwrite a
  // confirmed value on an offhand mention.
  const quietMidCallPrompt = buildWorkflowAnalysisSystemPrompt({
    pendingItems: [completedItem],
    slotsFilled: { destination_facility: "Johnny Hospital" },
  });
  assert.doesNotMatch(quietMidCallPrompt, /Correction Handling/);
  // The "already confirmed" item annotation is independent of stage — it only
  // depends on the item being marked completed with a value, so it still shows.
  assert.match(quietMidCallPrompt, /ALREADY CONFIRMED/);

  // an earlier fix: mid-call, once someone explicitly says a value is wrong, the
  // route puts correction candidates in the analyzer input and sets
  // allowCorrections — the same instructions apply away from read-back.
  const midCallCorrectionPrompt = buildWorkflowAnalysisSystemPrompt({
    pendingItems: [completedItem],
    slotsFilled: { destination_facility: "Johnny Hospital" },
    allowCorrections: true,
  });
  assert.match(midCallCorrectionPrompt, /Correction Handling/);
  assert.match(midCallCorrectionPrompt, /EXPLICITLY states the existing value is wrong/);
  // The read-back-only final-confirmation rule must NOT leak into a mid-call
  // correction — there is no read-back recitation to confirm yet.
  assert.doesNotMatch(midCallCorrectionPrompt, /Final Confirmation Requires a Customer Affirmative/);
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

// Reproduces the live regression: STT mangled "John Mabry Hospital" into a
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
  assert.equal(mentionsCorrectionTrigger("Please change it to John Mabry Hospital."), true);
  assert.equal(mentionsCorrectionTrigger("Actually, it's John Mabry Hospital."), true);
  // A bare restated value (the continuation case) does NOT itself count as a
  // new trigger — continuation leniency comes from a trigger EARLIER in
  // recentContext, not from re-matching on every subsequent utterance.
  assert.equal(mentionsCorrectionTrigger("Stonemere Hospital."), false);
  assert.equal(mentionsCorrectionTrigger("The technician facility name is John Miller."), false);
});

test("live analyze route re-includes completed slots as correction candidates at read-back, or mid-call behind an explicit trigger", async () => {
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
  // Checked against allPendingItems (whole workflow), not the possibly
  // concept-group-scoped pendingItems — read-back readiness is a
  // whole-workflow concept, see the concurrent-group-batching comments.
  assert.match(
    route,
    /const isReadBackStage =\s*\n\s*!allPendingItems\.some\(\s*\n\s*\(item\) => item\.type === "slot" && !hasMeaningfulExtractedValue\(slotsFilled\[item\.slot_name\]\)\s*\n\s*\) &&\s*\n\s*allPendingItems\.some\(\(item\) =>/
  );

  // an earlier fix: read-back OR an explicit correction trigger at any other stage.
  // The trigger requirement preserves the original guarantee — with no
  // correction in play a completed slot is still entirely out of view, so an
  // offhand later mention cannot overwrite it. Excludes accumulating notes
  // slots (those have their own always-on re-inclusion via completedNotesItems).
  assert.match(route, /const correctionsAllowed = isReadBackStage \|\| correctionRequested;/);
  // an earlier fix follow-up: MANUALLY-edited slots are additionally excluded — the
  // agent's typed value is not in the transcript, so exposing the slot only
  // invites the LLM to "correct" it back to the stale spoken value. Agent-
  // SPOKEN captures (completed_by='agent' with a real LLM confidence) stay
  // correctable; see isManualAgentRow in the route.
  assert.match(
    route,
    /const correctionCandidateItems = correctionsAllowed\s*\n\s*\? completedSlotRows\.filter\(\(it\) => !isAccumulatingSlot\(it\) && !isManualAgentRow\(it\)\)\s*\n\s*: \[\];/
  );

  // Included in both the lookup list (analyzerItems) and the LLM-facing list
  // (narrowedAnalyzerItems), unaffected by stage-distance narrowing — a
  // correction to an early-stage slot must stay visible even once
  // currentStageOrder sits at the final Confirmation stage.
  assert.match(route, /const analyzerItems = \[\.\.\.relevantPendingItems, \.\.\.completedNotesItems, \.\.\.correctionCandidateItems\]/);
  assert.match(route, /const narrowedAnalyzerItems = \[\.\.\.narrowedRelevantPendingItems, \.\.\.completedNotesItems, \.\.\.correctionCandidateItems\]/);

  // The prompt's correction section is gated on candidates actually being in
  // the analyzer input, not on the stage — mid-call an explicit trigger is
  // what put them there.
  assert.match(route, /allowCorrections: correctionCandidateItems\.length > 0,/);

  // correctionRequested: a correction trigger phrase ("incorrect", "change
  // it", ...) in this utterance OR a recent one, at ANY stage.
  assert.match(route, /const correctionRequested =\s*\n\s*mentionsCorrectionTrigger\(transcript\)/);
  assert.doesNotMatch(
    route,
    /const correctionRequested =\s*\n\s*isReadBackStage/,
    "an explicit correction must be recognized away from the read-back stage (an earlier fix)",
  );
  assert.match(route, /correctionWindow\.some\(\(c\) => mentionsCorrectionTrigger\(c\?\.text\)\)/);

  // How far back the trigger may sit is stage-dependent: the whole recent
  // window at read-back (nothing left to collect), but only the previous
  // utterance mid-call, so a stale trigger cannot keep every completed slot
  // exposed while collection continues.
  assert.match(route, /const midCallCorrectionWindow = recentContextEntries\.slice\(-1\);/);
  assert.match(
    route,
    /const correctionWindow = isReadBackStage \? recentContextEntries : midCallCorrectionWindow;/,
  );
});

test("workflow-analyzer threads isReadBackStage, allowCorrections and correctionInProgress through to the prompt builder", async () => {
  const source = await read("../lib/agent-assist/workflow-analyzer.js");
  assert.match(source, /isReadBackStage = false,/);
  assert.match(source, /allowCorrections = false,/);
  assert.match(source, /correctionInProgress = false,/);
  assert.match(source, /isReadBackStage,\s*\n\s*allowCorrections,\s*\n\s*correctionInProgress,\s*\n\s*bleedGuardSlot,/);
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

test("auto-promotion requires the CUSTOMER's own confirm-all completing, not the agent's read-back recitation", async () => {
  // isReadBackItem alone matches BOTH "Read back transport details" (the
  // agent's own recitation action) and "Confirm all information is correct"
  // (the customer's actual sign-off) — both share "read back"/"confirm all"
  // phrasing. Without requiring completion_trigger === "customer", the
  // agent completing their OWN recitation (manually, or auto-detected from
  // the agent's own utterance) would satisfy this check and promote every
  // pending correction into slots_filled as authoritative before the
  // customer has reviewed or approved anything.
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(
    route,
    /completedItem &&\s*\n\s*completedItem\.completion_trigger === "customer" &&\s*\n\s*isReadBackItem\(\{/
  );
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

test("an already-displayed read-back suggestion refreshes on its own when a correction confirms, even while the current target has moved elsewhere", async () => {
  // Reported live: a correction is confirmed (slotsFilled/itemStatuses
  // update), but the read-back text keeps showing the pre-correction value
  // until the caller updates ANOTHER, unrelated slot. Root cause: the main
  // "regenerate on currentSlot change" effect only refreshes the read-back
  // text when currentSlot IS RESOLVED to the read-back item — but
  // findCorrectionTargetSlot keeps the resolved target locked onto that
  // specific slot's OWN collect_correction prompt for as long as the
  // correction-trigger phrase is still inside the rolling conversation
  // window (often several turns), so the read-back card's own list entry
  // just sits frozen the whole time. This effect refreshes an EXISTING
  // read-back entry directly off of itemStatuses/slotsFilled changes,
  // independent of what the current resolved target is.
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.match(source, /function findStageAndItemById\(stages, itemId\)/);
  assert.match(
    source,
    /generateSuggestion\(found\.stage, found\.item, session, transcriptions, \{[\s\S]*?slotsFilled: merged,/
  );
  // Same staleness discard as Fix 6: drop the response if the merged slots
  // moved on again before it resolved (another correction landed meanwhile).
  assert.match(
    source,
    /const latestMerged = mergeReadBackSlots\(latestState\.stages, latestState\.itemStatuses, latestState\.slotsFilled\);\s*\n\s*if \(JSON\.stringify\(latestMerged\) !== mergedKey\) return;/
  );
});

test("the read-back refresh lookup resolves against the authoritative item definition (stages), not the flattened suggestion object", async () => {
  // A suggestion only stores itemType/itemLabel (see generateSuggestion's
  // return shape) — no prompt_hint/hints. isReadBackItem also matches a read-
  // back item identified SOLELY by its prompt_hint/hints (e.g. label "Verify
  // order" with a read-back-phrased hint) — checking only the suggestion's
  // own stored fields would never find that entry, leaving it stuck showing
  // the pre-correction value forever. Must look up the full item (type,
  // label, prompt_hint, hints) via findStageAndItemById before testing it.
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.doesNotMatch(
    source,
    /suggestionsRef\.current\.find\(\(s\) =>\s*\n\s*isReadBackItem\(\{ itemType: s\.itemType, itemLabel: s\.itemLabel \}\)/
  );
  assert.match(
    source,
    /const candidate = findStageAndItemById\(stages, s\.itemId\);\s*\n\s*if \(!candidate\) continue;\s*\n\s*if \(isReadBackItem\(\{\s*\n\s*itemType: candidate\.item\.type,\s*\n\s*itemLabel: candidate\.item\.label,\s*\n\s*itemPromptHint: candidate\.item\.prompt_hint,\s*\n\s*itemHints: candidate\.item\.hints,\s*\n\s*\}\)\) \{/
  );
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
    /item\.current_status === "suggested" \|\|\s*\n\s*ALWAYS_VISIBLE_SLOT_NAMES\.has\(item\.slot_name\) \|\|\s*\n\s*\(item\.stage_order \?\? 0\) <= currentStageOrder \+ NARROW_STAGE_LOOKAHEAD \|\|\s*\n\s*isReadBackItem\(\{/
  );
});

test("a multi-utterance debounce batch is sent as ONE analyzeTranscriptBatch request, not one fetch per utterance", async () => {
  // The analyze route computes currentTargetItem from a fresh DB snapshot
  // read at the START of each utterance within a batch request. Firing
  // every utterance in a debounce batch as SEPARATE concurrent requests
  // (Promise.all) meant sibling requests could all read the SAME stale
  // snapshot before any of them persisted a slot — a caller answering two
  // different questions in one breath ("ICU" ... "3") could have the
  // second bare answer misattributed to whatever slot was still open
  // before the batch started, since currentTarget is used as a
  // tie-breaker for exactly that kind of ambiguous short answer. Bundling
  // the whole batch into one request lets the server process each
  // utterance in order within a single DB transaction (see
  // analyzeOneUtterance in analyze/route.js) — same ordering guarantee,
  // without N separate HTTP round trips.
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.match(source, /await analyzeTranscriptBatch\(currentBatch\.map/);
  assert.match(source, /analysisQueueRef\.current\.set\(utterance\.transcriptionId, utterance\)/);
  assert.doesNotMatch(source, /await Promise\.all\(\s*\n\s*batch\.map/);
});

test("analyze ordering is serialized with a bounded latest-value queue", async () => {
  // Gap in the previous fix: sequencing inside one batch's own for-loop
  // isn't enough. If the first /analyze call in a batch is slow, a later
  // final transcript can schedule its OWN timer and fire its OWN batch
  // before the first one's loop finishes — since ordering was only local to
  // each batch's loop, the two batches' calls could still run concurrently
  // with each other, reproducing the exact race the earlier fix was meant
  // to close. A single shared promise chain for the whole session (not
  // reset per batch) guarantees every analyze call queues up strictly after
  // every call already enqueued, regardless of which timer scheduled it.
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.match(source, /const analysisQueueRef = useRef\(new Map\(\)\);/);
  assert.match(source, /if \(analysisDrainRunningRef\.current\) return;/);
  assert.match(source, /await analyzeTranscriptBatch\(currentBatch\.map/);
  assert.doesNotMatch(source, /analyzeChainRef/);
});

test("a queued analyze batch request is dropped if the call ends and a NEW one starts before its turn in the chain", async () => {
  // Gap in the chaining fix: analyzeTranscriptBatch (workflow-store.js)
  // reads the store's CURRENT session fresh when it actually executes, not
  // a closure from when it was queued. If call A ends and call B starts
  // while an earlier batch from call A is still queued behind a slow
  // request, that queued batch would otherwise be sent into call B's
  // workflow session under call B's sessionId — a cross-call data leak. The
  // chain must capture the interaction identity at ENQUEUE time and
  // re-check it against the store's activeInteractionId right before
  // calling analyzeTranscriptBatch, bailing out if the call has moved on.
  // This is a DIFFERENT guard than analyzeTranscriptBatch's own staleness
  // check, which only catches a switch happening WHILE that specific
  // request is already in flight — not one that happened before it was
  // even dispatched.
  const source = await read("../components/contact-center/AgentAssistWorkflow.jsx");
  assert.match(source, /const activeInteractionId = useWorkflowStore\.getState\(\)\.activeInteractionId;/);
  assert.match(source, /queued\.filter\(\(item\) => item\.interactionId === activeInteractionId\)/);
  // interactionId must be in the effect's own dependency array, or a batch
  // built after a call switch (without session/transcriptions ALSO
  // changing) could still capture a stale enqueuedInteractionId.
  assert.match(
    source,
    /\}, \[session, transcriptions, assistConfig\.auto_detect_completion, interactionId, enqueueAnalysis\]\);/
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
  // A rejection/correction must never count as an affirmative, even though
  // "correct" is technically a substring of "not correct" and one of this
  // item's own configured hints.
  assert.equal(matchesReadBackAffirmativeHints("No, something is not correct.", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("No, that's wrong.", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("Actually, the DOB is wrong.", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("The pickup facility is Saint Mary's.", confirmAllItem), false);
  // A leading "no" alone must NOT be treated as a rejection: the read-back
  // prompt itself asks "...or is there anything you'd like to change?", so a
  // "No, ___ is correct" reply is a valid, common affirmative, not a
  // rejection just because it starts with "no".
  assert.equal(matchesReadBackAffirmativeHints("No, everything is correct.", confirmAllItem), true);
  assert.equal(matchesReadBackAffirmativeHints("No changes, everything is correct.", confirmAllItem), true);
  // "Actually, it's ___" alone is ambiguous (could precede a correction or an
  // affirmative) — must not be rejected outright when what follows is
  // actually affirmative. Only the unambiguous rejection words (wrong,
  // incorrect, not correct, mistake, etc.) should short-circuit here.
  assert.equal(matchesReadBackAffirmativeHints("Actually, it's correct.", confirmAllItem), true);
  assert.equal(matchesReadBackAffirmativeHints("Actually, it's all correct.", confirmAllItem), true);
  // "change it/that/this" is a plain substring match with no negation
  // handling — must not reject a negated "no need to change" affirmative.
  assert.equal(matchesReadBackAffirmativeHints("No need to change it, everything is correct.", confirmAllItem), true);
  assert.equal(matchesReadBackAffirmativeHints("I wouldn't change that, everything is correct.", confirmAllItem), true);
  // "wrong"/"error" alone were previously unconditional rejection triggers,
  // so a NEGATED rejection word ("nothing is WRONG", "no ERROR") was
  // incorrectly rejected even though it's a valid affirmative.
  assert.equal(matchesReadBackAffirmativeHints("Nothing is wrong, everything is correct.", confirmAllItem), true);
  assert.equal(matchesReadBackAffirmativeHints("No error, everything is correct.", confirmAllItem), true);
  // Conversely, "all"/"everything" near "correct" were previously an
  // unconditional affirmative match with no negation awareness, so a genuine
  // rejection using "not" ("not ALL ... is CORRECT") was incorrectly
  // accepted as an affirmative.
  assert.equal(matchesReadBackAffirmativeHints("No, not all the information is correct.", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("It is not all correct.", confirmAllItem), false);
  // The negation guard must cover every affirmative anchor word the generic
  // patterns accept (correct/right/good/fine), not just "correct" — a
  // negated "right"/"good"/"fine" is just as much a rejection.
  assert.equal(matchesReadBackAffirmativeHints("No, not everything is right.", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("It's not all good.", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("That's not fine.", confirmAllItem), false);
  // A partial exception ("yes, EXCEPT X" / "correct, but X needs fixing" /
  // "ALMOST everything is correct") is not a full sign-off — the caller is
  // explicitly flagging something still needs review, even though the
  // sentence also contains an affirmative-looking word/phrase.
  assert.equal(matchesReadBackAffirmativeHints("Yes, except the DOB.", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("Everything is correct except the destination.", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("Everything is correct, but the DOB needs updating.", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("Almost everything is correct.", confirmAllItem), false);
  // "but" alone must NOT be an unconditional rejection trigger — a caller
  // who confirms and then asks an unrelated follow-up question is still a
  // full sign-off. Only a "but" clause that actually states something needs
  // changing (caught by NEEDS_UPDATE_WORDS) is a rejection.
  assert.equal(matchesReadBackAffirmativeHints("Everything is correct, but can I get the confirmation number?", confirmAllItem), true);
  // An explicit "change/update X TO value" is an actionable correction even
  // with a leading affirmative "Yes," — the caller is not confirming, they
  // are dictating a new value.
  assert.equal(matchesReadBackAffirmativeHints("Yes, please change the DOB to 1970.", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("Update the room to 402.", confirmAllItem), false);
  // The generic affirmative fallback matches independent of configured
  // hints — unrelated text with no hints configured still correctly falls
  // through to false.
  assert.equal(matchesReadBackAffirmativeHints("The pickup facility is Saint Mary's.", { hints: [] }), false);
  assert.equal(matchesReadBackAffirmativeHints("The pickup facility is Saint Mary's.", {}), false);

  // Reported live: "Yeah. I want to change the date of birth." — the leading
  // "Yeah" alone matched the generic affirmative pattern, and "I want to
  // change the date of birth" matched NONE of the existing rejection
  // patterns (no explicit "to <value>", no "need", no negation, no "wrong"/
  // "incorrect") — so a customer mid-correction got wrongly recorded as
  // confirming the whole read-back, skipping straight to the next step.
  // "want"/"wish"/"'d like" to change/update/fix/correct must reject the
  // same way "needs to be changed" already does, regardless of a leading
  // affirmative filler word.
  assert.equal(matchesReadBackAffirmativeHints("Yeah. I want to change the date of birth.", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("Yes, I'd like to update the room.", confirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("I wish to correct the patient's weight.", confirmAllItem), false);
  // Negated desire is the opposite of a correction — must still pass through
  // as a valid affirmative.
  assert.equal(matchesReadBackAffirmativeHints("No, I don't want to change anything, everything is correct.", confirmAllItem), true);
});

test("mentionsCorrectionTrigger also recognizes a named-field 'want to change' correction, not just the pronoun form", () => {
  assert.equal(mentionsCorrectionTrigger("I want to change the date of birth."), true);
  assert.equal(mentionsCorrectionTrigger("I'd like to update the pickup room."), true);
  assert.equal(mentionsCorrectionTrigger("Everything is fine."), false);
});

test("matchesReadBackAffirmativeHints falls back to a generic affirmative check when the item's own hints don't overlap with customer speech", () => {
  // Reproduces a live-reported stuck read-back: item.hints is commonly
  // auto-derived by comma-splitting prompt_hint (see
  // scripts/upsert-medical-transport-intake-workflow.mjs), which produces
  // AGENT-question-framed phrases like "is that correct, anything to
  // change, does everything look right, accurate" — none of which are
  // substrings of a customer's own affirmative reply. The generic fallback
  // must still catch these regardless of the item's configured hints.
  const realisticConfirmAllItem = {
    hints: ["is that correct", "anything to change", "does everything look right", "accurate"],
  };
  assert.equal(matchesReadBackAffirmativeHints("Yes.", realisticConfirmAllItem), true);
  assert.equal(matchesReadBackAffirmativeHints("I can confirm all information is correct.", realisticConfirmAllItem), true);
  assert.equal(matchesReadBackAffirmativeHints("give me the reference number", realisticConfirmAllItem), false);
  assert.equal(matchesReadBackAffirmativeHints("No, that's not correct, the DOB is wrong.", realisticConfirmAllItem), false);
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
  // allPendingItems, not the concept-group-scoped pendingItems — in a
  // multi-group batch the affirmative is classified by content while the
  // Confirmation items live in their own group, so a scoped lookup would
  // find nothing and the backstop would silently never fire.
  assert.match(
    route,
    /const readBackConfirmItem = allPendingItems\.find\(\s*\n\s*\(item\) =>\s*\n\s*item\.completion_trigger === "customer" &&/
  );
  assert.match(route, /matchesReadBackAffirmativeHints\(transcript, readBackConfirmItem\)/);
  // Must not double-apply if the LLM ALREADY completed it this same turn.
  assert.match(route, /const alreadyHandledThisTurn =/);
  assert.match(route, /!alreadyHandledThisTurn &&/);
});
