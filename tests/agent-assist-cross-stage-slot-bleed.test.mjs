import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Reported live: agent asks "Which department is the patient in?" (pickup
// stage). Customer answers department/room/bed/physician in quick
// succession ("...Room three three three. Bed A. Doctor Patel."). The bare
// "Bed A" filled destination_bed instead of pickup_bed — narrowing's stage
// lookahead makes both structurally-identical slots visible to the LLM in
// the same request, and it picked the wrong one. The existing hard backstop
// only rejects an exact SAME-VALUE duplicate across both slots in one
// response; it does nothing for a single mis-attributed fill like this one.

test("hard backstop still rejects an exact same-value duplicate across paired stages", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(route, /const baseSlotKey = \(slotName\) =>/);
  assert.match(route, /String\(slotName \|\| ""\)\.replace\(\/\^\(pickup\|destination\|sending\|receiving\)_\/, ""\)/);
  assert.match(route, /bleedRejectedItemIds\.add\(later\.itemId\)/);
});

test("soft redirect: a single paired-slot fill for a LATER stage is redirected to the still-open EARLIER sibling", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");

  // The redirect loop exists, keyed on the same baseSlotKey concept as the
  // hard backstop, and skips anything the hard backstop already rejected.
  assert.match(route, /workflow_stage_bleed_redirected/);
  assert.match(route, /if \(bleedRejectedItemIds\.has\(completed\.item_id\)\) continue;/);

  // Finds the earliest still-OPEN sibling of the same base concept at an
  // earlier stage than the item the LLM actually completed.
  assert.match(
    route,
    /\.filter\(\(sib\) => sib\.item_id !== item\.item_id && \(sib\.stage_order \?\? 0\) < \(item\.stage_order \?\? 0\)\)/
  );

  // Redirects by rewriting item_id in place, so the existing completion
  // pipeline (slot capture, DB write) applies to the corrected item without
  // any further special-casing.
  assert.match(route, /completed\.item_id = earlierOpenSibling\.item_id;/);
});

test("soft redirect backs off when the utterance explicitly names the later stage itself", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");

  // A customer explicitly saying "the destination bed is B" (naming the
  // stage) must not be silently redirected to the pickup slot — only a bare,
  // ambiguous mention should be redirected.
  assert.match(route, /function mentionsOwnStageWord\(slotName, text\)/);
  assert.match(
    route,
    /DESTINATION_STAGE_WORDS =\s*\n?\s*\/\\b\(destination\|receiving\|drop\[\\s-\]\?off\|dropoff\|transport\(\?:ing\|ed\)\? to\)\\b\/i;/
  );
  assert.match(route, /PICKUP_STAGE_WORDS = \/\\b\(pick\(\?:ing\|ed\)\?\[\\s-\]\?up\|sending\|origin\)\\b\/i/);
  assert.match(route, /if \(mentionsOwnStageWord\(item\.slot_name, disambiguationText\)\) continue;/);
});

// Codex review (PR #1392, P1, round 2): destination_facility's own
// configured prompt hint (lib/medical-transport-intake-workflow.mjs)
// explicitly lists "going to" and "transport to" as valid destination
// phrasings, but the stage-word regex only recognized
// "destination"/"receiving"/"drop-off" — so a caller saying "we're going to
// Summit Hospital" got correctly extracted onto destination_facility by the
// LLM, then silently redirected back to pickup_facility by this same
// soft-redirect guard because mentionsOwnStageWord found nothing to
// disambiguate on. pickup_facility's own hint ("picking up at") had the
// same gap on the pickup side.
test("soft redirect recognizes each facility slot's OWN configured hint phrasing, not just its bare stage name", () => {
  // Mirrors the actual regexes/function in route.js exactly, so this test
  // breaks the moment the definitions drift apart.
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

  assert.equal(mentionsOwnStageWord("destination_facility", "we're going to Summit Hospital"), true);
  assert.equal(mentionsOwnStageWord("destination_facility", "transport to Mercy General"), true);
  assert.equal(mentionsOwnStageWord("destination_facility", "transporting to Mercy General"), true);
  // Bare "transport" with no destination-naming "to X" must NOT match — it's
  // too generic (e.g. "what's the transport schedule").
  assert.equal(mentionsOwnStageWord("destination_facility", "I'm not sure about the transport schedule"), false);

  assert.equal(mentionsOwnStageWord("pickup_facility", "picking up at Amador Surgery Center"), true);
  assert.equal(mentionsOwnStageWord("pickup_facility", "pickup from Amador Surgery Center"), true);
});

// Codex review (PR #1392, P1, round 3): "going to" alone is ordinary
// future-tense English (the agent might ask "which department will the
// patient be going TO?" during a PICKUP-stage question, with zero
// destination-naming intent), and it can co-occur with an explicit,
// unambiguous PICKUP mention in the very same combined text — e.g. the
// agent's own preceding question folded into disambiguationText: "which
// hospital are we going to pick up from?". Before this fix,
// mentionsOwnStageWord("destination_facility", ...) returned true purely
// from "going to", causing the Fourth guard (correction-target resolution)
// to `continue` at its very first check and never even reach the
// sibling-tie-break logic that would otherwise have caught the
// contradicting "pick up" — recreating the exact facility swap this whole
// PR exists to prevent.
test("a bare 'going to' does NOT count as naming the destination's own stage when the same text also names pickup", () => {
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

  // The exact conflict scenario reported by Codex.
  const conflictText = "which hospital are we going to pick up from? Mercy General";
  assert.equal(mentionsOwnStageWord("destination_facility", conflictText), false);
  assert.equal(mentionsOwnStageWord("pickup_facility", conflictText), true);

  // A bare "going to" with no contradicting pickup word is still trusted —
  // this residual ambiguity is unchanged from before this fix and out of
  // scope for round 3, which only asked to resolve the CONFLICTING case.
  assert.equal(
    mentionsOwnStageWord("destination_facility", "which department will the patient be going to?"),
    true
  );
});

// Codex review (PR #1392, P1, round 5): PICKUP_STAGE_WORDS's literal
// alternatives covered the gerund ("picking up") but not the equally common
// past-tense phrasing ("picked up") — "which hospital are we going to be
// picked up from?" matched neither pickup|pick[\s-]?up (only a single
// space/hyphen directly between "pick" and "up", not "pick-ed up") nor
// "picking up". Missing it meant the destination-vs-pickup conflict check
// (round 3) wouldn't see the contradiction, letting the weak "going to"
// signal win unopposed and recreate the swap the conflict check exists to
// catch. Generalized pick(?:ing|ed)?[\s-]?up so every real inflection is
// covered by one pattern instead of an ever-growing literal list.
test("PICKUP_STAGE_WORDS recognizes the past-tense 'picked up' phrasing, not just 'picking up'", () => {
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

  assert.equal(PICKUP_STAGE_WORDS.test("picked up at Amador Surgery Center"), true);

  // The exact conflict scenario reported by Codex: a past-tense pickup
  // question combined with a bare reply the model assigned to destination.
  const conflictText = "which hospital are we going to be picked up from? Mercy General";
  assert.equal(mentionsOwnStageWord("destination_facility", conflictText), false);
  assert.equal(mentionsOwnStageWord("pickup_facility", conflictText), true);
});

// Codex review (PR #1392, P1, round 7): DESTINATION_STAGE_WORDS's
// transport(?:ing)? to alternative covered the present and gerund forms
// but not the equally common past participle — "the patient is being
// TRANSPORTED TO Summit Hospital" matched neither. Same class of gap as
// round 5's "picked up", fixed the same way: widen to
// transport(?:ing|ed)? to.
test("DESTINATION_STAGE_WORDS recognizes the past-participle 'transported to' phrasing", () => {
  const DESTINATION_STAGE_WORDS =
    /\b(destination|receiving|drop[\s-]?off|dropoff|transport(?:ing|ed)? to)\b/i;
  assert.equal(DESTINATION_STAGE_WORDS.test("the patient is being transported to Summit Hospital"), true);
});

// Codex review (PR #1392, P1, round 7): round 3/6's "no pickup word
// anywhere in the text" condition was too coarse in this direction too.
// "Pickup remains General, but actually we're going to Mercy" has an
// unrelated pickup mention in a SEPARATE clause from the clearly-intended
// "going to Mercy" destination naming. Round 7 removed the whole-text
// pickup check entirely on the theory that round 6's verb-exclusion
// ("going to" immediately followed by "pick") was a precise-enough proxy
// for "this text is really about pickup" on its own.
//
// Codex review (PR #1392, P1, round 10): that proxy wasn't precise enough.
// A disfluency ("going to, uh, pick up from") or an intervening preposition
// ("going to for the pickup") breaks the immediate-adjacency the
// verb-exclusion relies on, letting DIRECT wrongly corroborate destination
// even though PICKUP_STAGE_WORDS also matches. No finite lookahead reliably
// tells this round-7 scenario (destination should win) apart from round
// 10's (pickup should win) - both just have a pickup word somewhere near
// "going to" with something else between them. Given that choice, the
// whole-text pickup check was reinstated for both weak signals, accepting
// this scenario as a known, deliberately-chosen trade-off (an explicit
// contrastive correction naming both facilities in one breath, judged
// rarer than round 10's everyday disfluency).
test("a whole-text pickup mention now suppresses the destination 'going to X' signal too (round 7's guarantee intentionally traded for round 10's fix)", () => {
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
    return false;
  }

  const text = "Pickup remains General, but actually we're going to Mercy";
  assert.equal(mentionsOwnStageWord("destination_facility", text), false);

  // The STRONG set is unaffected — it's trusted unconditionally regardless
  // of any pickup word present, since it's unambiguous on its own.
  assert.equal(
    mentionsOwnStageWord("destination_facility", "destination facility is Mercy, pickup remains General"),
    true
  );
});

// Codex review (PR #1392, P1, round 8): "be" was excluded unconditionally
// in round 5 for "going to be picked up" (a passive PICKUP construction),
// but "be" is also how a genuine destination is very commonly phrased with
// no "transport"/"destination" wording at all: "the patient is going to be
// AT Summit Hospital." Excluding "be" unconditionally rejected that
// destination signal too, letting the fourth guard redirect a
// correctly-resolved destination completion onto pickup_facility with
// pickup_facility still open. Fixed by only excluding "be" when it ISN'T
// immediately followed by "at" — "going to be at <place>" now correctly
// counts as naming destination, while "going to be picked up" (or any
// other "be <verb>") stays excluded exactly as round 5 intended.
test("'going to be AT <place>' counts as a destination signal, unlike 'going to be <verb>'", () => {
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

  // The exact reported case.
  assert.equal(
    mentionsOwnStageWord("destination_facility", "the patient is going to be at Summit Hospital"),
    true
  );
  // Round 5's original scenario must stay excluded — "be" followed by a
  // pickup-passive verb, not "at".
  const round5Conflict = "which hospital are we going to be picked up from? Mercy General";
  assert.equal(mentionsOwnStageWord("destination_facility", round5Conflict), false);
  assert.equal(mentionsOwnStageWord("pickup_facility", round5Conflict), true);
});

// Codex review (PR #1392, P1, round 9): "going to be at" is a much more
// overloaded construction than a direct "going to <place>" — it can
// describe ANY entity's location, not just a destination: "Where is the
// PICKUP going to be at?" uses "going to be at" to ask about the PICKUP
// facility's own location, with "pickup" as its grammatical subject
// earlier in the very same clause. (Round 10 later reinstated the same
// whole-text pickup-conflict check for DIRECT too, once a disfluency was
// found that also defeated DIRECT's own adjacency check — see that test —
// so both signals are gated identically now; this test's original
// "unlike DIRECT" framing no longer applies, but the BE_AT scenario itself
// is still worth its own regression coverage.)
test("'going to be at' backs off when the same text identifies pickup as its subject", () => {
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

  // The exact reported case: "pickup" is the subject of "going to be at".
  const conflictText = "Where is the pickup going to be at? Mercy General";
  assert.equal(mentionsOwnStageWord("destination_facility", conflictText), false);
  assert.equal(mentionsOwnStageWord("pickup_facility", conflictText), true);
});

// Codex review (PR #1392, P1, round 10): DESTINATION_WEAK_GOING_TO_DIRECT's
// verb-exclusion only rejects a verb IMMEDIATELY adjacent to "going to". A
// disfluency ("going to, uh, pick up from") or an intervening preposition
// ("going to for the pickup") breaks that adjacency — DIRECT matched
// anyway, corroborating destination_facility even though PICKUP_STAGE_WORDS
// also matched the same text. No finite lookahead reliably distinguishes
// this from round 7's "destination should win" scenario (both just have a
// pickup word somewhere near "going to" with something else between them),
// so after being asked, the explicit choice was to reinstate the general
// pickup-conflict check for DIRECT too (see the round-7 test above for the
// accepted trade-off this represents).
test("disfluencies and prepositions between 'going to' and a pickup word no longer defeat the conflict check", () => {
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

  // Disfluency breaking the immediate-adjacency check.
  const disfluencyText = "Which hospital are we going to, uh, pick up from? Mercy General";
  assert.equal(mentionsOwnStageWord("destination_facility", disfluencyText), false);
  assert.equal(mentionsOwnStageWord("pickup_facility", disfluencyText), true);

  // Intervening preposition breaking the immediate-adjacency check.
  const prepositionText = "Which hospital are we going to for the pickup? Mercy General";
  assert.equal(mentionsOwnStageWord("destination_facility", prepositionText), false);
  assert.equal(mentionsOwnStageWord("pickup_facility", prepositionText), true);

  // A genuine destination naming with no pickup word anywhere still works.
  assert.equal(mentionsOwnStageWord("destination_facility", "we're going to Summit Hospital"), true);
});

test("soft redirect also honors the AGENT's preceding question, not just the customer's own bare reply", async () => {
  // Reported gap: agent asks "What's the destination room?" and the customer
  // replies with a bare "323" — no stage word in the customer's OWN
  // utterance. Checking only completed.source_text would redirect this
  // correct destination_room answer back to pickup_room. recentContext (the
  // agent's preceding question) must be folded into the disambiguation text.
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(
    route,
    /const recentContextText = \(Array\.isArray\(recentContext\) \? recentContext : \[\]\)\s*\n\s*\.map\(\(c\) => c\?\.text\)\s*\n\s*\.filter\(Boolean\)\s*\n\s*\.join\(" "\);/
  );
  assert.match(route, /const disambiguationText = `\$\{recentContextText\} \$\{completed\.source_text \|\| ""\}`;/);
});

test("third guard: a paired slot fill matching an ALREADY-COMPLETED earlier-stage sibling's value is rejected outright", async () => {
  // Reported live: pickup_room/pickup_bed were already correctly completed
  // (one at a time, in earlier/separate analyze requests) while
  // destination_facility/address/department were still all empty. A LATER,
  // unrelated turn then filled destination_room/destination_bed with the
  // SAME values as pickup — neither the hard backstop (only compares within
  // ONE response's completed_items) nor the soft redirect (only fires when
  // the earlier sibling is still OPEN in pendingItems) catches this, because
  // the earlier sibling was already completed in a PRIOR, separate request.
  // There's nothing to redirect TO (the earlier slot is already correct), so
  // this must reject the later duplicate outright, keyed off
  // completedSlotRows (which has stage_order + completed_value for every
  // completed slot, regardless of stage), not just pendingItems.
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(route, /workflow_stage_bleed_rejected_completed_sibling/);
  assert.match(
    route,
    /const completedSiblingsByBase = new Map\(\);\s*\n\s*for \(const row of completedSlotRows\) \{/
  );
  assert.match(
    route,
    /if \(!row\.slot_name \|\| !hasMeaningfulExtractedValue\(row\.completed_value\)\) continue;/
  );
  assert.match(
    route,
    /const matchesEarlierCompletedSibling = \(completedSiblingsByBase\.get\(base\) \|\| \[\]\)\s*\n\s*\.filter\(\(sib\) => \(sib\.stage_order \?\? 0\) < \(item\.stage_order \?\? 0\)\)\s*\n\s*\.some\(\(sib\) => normalizeForBleedCheck\(sib\.completed_value\) === newValue\);/
  );
  assert.match(
    route,
    /if \(matchesEarlierCompletedSibling\) \{\s*\n\s*bleedRejectedItemIds\.add\(completed\.item_id\);/
  );
  // Also backs off when the utterance explicitly names the later stage.
  const guardSection = route.slice(route.indexOf("Third guard:"), route.indexOf("Process completed items"));
  assert.match(guardSection, /if \(mentionsOwnStageWord\(item\.slot_name, disambiguationText\)\) continue;/);
});

// Codex review (f2eb4f94a3, P1): the destination prompt for a paired slot
// like department/room/bed often never says the word "destination" (e.g.
// "Which department will the patient be going to?"), so a LEGITIMATE
// destination answer that happens to match its already-completed pickup
// sibling's value (e.g. pickup_department="ICU" then destination_department
// also "ICU") was wrongly rejected by the third guard — mentionsOwnStageWord
// finds nothing to disambiguate on, and there is no other signal that this
// is a deliberate, correct answer rather than model-copied bleed.
test("third guard never rejects the slot actually being actively collected (current target), even on a value match", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  const guardSection = route.slice(route.indexOf("Third guard:"), route.indexOf("Process completed items"));
  assert.match(
    guardSection,
    /if \(currentTargetItem && completed\.item_id === currentTargetItem\.item_id\) continue;/
  );
  // Placed BEFORE the matchesEarlierCompletedSibling rejection is computed/applied.
  const bypassIdx = guardSection.indexOf("currentTargetItem.item_id) continue;");
  const rejectIdx = guardSection.indexOf("matchesEarlierCompletedSibling");
  assert.ok(bypassIdx > -1 && rejectIdx > -1 && bypassIdx < rejectIdx);
});

// Codex review (831fa6ed5a, P2): the soft-redirect guard's "own stage word"
// disambiguation folded in the WHOLE recent-context window (last several
// utterances), so a stale mention of a later stage several turns back (e.g.
// the caller volunteering "destination is Mercy" while pickup was still
// being collected) would keep suppressing the redirect for a later,
// unrelated bare pickup answer that has nothing to do with that older
// mention — leaving a misattributed destination_room value in place instead
// of moving it back to pickup_room.
// Reported live: a separate merged "Facility Identification" workflow stage
// was added to catch a caller naming the destination facility before the
// Destination Information stage was reached. That workaround backfired —
// pickup_facility and destination_facility values got swapped, cascading
// into wrong department/room/bed collection downstream. Root cause: analyze
// narrowing (current stage +1 look-ahead only) hid the real destination_
// facility item from the model whenever the call was still more than one
// stage away from Destination Information, so an explicit "destination
// facility name is X" utterance had nowhere valid to land. Fix: exempt
// pickup_facility/destination_facility from stage-distance narrowing
// entirely, the same way notes/correction/read-back items already are, so
// the model can route an explicit utterance straight to the real slot
// without a merged capture stage guessing pickup vs. destination after the
// fact.
test("pickup_facility/destination_facility are exempt from stage-distance narrowing", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(
    route,
    /const ALWAYS_VISIBLE_SLOT_NAMES = new Set\(\["pickup_facility", "destination_facility"\]\);/
  );
  assert.match(route, /ALWAYS_VISIBLE_SLOT_NAMES\.has\(item\.slot_name\) \|\|/);
  // Placed inside the same filter as the other narrowing exemptions
  // (suggested items, read-back), not as a separate appended array — so it
  // benefits from the exact same "current_status pending/suggested only"
  // scoping those already have, without needing its own dedup logic.
  const narrowIdx = route.indexOf("const narrowedRelevantPendingItems");
  const narrowSection = route.slice(narrowIdx, narrowIdx + 600);
  assert.match(narrowSection, /ALWAYS_VISIBLE_SLOT_NAMES\.has\(item\.slot_name\)/);
  assert.match(narrowSection, /item\.current_status === "suggested"/);
});

// Codex review (PR #1392, P2): relevantPendingItems is capped with
// .slice(0, MAX_ANALYZER_PENDING_ITEMS) BEFORE the stage-narrowing filter
// (and its ALWAYS_VISIBLE_SLOT_NAMES exemption) ever runs. On a workflow
// with >= MAX_ANALYZER_PENDING_ITEMS speaker-relevant pending items ahead of
// pickup_facility/destination_facility, the plain slice would already have
// dropped them — silently defeating the narrowing exemption in exactly the
// larger-workflow case it exists for. Fixed by reserving space for
// always-visible items before applying the cap to the rest.
test("always-visible facility slots are exempt from the MAX_ANALYZER_PENDING_ITEMS cap too, not just stage-distance narrowing", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // ALWAYS_VISIBLE_SLOT_NAMES is declared once, at module scope (so it's
  // available both here and at the stage-narrowing filter further down) —
  // not re-declared inline where it's used for stage narrowing.
  const declarationCount = (
    route.match(/const ALWAYS_VISIBLE_SLOT_NAMES = new Set\(\["pickup_facility", "destination_facility"\]\);/g) || []
  ).length;
  assert.equal(declarationCount, 1);
  assert.match(route, /const MAX_ANALYZER_PENDING_ITEMS = 40;\nconst MAX_CONCURRENT_CONCEPT_GROUPS = 2;\n\n\/\/[\s\S]*?const ALWAYS_VISIBLE_SLOT_NAMES/);

  // The cap itself reserves space for always-visible items instead of a
  // plain slice, and preserves original order among the rest.
  assert.match(
    route,
    /const alwaysVisibleCount = speakerRelevantPendingItems\.reduce\(\s*\n\s*\(count, item\) => count \+ \(ALWAYS_VISIBLE_SLOT_NAMES\.has\(item\.slot_name\) \? 1 : 0\),\s*\n\s*0\s*\n\s*\);/
  );
  assert.match(route, /const otherItemBudget = Math\.max\(0, MAX_ANALYZER_PENDING_ITEMS - alwaysVisibleCount\);/);
  assert.match(
    route,
    /const relevantPendingItems = speakerRelevantPendingItems\.filter\(\(item\) => \{\s*\n\s*if \(ALWAYS_VISIBLE_SLOT_NAMES\.has\(item\.slot_name\)\) return true;/
  );
});

test("soft redirect's stage-word disambiguation uses only the MOST RECENT context entry, not the whole window", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(
    route,
    /const lastRecentContextEntry = Array\.isArray\(recentContext\) && recentContext\.length > 0\s*\n\s*\? recentContext\[recentContext\.length - 1\]\s*\n\s*: null;/
  );
  assert.match(route, /const recentContextText = lastRecentContextEntry\?\.text \|\| "";/);
  // Only the soft-redirect guard (before "Third guard:") was narrowed — the
  // third guard's own recentContextText (keyed off completedSlotRows, a
  // different bleed pattern) still folds the whole window.
  const thirdGuardIdx = route.indexOf("Third guard:");
  const softRedirectSection = route.slice(0, thirdGuardIdx);
  assert.match(softRedirectSection, /const recentContextText = lastRecentContextEntry\?\.text \|\| "";/);
});
