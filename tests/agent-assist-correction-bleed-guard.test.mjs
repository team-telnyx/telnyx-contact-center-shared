import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Reported live: caller is already in the Destination stage (pickup_facility
// was correctly completed earlier in the call). Caller says "the destination
// facility AAA I said earlier is wrong, it needs to be changed to BBB" — an
// explicit correction that names "destination" and even the OLD value. The
// model's returned item_id nonetheless resolved to pickup_facility, silently
// overwriting the wrong (and already long-completed) sibling with "BBB".
//
// None of the first three bleed guards can catch this: they all key off
// pendingItems (status 'pending'/'suggested'), but a correction target is
// status 'completed' and only appears via correctionCandidateItems — outside
// all three guards' view.

test("fourth guard exists and only inspects correction candidates (status 'completed'), not fresh pending fills", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(route, /Fourth guard: a mid-call CORRECTION/);
  const guardSection = route.slice(route.indexOf("Fourth guard:"), route.indexOf("Process completed items"));

  assert.match(guardSection, /if \(!item\?\.slot_name \|\| item\.current_status !== "completed"\) continue;/);
  assert.match(guardSection, /const base = baseSlotKey\(item\.slot_name\);/);
  assert.match(guardSection, /if \(base === item\.slot_name\) continue;/);
});

test("fourth guard backs off when the utterance already names the model's own pick", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const guardSection = route.slice(route.indexOf("Fourth guard:"), route.indexOf("Process completed items"));
  assert.match(guardSection, /if \(mentionsOwnStageWord\(item\.slot_name, disambiguationText\)\) continue;/);
});

test("fourth guard redirects to the sibling explicitly named by the utterance, without requiring it to be still-open", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const guardSection = route.slice(route.indexOf("Fourth guard:"), route.indexOf("Process completed items"));

  // Sibling lookup is scoped to OTHER completed correction candidates of the
  // same base concept — unlike guard 2's earlierOpenSibling, there is no
  // "still pending" or "earlier stage_order" requirement, because a
  // correction target is by definition already completed regardless of
  // which stage came first.
  assert.match(
    guardSection,
    /const namedSiblings = analyzerItems\.filter\(\(sib\) =>\s*\n\s*sib\.item_id !== item\.item_id &&\s*\n\s*sib\.current_status === "completed" &&\s*\n\s*sib\.slot_name &&\s*\n\s*baseSlotKey\(sib\.slot_name\) === base &&\s*\n\s*mentionsOwnStageWord\(sib\.slot_name, disambiguationText\)\s*\n\s*\);/
  );

  // Only redirects when EXACTLY one sibling is named — an utterance naming
  // neither (or, pathologically, both) leaves the model's original pick
  // alone rather than guessing.
  assert.match(guardSection, /if \(namedSiblings\.length !== 1\) continue;/);

  // Redirects the same way guard 2 does: rewrite item_id in place so the
  // existing completion pipeline applies to the corrected item.
  assert.match(guardSection, /completed\.item_id = target\.item_id;/);
  assert.match(guardSection, /workflow_correction_bleed_redirected/);
});

test("fourth guard's disambiguation text includes the current utterance's own transcript, not just recent context", async () => {
  // A correction's stage word (e.g. "destination") is almost always in the
  // CURRENT utterance itself ("the destination facility... needs to
  // change"), not necessarily in prior context — unlike the bare short
  // replies guard 2 was built for (e.g. "323" answering a preceding
  // question).
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const guardSection = route.slice(route.indexOf("Fourth guard:"), route.indexOf("Process completed items"));
  assert.match(guardSection, /const transcriptText = transcript \|\| "";/);
});

// Codex review (0cbf7ffc, P1, round 2): even after narrowing to just the
// single preceding turn (round 1's fix), that preceding turn can still
// outvote the CURRENT utterance. If the caller is mid-destination-stage and
// interrupts to correct a pickup value, the preceding turn is the agent's
// OWN destination-stage prompt (naming "destination"), while the current
// transcript names "pickup" — concatenating them with equal weight lets the
// agent's stale "destination" corroborate a wrong destination pick even
// though the caller just said "pickup". The transcript must be authoritative
// whenever it names a stage at all; the preceding turn is a fallback ONLY
// for when the transcript itself is silent on stage words.
test("fourth guard's disambiguation prioritizes the transcript over the preceding turn when the transcript itself names a stage (regression)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const guardSection = route.slice(route.indexOf("Fourth guard:"), route.indexOf("Process completed items"));

  assert.match(
    guardSection,
    /const transcriptNamesAnyStage =\s*\n\s*DESTINATION_STAGE_WORDS\.test\(transcriptText\) \|\|\s*\n\s*PICKUP_STAGE_WORDS\.test\(transcriptText\) \|\|\s*\n\s*DESTINATION_WEAK_GOING_TO_DIRECT\.test\(transcriptText\) \|\|\s*\n\s*DESTINATION_WEAK_GOING_TO_BE_AT\.test\(transcriptText\);/
  );
  assert.match(
    guardSection,
    /const disambiguationText = transcriptNamesAnyStage\s*\n\s*\? transcriptText\s*\n\s*: `\$\{lastRecentContextEntry\?\.text \|\| ""\} \$\{transcriptText\}`;/
  );
});

// Codex review (PR #1392, P1, round 4): transcriptNamesAnyStage originally
// checked only the strong DESTINATION_STAGE_WORDS/PICKUP_STAGE_WORDS
// regexes, omitting the weak "going to" signal mentionsOwnStageWord itself
// uses. A genuine destination correction phrased with "going to" ("that
// value is wrong, we're going to Mercy") was wrongly judged to NOT name any
// stage on its own, so the guard prepended the PRIOR turn's text — which
// can carry an unrelated pickup mention (e.g. the agent's earlier "which
// hospital did we pick up from?"). That prepended pickup word then made
// mentionsOwnStageWord's own conflict check (added in round 3) see a
// contradiction that only existed because of the blend, defeating the
// guard on exactly the correction it exists to protect.
test("fourth guard's transcript-alone check recognizes the weak 'going to' signal too, so a genuine destination correction isn't poisoned by a stale prior-turn pickup mention (regression)", () => {
  const DESTINATION_STAGE_WORDS =
    /\b(destination|receiving|drop[\s-]?off|dropoff|transport(?:ing|ed)? to)\b/i;
  const DESTINATION_WEAK_GOING_TO_EXCLUDED_VERBS =
    "change|update|correct|fix|need|check|ask|call|have|get|see|make|take|arrive|come|go|meet|transfer|send|keep|hold|wait|look|discuss|know|confirm|verify|review|talk|speak|do|say|tell|give|find|try|cancel|page|dispatch|pick";
  const DESTINATION_WEAK_GOING_TO_DIRECT = new RegExp(
    `\\bgoing to\\b(?!\\s+(?:${DESTINATION_WEAK_GOING_TO_EXCLUDED_VERBS}|be)\\b)`,
    "i"
  );
  const DESTINATION_WEAK_GOING_TO_BE_AT = /\bgoing to be at\b/i;
  const PICKUP_STAGE_WORDS = /\b(pick(?:ing|ed)?[\s-]?up|sending|origin)\b/i;
  function mentionsOwnStageWord(slotName, text) {
    const t = String(text || "");
    if (/^(destination|receiving)_/.test(slotName)) {
      if (DESTINATION_STAGE_WORDS.test(t)) return true;
      if (PICKUP_STAGE_WORDS.test(t)) return false;
      return DESTINATION_WEAK_GOING_TO_DIRECT.test(t) || DESTINATION_WEAK_GOING_TO_BE_AT.test(t);
    }
    if (/^(pickup|sending)_/.test(slotName)) return PICKUP_STAGE_WORDS.test(t);
    return false;
  }
  function computeDisambiguationText(transcriptText, lastRecentContextText) {
    const transcriptNamesAnyStage =
      DESTINATION_STAGE_WORDS.test(transcriptText) ||
      PICKUP_STAGE_WORDS.test(transcriptText) ||
      DESTINATION_WEAK_GOING_TO_DIRECT.test(transcriptText) ||
      DESTINATION_WEAK_GOING_TO_BE_AT.test(transcriptText);
    return transcriptNamesAnyStage
      ? transcriptText
      : `${lastRecentContextText || ""} ${transcriptText}`;
  }

  const priorTurn = "Which hospital did we pick up from?";
  const transcript = "that value is wrong, we're going to Mercy";
  const disambiguationText = computeDisambiguationText(transcript, priorTurn);

  // The transcript alone already names a stage (weak "going to", nothing
  // contradicting it within the transcript itself) — the prior turn must
  // NOT be blended in.
  assert.equal(disambiguationText, transcript);
  // With no prior-turn contamination, the destination correction is
  // correctly recognized as naming its own stage — the guard backs off
  // instead of redirecting onto pickup_facility.
  assert.equal(mentionsOwnStageWord("destination_facility", disambiguationText), true);
});

// Codex review (PR #1392, P1, round 6): round 4's fix was itself too broad.
// "going to" genuinely names a destination only when a PLACE follows it
// ("going to Mercy"); when a VERB follows instead ("I'm going to change it
// to Mercy" — an ordinary future-tense correction of pickup_facility, not a
// destination naming), treating the bare phrase as "the transcript names a
// stage" made the guard trust the transcript alone and discard a preceding
// turn that was the ACTUAL relevant context (e.g. it named "pickup"). The
// bare "going to" then wrongly corroborated destination_facility and
// redirected a correctly-resolved pickup correction onto the wrong sibling.
test("fourth guard's weak 'going to' signal doesn't discard a preceding turn's REAL pickup context when 'going to' is just future-tense phrasing (regression)", () => {
  const DESTINATION_STAGE_WORDS =
    /\b(destination|receiving|drop[\s-]?off|dropoff|transport(?:ing|ed)? to)\b/i;
  const DESTINATION_WEAK_GOING_TO_EXCLUDED_VERBS =
    "change|update|correct|fix|need|check|ask|call|have|get|see|make|take|arrive|come|go|meet|transfer|send|keep|hold|wait|look|discuss|know|confirm|verify|review|talk|speak|do|say|tell|give|find|try|cancel|page|dispatch|pick";
  const DESTINATION_WEAK_GOING_TO_DIRECT = new RegExp(
    `\\bgoing to\\b(?!\\s+(?:${DESTINATION_WEAK_GOING_TO_EXCLUDED_VERBS}|be)\\b)`,
    "i"
  );
  const DESTINATION_WEAK_GOING_TO_BE_AT = /\bgoing to be at\b/i;
  const PICKUP_STAGE_WORDS = /\b(pick(?:ing|ed)?[\s-]?up|sending|origin)\b/i;
  function mentionsOwnStageWord(slotName, text) {
    const t = String(text || "");
    if (/^(destination|receiving)_/.test(slotName)) {
      if (DESTINATION_STAGE_WORDS.test(t)) return true;
      if (PICKUP_STAGE_WORDS.test(t)) return false;
      return DESTINATION_WEAK_GOING_TO_DIRECT.test(t) || DESTINATION_WEAK_GOING_TO_BE_AT.test(t);
    }
    if (/^(pickup|sending)_/.test(slotName)) return PICKUP_STAGE_WORDS.test(t);
    return false;
  }
  function computeDisambiguationText(transcriptText, lastRecentContextText) {
    const transcriptNamesAnyStage =
      DESTINATION_STAGE_WORDS.test(transcriptText) ||
      PICKUP_STAGE_WORDS.test(transcriptText) ||
      DESTINATION_WEAK_GOING_TO_DIRECT.test(transcriptText) ||
      DESTINATION_WEAK_GOING_TO_BE_AT.test(transcriptText);
    return transcriptNamesAnyStage
      ? transcriptText
      : `${lastRecentContextText || ""} ${transcriptText}`;
  }

  const priorTurn = "Pickup facility is Mercy General, correct?";
  const transcript = "No, that's wrong; I'm going to change it to Mercy";
  const disambiguationText = computeDisambiguationText(transcript, priorTurn);

  // "going to change" is ordinary future tense, not a destination naming —
  // the transcript does NOT name a stage on its own, so the preceding
  // turn's real "pickup" context must still be blended in.
  assert.notEqual(disambiguationText, transcript);
  assert.match(disambiguationText, /Pickup facility/);
  // With the preceding turn's pickup context intact, the correctly-resolved
  // pickup correction is recognized as naming its own stage — no wrongful
  // redirect onto destination_facility.
  assert.equal(mentionsOwnStageWord("pickup_facility", disambiguationText), true);
});

// Codex review (0557da1d54, P1): the first version of this guard folded in
// the WHOLE recentContext window (every prior utterance in the call), not
// just the most recent one. A stage word mentioned much earlier — e.g.
// "pickup" from when pickup_facility was originally collected, several turns
// before this correction — stayed in the aggregate text forever. That meant
// the own-stage check would wrongly treat a bad pickup_facility pick as
// corroborated by THIS utterance just because "pickup" appeared SOMEWHERE
// earlier in the call, defeating the guard on exactly the case it exists
// for. Guard 2 already hit and fixed this identical bug (see
// tests/agent-assist-cross-stage-slot-bleed.test.mjs's "uses only the MOST
// RECENT context entry" test) — this guard must use the same fix.
test("fourth guard only folds in the MOST RECENT context entry, not the whole recentContext window (regression)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const guardSection = route.slice(route.indexOf("Fourth guard:"), route.indexOf("Process completed items"));

  assert.match(
    guardSection,
    /const lastRecentContextEntry = Array\.isArray\(recentContext\) && recentContext\.length > 0\s*\n\s*\? recentContext\[recentContext\.length - 1\]\s*\n\s*: null;/
  );
  // The old whole-window join must be gone from this guard specifically.
  assert.doesNotMatch(
    guardSection,
    /\(Array\.isArray\(recentContext\) \? recentContext : \[\]\)\s*\n\s*\.map\(\(c\) => c\?\.text\)\s*\n\s*\.filter\(Boolean\)\s*\n\s*\.join\(" "\);/
  );
});

test("fourth guard runs after (and respects) the earlier guards' rejections", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const fourthIdx = route.indexOf("Fourth guard:");
  const thirdIdx = route.indexOf("Third guard:");
  assert.ok(thirdIdx > -1 && fourthIdx > thirdIdx, "fourth guard must be defined after the third guard");

  const guardSection = route.slice(fourthIdx, route.indexOf("Process completed items"));
  assert.match(guardSection, /if \(bleedRejectedItemIds\.has\(completed\.item_id\)\) continue;/);
});

// Codex review (59398e55, P1): if the analyzer's response ALSO completed the
// redirect TARGET (the sibling) with the same value in the same pass, guard
// 1 (the hard backstop, lines ~566-600) already added that target's item_id
// to bleedRejectedItemIds as a same-response/same-value duplicate at a later
// stage. Redirecting THIS completion onto that already-rejected id, without
// clearing the rejection, makes the "Process completed items" loop skip
// BOTH the original target completion (already rejected) and this
// redirected one (now pointing at the same rejected id) — the correction is
// silently lost entirely rather than applied once.
test("fourth guard clears any prior bleedRejectedItemIds rejection on its redirect target, so a correction isn't silently dropped (regression)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const guardSection = route.slice(route.indexOf("Fourth guard:"), route.indexOf("Process completed items"));

  const deleteIdx = guardSection.indexOf("bleedRejectedItemIds.delete(target.item_id);");
  const targetAssignIdx = guardSection.indexOf("const target = namedSiblings[0];");
  const redirectIdx = guardSection.indexOf("completed.item_id = target.item_id;");
  assert.ok(deleteIdx > -1, "guard 4 must clear target's prior rejection before redirecting onto it");
  // Must run after `target` is defined and before (or alongside) the actual
  // redirect, so the main loop never sees a rejected target.item_id land on
  // this completion.
  assert.ok(
    targetAssignIdx > -1 && deleteIdx > targetAssignIdx && deleteIdx < redirectIdx,
    "the rejection clear must happen after `target` is known and before the redirect is applied"
  );
});

// Codex review (8093b981, P1): distinct from the identical-value case above
// (which guard 1 already catches), if the model's response ALSO produces a
// DIRECT, correctly-attributed completion for target itself — with a
// DIFFERENT extracted_value than this misattributed entry — redirecting
// this entry onto target.item_id creates a second completed_items entry for
// the same row. The processing loop then updates that row twice, and
// whichever entry happens to appear LAST in the array silently wins —
// nondeterministic, and the correct direct completion could be overwritten
// by the misattributed one purely by array order.
test("fourth guard rejects (not redirects) when the model ALSO directly completed the target itself in this response, so a duplicate can't silently overwrite it by array order (regression)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const guardSection = route.slice(route.indexOf("Fourth guard:"), route.indexOf("Process completed items"));

  assert.match(
    guardSection,
    /const targetAlreadyCompletedDirectly = \(analysisResult\.completed_items \|\| \[\]\)\.some\(\s*\n\s*\(c\) => c !== completed && c\.item_id === target\.item_id\s*\n\s*\);/
  );
  const directCheckIdx = guardSection.indexOf("targetAlreadyCompletedDirectly");
  assert.match(guardSection, /if \(targetAlreadyCompletedDirectly\) \{/);
  assert.match(guardSection, /bleedRejectedItemIds\.add\(completed\.item_id\);/);
  assert.match(guardSection, /workflow_correction_bleed_redirect_superseded/);

  // Must be checked BEFORE the actual redirect assignment, so a direct
  // completion always wins over a misattributed one regardless of which is
  // processed first.
  const redirectIdx = guardSection.indexOf("completed.item_id = target.item_id;");
  assert.ok(directCheckIdx > -1 && directCheckIdx < redirectIdx);
});

// Codex review (aeed3ba9, P1): the previous version of this fix only
// cleared target's guard-1 rejection in the redirect branch — the
// direct-completion branch (just above) `continue`d past that clear
// entirely. So when BOTH the identical-value case (guard 1 rejects target)
// AND the direct-completion case (this entry gets superseded, not
// redirected) apply at once, target stayed rejected and BOTH entries were
// silently dropped — the exact bug the prior commit fixed, reintroduced via
// the other branch. The clear must run ONCE, before either branch decides
// what happens to this entry.
test("fourth guard clears target's rejection BEFORE deciding between reject-and-supersede vs. redirect, not only in the redirect branch (regression)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const guardSection = route.slice(route.indexOf("Fourth guard:"), route.indexOf("Process completed items"));

  const targetAssignIdx = guardSection.indexOf("const target = namedSiblings[0];");
  const deleteIdx = guardSection.indexOf("bleedRejectedItemIds.delete(target.item_id);");
  const directCheckIdx = guardSection.indexOf("targetAlreadyCompletedDirectly");
  const redirectIdx = guardSection.indexOf("completed.item_id = target.item_id;");

  assert.ok(deleteIdx > -1, "guard 4 must clear target's prior rejection");
  // The clear must come after `target` is known but BEFORE the branch that
  // decides reject-and-supersede vs. redirect — covering both outcomes.
  assert.ok(
    targetAssignIdx > -1 &&
      deleteIdx > targetAssignIdx &&
      deleteIdx < directCheckIdx &&
      deleteIdx < redirectIdx,
    "the rejection clear must run once, before the direct-completion check, so it covers both branches"
  );
});
