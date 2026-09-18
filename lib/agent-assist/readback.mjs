/**
 * Agent Assist — final read-back helpers.
 *
 * At the confirmation step a workflow usually has a non-slot item like
 * "Confirm all information is correct" / "Read back transport details". The
 * generic suggestion generator is capped at two sentences and explicitly told
 * not to produce a summary, so it can never read back the collected slots. These
 * helpers build a deterministic read-back of every captured slot value that
 * bypasses that truncation, so the agent can confirm the whole intake at once.
 */

// Display mask for the spoken EMS-contact fragment only. This does NOT relax
// the an earlier fix constraint (raw digits in every API payload) — the read-back is
// a spoken script the agent reads aloud, never a payload; the raw value stays
// untouched in slots_filled.
import { formatPhoneSlotDisplay } from "./slot-display.mjs";

// Strong, finalization-specific phrases. Kept tight on purpose so mid-flow
// "summarize the issue" / "summarize their needs" items do NOT trigger a
// premature read-back — a bare "summarize" is intentionally not enough.
const READBACK_PATTERNS = [
  /read[\s-]?back/,
  /confirm all/,
  /all (?:the )?(?:information|details|info) (?:is|are) correct/,
  /everything (?:is|looks) (?:correct|right)/,
  /verify (?:the )?(?:details|information)/,
  /go over (?:the )?(?:details|information)/,
  /recap (?:the )?(?:details|information)/,
];

/**
 * Is this the finalization "read back / confirm all the collected info" item?
 * Slot items never qualify.
 */
export function isReadBackItem({ itemType, itemLabel, itemPromptHint, itemHints } = {}) {
  if (itemType === "slot") return false;
  const text = [itemLabel, itemPromptHint, ...(Array.isArray(itemHints) ? itemHints : [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text) return false;
  return READBACK_PATTERNS.some((re) => re.test(text));
}

// Codex review (P2 x2): "is"/"is not"/"isn't" alone don't distinguish a
// VALUE restatement ("pickup facility is not Sutter General") from an
// unrelated descriptive/state sentence using the exact same words ("the
// pickup facility isn't available on Sunday", "the patient is not on
// oxygen", "no, the pickup facility is operational"). This function feeds
// findCorrectionTargetSlot in suggestion-target-resolver.mjs directly, with
// no other gate protecting against a false trigger there — unlike the
// analyze-route correction path, which additionally requires the LLM to
// explicitly agree a captured value is wrong, a false positive here
// directly hijacks the suggestion panel with a bogus correction prompt.
// A genuine value correction is almost always followed by a NAME/VALUE,
// not one of these common descriptive predicates - excluded via negative
// lookahead in the two patterns below. Not exhaustive (a novel predicate
// not on this list could still false-positive), but covers the reported
// gap; same residual-risk acceptance already used elsewhere in this file
// (see the double-negative note further down).
//
// Codex review (round 5, P2): "scheduled" was on this list, but it's also
// a real, configured transport_timing option (lib/the reference workflow-healthcare-intake-
// workflow.mjs) - "No, transport timing is scheduled" is a GENUINE
// correction that this list would have wrongly excluded. Predicate words
// must never double as legitimate slot values; verified against every
// slot_options value in the seed workflow template.
//
// Codex review (round 5, P2): the lookahead only inspected the token
// IMMEDIATELY after is/is not/isn't, so a common adverb in between defeated
// it entirely ("is currently operational", "is definitely ready" both
// still matched as corrections). A first attempt consumed MODIFIER_WORDS
// with a greedy `(?:...)* ` ahead of the negative lookahead, but that's
// unsound: when the lookahead fails after consuming a modifier, the engine
// backtracks the `*` down to zero repetitions and re-checks the lookahead
// at the ORIGINAL position — which trivially passes because the modifier
// word itself ("currently") is never on the excluded-word list. That
// backtrack silently defeated the whole exclusion for every modifier case.
// Fixed by folding the optional modifier INTO the single static lookahead
// (`(?:modifier)?` immediately before the excluded-word alternation, all
// inside one `(?!...)`) so there is no repetition for the engine to
// backtrack — the check is one fixed assertion, not a search over splits.
// This only strips a single leading modifier (not several stacked ones),
// which matches how the phrase is actually spoken ("is currently
// operational", not "is currently definitely operational").
const MODIFIER_WORD =
  "(?:currently|definitely|probably|certainly|really|actually|still|now|already|finally|totally|completely|quite|pretty|very|just)\\s+";
const EXCLUDED_PREDICATE_WORDS =
  "available\\b|open\\b|closed\\b|ready\\b|done\\b|here\\b|there\\b|active\\b|online\\b|working\\b|operational\\b|possible\\b|allowed\\b|stable\\b|ok\\b|okay\\b|fine\\b|on\\b|in\\b|at\\b|due\\b";
const NON_VALUE_PREDICATE_LOOKAHEAD =
  `(?!(?:${MODIFIER_WORD})?(?:${EXCLUDED_PREDICATE_WORDS}))`;

// Phrases that flag "the value I gave earlier is wrong" at the read-back step.
// Used to detect that a correction is already in progress in the recent
// conversation, so a bare restatement right after doesn't need to repeat this
// framing every time (see mentionsCorrectionTrigger below) — e.g. STT mangles
// a hospital name differently on each retry ("Twin Hill" / "Stonemere" /
// "John Miller" for "John Mabry Hospital"), and the caller keeps just repeating
// the name rather than re-explaining that it's still wrong.
const CORRECTION_TRIGGER_PATTERNS = [
  /incorrect/,
  /\bwrong\b/,
  /not correct/,
  /\bmistake\b/,
  /\berror\b/,
  /that'?s not (?:it|right)/,
  /change (?:it|that|this)/,
  /actually,? it'?s/,
  /\bcorrection\b/,
  /\bno[,.]?\s+(?:wait|actually)\b/,
  // "I want to change the date of birth" / "I'd like to update the room" —
  // named-field corrections, not just the pronoun form ("change it/that").
  /\b(?:want|wants|wanted|wish|wishes|'d like|would like)\s+to\s+(?:updat|chang|fix|correct)/,
  // an earlier fix follow-up: phrasings verified live that matched NOTHING above, so
  // the correction window never opened and the restated value was dropped.
  //
  // "change the room number to 302" / "update the DOB to 1970" — the named-
  // field imperative with an explicit new value. Same shape clauseIsRejection
  // already accepts at read-back via EXPLICIT_CHANGE_TO_VALUE; mirrored here
  // so a MID-CALL utterance of the identical sentence opens the window too.
  // ("make" is deliberately absent — "make sure to..." is everyday speech;
  // the retraction form has its own "make that" pattern below.)
  /\b(?:change|update)\b[^.!?]*\bto\b/,
  // "the room needs to be changed" / "that needs updating" — necessity
  // phrasing, minus the negated form ("no need to change anything").
  /(?<!\bno )(?<!\bdon'?t )(?<!\bdoesn'?t )\bneeds? (?:to (?:be |get )?)?(?:updat|chang|fix|correct)/,
  // "let me update the room number" / "let me fix that" — the agent-side
  // announcement of a correction (the exact phrasing from an earlier fix's report).
  /\blet me (?:updat|chang|fix|correct)/,
  // "it's actually 302" — the inverted form of "actually, it's" above.
  /\bit'?s actually\b/,
  // "it should be 302" / "that should actually be Huron" — a stated
  // replacement for something already captured.
  /\bshould (?:actually )?be\b/,
  // "make that 302" (without "to"), "scratch that", "I misspoke", "my bad" —
  // short spoken-register retractions.
  /\bmake that\b/,
  /\bscratch that\b/,
  /\bmisspoke\b/,
  /\bmy bad\b/,
  // "sorry, 302 not 203" / "302, not 203" — a digit contrast: "not"
  // sandwiched between values, preceded by a digit to keep it away from
  // ordinary negation ("I'm not sure"). The word-contrast form ("sorry,
  // Huron not Hearne") is handled by SORRY_VALUE_CONTRAST below, which
  // checks the token BEFORE "not" — a plain apology plus uncertainty
  // ("sorry, I'm not sure") must NOT open correction mode.
  /\d\s*,?\s+not\s+\w/,
  // Reported live: "No. Pickup facility is delta." and "Pickup facility
  // name is not Sutter Amador Surgery Center." both matched NOTHING above —
  // the existing "no, wait/actually" pattern requires one of those two
  // specific words right after "no", not the far more natural "No, <field>
  // is <value>" restatement. Repeated across five separate utterances, the
  // correction window never opened, and every attempt was silently dropped
  // (the bare word "Delta" then landed on the nearest unrelated OPEN slot,
  // pickup_department, instead).
  //
  // A leading "no" is not enough on its own — "no need to change anything"
  // is a deliberately-tested false-positive guard elsewhere in this file
  // and must stay excluded. Requiring a later "is" as well keys on the
  // actual restatement shape ("no, <field> is <value>") rather than just
  // the presence of "no" anywhere in the sentence. See
  // NON_VALUE_PREDICATE_LOOKAHEAD above for why "is" alone still isn't
  // enough ("no, the pickup facility is operational" must NOT match).
  //
  // Codex review (round 5, P1): suggestion-target-resolver.mjs's
  // findCorrectionTargetSlot calls mentionsCorrectionTrigger with up to the
  // LAST 8 transcripts joined with " \n" (latestConversationText), not a
  // single utterance like analyze/route.js passes. A bare ^ (no multiline
  // flag) only matches the very start of that WHOLE joined blob, so "No,
  // pickup facility is Delta" is recognized only when it happens to be the
  // very first of the last 8 lines - effectively never true for a genuine
  // mid-call correction with any preceding conversation. The "m" flag makes
  // ^ match at the start of each joined line instead.
  new RegExp(`^no\\b.*\\bis\\s+${NON_VALUE_PREDICATE_LOOKAHEAD}`, "im"),
  // "<field> is not <value>" / "<field> isn't <value>" — explicit negation
  // of the value just captured, not a coincidental "not" elsewhere ("I'm
  // not sure" / "that's not necessary" don't contain "is not" or "isn't"),
  // and not a descriptive/state predicate using the same words (see
  // NON_VALUE_PREDICATE_LOOKAHEAD above).
  new RegExp(`\\b(?:is not|isn'?t)\\s+${NON_VALUE_PREDICATE_LOOKAHEAD}`, "i"),
];

// "sorry, Huron not Hearne" — an apology followed by an X-not-Y value
// contrast. The regex alone cannot tell a contrast from ordinary negated
// uncertainty ("sorry, I'm not sure", "sorry, I do not know the room
// number"), so the token captured immediately before "not" is tested
// against the auxiliary/pronoun words that introduce negation rather than
// contrast a value.
const SORRY_VALUE_CONTRAST = /\bsorry\b[^.!?]*?\b([\w''-]+),?\s+not\s+[\w''-]/;
const NON_CONTRAST_BEFORE_NOT = new Set([
  "am", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "don't", "doesn't", "didn't", "dont", "doesnt", "didnt",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "have", "has", "had", "i", "i'm", "im", "we", "we're", "you", "you're",
  "they", "they're", "he", "he's", "she", "she's", "it", "it's", "its",
  "that", "that's", "thats", "this", "there", "there's", "theres",
  "really", "just", "still", "probably", "definitely", "certainly", "maybe",
  "m", "s", "re",
]);

/**
 * Does this text explicitly flag that a previously given value is wrong?
 */
export function mentionsCorrectionTrigger(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (CORRECTION_TRIGGER_PATTERNS.some((re) => re.test(t))) return true;
  const contrast = SORRY_VALUE_CONTRAST.exec(t);
  return Boolean(contrast && !NON_CONTRAST_BEFORE_NOT.has(contrast[1]));
}

// Clause-aware rejection check used specifically to gate the read-back
// affirmative backstop below. A plain word-proximity regex (no negation
// handling) proved unreliable in both directions:
//   - Unconditionally rejecting on a bare "wrong"/"error" false-rejects a
//     NEGATED rejection word — "Nothing is wrong, everything is correct" /
//     "No error, everything is correct" are valid affirmatives.
//   - Unconditionally treating "correct"/"right"/"good"/"fine" near
//     "all"/"everything" as affirmative false-ACCEPTS a genuine rejection —
//     "No, not all the information is correct" / "It is not all correct" /
//     "No, not everything is right" / "It's not all good" all contain an
//     affirmative-looking anchor word but are explicit rejections.
// Splitting into clauses (on punctuation/"but") and reasoning per-clause
// fixes both: a negator and its rejection word must share a clause to
// cancel out ("nothing is wrong" — same clause, cancels), and a negator
// elsewhere doesn't reach across clause boundaries to falsely cancel an
// unrelated one ("I wouldn't change that, everything is correct" — the
// negation is about CHANGING, in a different clause than "correct").
function splitClauses(text) {
  return String(text || "").split(/[,.;!?]+|\bbut\b/);
}

const NEGATOR_WORDS = /\b(?:not|no|nothing|never)\b/;
// Every anchor word GENERIC_READBACK_AFFIRMATIVE_PATTERNS below treats as an
// affirmative signal — must match that set exactly, or a negated clause
// using one of the words this list is MISSING slips past both checks (see
// "not everything is right" / "not all good", the reported gap).
const AFFIRMATIVE_ANCHOR_WORDS = /\b(?:correct|right|good|fine)\b/;
// Never a valid way to say "yes" regardless of negation — a double-negative
// ("not incorrect", "no mistake") is rare enough in natural speech to accept
// the residual risk rather than add more special-casing.
const UNCONDITIONAL_REJECTION_WORDS = /\b(?:incorrect|mistake|correction)\b/;
// Common enough to appear negated ("nothing wrong", "no error") that they
// must NOT trigger rejection when a negator shares the same clause.
const NEGATABLE_REJECTION_WORDS = /\b(?:wrong|error)\b/;
// "change the DOB TO 1970" / "update the room TO 402" — an explicit new
// value is an actionable correction even when introduced with a leading
// affirmative ("Yes, please change..."). Requires "to" AFTER change/update
// in the same clause (not just "change it") so "no need to change it,
// everything is correct" (already cancelled by NEGATOR_WORDS) and "I
// wouldn't change that" (no "to" at all) are unaffected.
const EXPLICIT_CHANGE_TO_VALUE = /\b(?:change|update)\b[^.!?]*\bto\b/i;
// "the DOB needs updating" / "we need to change the room" — a clause stating
// something STILL needs changing is a correction independent of how it's
// introduced ("but", "also", a plain statement, ...). Excludes a NEGATED
// need ("no need to change it", "don't need to update") — that's the
// opposite of a correction, and collides with this pattern since "no need
// TO change" contains "need" immediately followed by "to change".
const NEEDS_UPDATE_WORDS = /\bneeds? (?:to (?:be |get )?)?(?:updat|chang|fix|correct)/i;
const NEGATED_NEED = /\b(?:no|don'?t|doesn'?t|didn'?t)\s+needs?\b/i;
// "I want to change the date of birth" / "I'd like to update the room" — a
// clause expressing a DESIRE to change something is a correction request
// just as much as NEEDS_UPDATE_WORDS's necessity-phrased version, and is at
// least as common in natural speech. Reported live: "Yeah. I want to change
// the date of birth." — the leading "Yeah" alone matched the generic
// affirmative pattern below, and this desire-to-change clause matched NONE
// of the existing rejection patterns (no "to X" value, no "need", no
// negation, no "wrong"/"incorrect"), so the read-back item was wrongly
// marked confirmed by a customer who was actually mid-correction. Excludes a
// negated desire ("I don't want to change anything") — the opposite of a
// correction.
const WANTS_TO_CHANGE_WORDS = /\b(?:want|wants|wanted|wish|wishes|'d like|would like)\s+to\s+(?:updat|chang|fix|correct)/i;
const NEGATED_WANT = /\b(?:no|don'?t|doesn'?t|didn'?t|not)\s+(?:want|wants|wanted|wish|wishes)\b/i;

function clauseIsRejection(clause) {
  if (UNCONDITIONAL_REJECTION_WORDS.test(clause)) return true;
  if (EXPLICIT_CHANGE_TO_VALUE.test(clause)) return true;
  if (NEEDS_UPDATE_WORDS.test(clause) && !NEGATED_NEED.test(clause)) return true;
  if (WANTS_TO_CHANGE_WORDS.test(clause) && !NEGATED_WANT.test(clause)) return true;
  // "not correct" / "not all correct" / "not everything is right" / "not
  // all good" — any negator sharing a clause with an affirmative anchor
  // word is a rejection.
  if (AFFIRMATIVE_ANCHOR_WORDS.test(clause) && NEGATOR_WORDS.test(clause)) return true;
  // "wrong"/"error" alone (not negated in this clause) is a rejection;
  // "actually, it's Saint Mary's" (a correction with no rejection word at
  // all) is handled by the caller separately requiring an affirmative match.
  if (NEGATABLE_REJECTION_WORDS.test(clause) && !NEGATOR_WORDS.test(clause)) return true;
  if (/that'?s not (?:it|right)/.test(clause)) return true;
  return false;
}

// A partial/exception qualifier — "Yes, EXCEPT the DOB", "Everything is
// correct EXCEPT the destination", "Almost everything is correct" — means
// the caller is NOT giving a full sign-off; a specific item still needs
// review. Checked against the WHOLE text rather than per-clause, since the
// exception commonly trails well after the affirmative-looking phrase
// ("Everything is correct except the destination" is one clause with no
// punctuation/negator for clauseIsRejection to key on).
const PARTIAL_EXCEPTION_PATTERNS = [
  /\bexcept\b/,
  /\bexcluding\b/,
  /\bother than\b/,
  /\baside from\b/,
  /\bapart from\b/,
  /\balmost\b/,
  /\bmostly\b/,
];

function mentionsPartialException(text) {
  return PARTIAL_EXCEPTION_PATTERNS.some((re) => re.test(text));
}

function mentionsUnambiguousRejection(text) {
  if (/\bno[,.]?\s+(?:wait|actually)\b/.test(text)) return true;
  if (mentionsPartialException(text)) return true;
  return splitClauses(text).some(clauseIsRejection);
}

// Generic customer-affirmative phrases, independent of any item's own
// configured `hints`. Necessary because `hints` is commonly auto-derived by
// splitting the item's prompt_hint on commas (see
// scripts/upsert-medical-transport-intake-workflow.mjs) — e.g. "is that
// correct, anything to change, does everything look right, accurate" for a
// "Confirm all information is correct" item. Those are phrases describing
// the QUESTION an agent asks, not things a customer says back ("Yes.", "I
// can confirm all information is correct."). Relying on item.hints alone
// left this backstop silently non-functional for the exact replies it
// exists to catch — confirmed live: a customer's explicit "Yes." /
// "I can confirm all information is correct." never matched any of that
// item's hints, so the deterministic backstop never fired.
const GENERIC_READBACK_AFFIRMATIVE_PATTERNS = [
  /^(?:yes|yeah|yep|yup|correct|confirmed)\b/,
  /\bconfirm(?:s|ed|ing)?\b[\s\S]*\bcorrect\b/,
  /\ball\b[\s\S]*\bcorrect\b/,
  /\beverything\b[\s\S]*\b(?:correct|right|good|fine)\b/,
  /\b(?:that'?s|it'?s)\s+(?:all\s+)?(?:correct|right)\b/,
  /\bsounds good\b/,
  /\blooks good\b/,
  /\ball good\b/,
];

function mentionsGenericReadBackAffirmative(text) {
  return GENERIC_READBACK_AFFIRMATIVE_PATTERNS.some((re) => re.test(text));
}

/**
 * Deterministic backstop for the read-back "confirm all information is
 * correct"-style item. In live testing the LLM repeatedly failed to flag this
 * one, single, extremely high-value completion despite an unambiguous
 * customer affirmative ("all information is correct") being clearly present
 * in its context — everything was correctly presented to it (the item was in
 * view, narrowing/isReadBackStage were correctly true, the prompt explicitly
 * told it when to mark this complete), it just missed the extraction. Rather
 * than keep relying solely on the model's judgment for this one case, check
 * the raw transcript directly against the item's OWN configured hints
 * (data-driven — a workflow author's edits to those hints apply here too,
 * same as they do for the LLM prompt) and treat an obvious substring match as
 * a deterministic completion signal.
 *
 * Deliberately narrow in scope: callers should only apply this when already
 * certain of context (customer speaker, at the read-back stage, item not
 * already completed) — this function only answers "does the text look like
 * an affirmative to THIS item's own hints", not whether it's safe to act on.
 *
 * A flat rejection or correction must never count as an affirmative, even
 * when the rejection phrase itself happens to contain one of the item's own
 * hint words — e.g. hint "correct" sitting inside "No, that's NOT correct."
 * Checked first so a hint substring match can't override an explicit
 * rejection. Deliberately does NOT reject on a bare leading "no" alone: the
 * read-back prompt itself is phrased as "...or is there anything you'd like
 * to change?", so "No, everything is correct" / "No changes" are the most
 * common valid affirmative replies and must still be allowed through to the
 * hint check below. The rejection check (mentionsUnambiguousRejection) is
 * clause-aware rather than a flat word-proximity match, in both directions:
 * a negated rejection word ("Nothing is wrong", "No error") is NOT a
 * rejection, and a negator sharing a clause with "correct" ("not all the
 * information is correct") IS a rejection even though "all"/"correct" alone
 * would otherwise look affirmative.
 *
 * Matches against the item's own configured hints OR a built-in generic
 * customer-affirmative pattern list — not hints alone. item.hints is
 * commonly auto-derived from the item's prompt_hint (agent-question-framed
 * text), which a customer's own affirmative reply frequently won't overlap
 * with at all; the generic patterns are the actual safety net for that case.
 */
export function matchesReadBackAffirmativeHints(transcript, item) {
  const text = String(transcript || "").toLowerCase().trim();
  if (!text) return false;
  if (mentionsUnambiguousRejection(text)) return false;
  if (mentionsGenericReadBackAffirmative(text)) return true;
  const hints = Array.isArray(item?.hints) ? item.hints : [];
  return hints.some((hint) => {
    const h = String(hint || "").toLowerCase().trim();
    return h.length > 0 && text.includes(h);
  });
}

/**
 * Did the AGENT just recite the read-back summary? Deterministic completion
 * for the "Read back transport details" action (the reference workflow request, Aug 12: the
 * confirmation must move on once the agent speaks it) — the LLM path exists
 * but has been seen to miss it, and a missed recitation stalls the panel on
 * the read-back card and caps completion below 100%.
 *
 * Matches on DISTINCTIVE SLOT VALUES rather than the generated template
 * string: the recitation is long, STT-noisy, and agents paraphrase, but the
 * captured values (names, facilities, dates) are the load-bearing content —
 * several of them landing in ONE agent utterance is what distinguishes a
 * recitation from the agent confirming a single slot mid-call. For a
 * multi-word value a majority of its tokens must appear (STT mangles one
 * word of "Lakeview Memorial Hospital", rarely all).
 */
const RECITATION_VALUE_SENTINELS = new Set(["yes", "no", "n/a", "na", "none", "unknown", "true", "false"]);

function normalizeForRecitation(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesAgentRecitation(transcript, slotsFilled) {
  const utterance = normalizeForRecitation(transcript);
  if (!utterance || utterance.split(" ").length < 8) return false;
  // Whole-word evidence only: substring hits let "no" match inside "north"
  // and short values ride along inside unrelated words (Codex P1 on #1367).
  const utteranceWords = new Set(utterance.split(" "));

  // The evidence pool is what the generated summary actually SPEAKS (Codex
  // fourth pass on #1367): for a transport intake, the same fragments
  // buildTransportReadBack reads aloud — minus dates/weights/phones, whose
  // stored forms ("1958-06-15", "9405550192") a spoken recitation never
  // reproduces verbatim. Basing the bar on all captured slots either
  // inflated it with impossible evidence or let an abbreviated route check
  // clear a fixed cap while whole summary fields went unread.
  const rawSlots = slotsFilled || {};
  const poolSource = isTransportIntake(rawSlots)
    ? transportRecitationValues(rawSlots)
    : Object.values(rawSlots).map((raw) => formatSlotValue(raw));
  const distinctive = [];
  for (const candidate of poolSource) {
    const value = normalizeForRecitation(candidate);
    if (!value || value.length < 3 || RECITATION_VALUE_SENTINELS.has(value)) continue;
    const hasSpeakableToken = value.split(" ").some((t) => t.length >= 3 && /[a-z]/.test(t));
    if (!hasSpeakableToken) continue;
    if (!distinctive.includes(value)) distinctive.push(value);
  }
  if (distinctive.length === 0) return false;

  // Token frequency across the pool: a token shared by several values
  // ("hospital") discriminates nothing and cannot carry a match by itself.
  const tokenOwners = new Map();
  const tokensOf = (value) => value.split(" ").filter((t) => t.length >= 3);
  for (const value of distinctive) {
    for (const t of new Set(tokensOf(value))) {
      tokenOwners.set(t, (tokenOwners.get(t) || 0) + 1);
    }
  }

  let matched = 0;
  for (const value of distinctive) {
    const tokens = tokensOf(value);
    if (tokens.length === 0) continue;
    const hits = tokens.filter((t) => utteranceWords.has(t));
    // A value matches when at least half its tokens appear (tolerating one
    // STT-mangled word of "Riverside Medical") AND at least one matched
    // token belongs to THIS value alone within the pool — shared generic
    // words are corroboration, never sole evidence.
    const hasDiscriminatingHit = hits.some((t) => tokenOwners.get(t) === 1);
    if (hits.length * 2 >= tokens.length && hasDiscriminatingHit) matched++;
  }

  // Coverage, not a fixed cap: nearly every field the summary speaks must
  // land in the one utterance (all but one, floor 3). An abbreviated route
  // check that never reads the reason or notes stays short; a genuine
  // recitation of the summary carries them, and per-value half-token
  // tolerance absorbs word-level STT noise. Pools too small to clear the
  // floor simply never match — the LLM path remains primary there.
  const required = Math.max(3, distinctive.length - 1);
  return matched >= required;
}

// The values the transport confirmation sentence actually reads aloud, in
// their spoken forms — the evidence basis for matchesAgentRecitation. Dates,
// weights and phone numbers are deliberately absent: their stored/masked
// forms never match STT output word-for-word, so they can only add
// impossible-to-satisfy requirements.
function transportRecitationValues(rawSlots) {
  const values = [];
  const push = (value) => {
    if (value) values.push(value);
  };
  push(spoken(rawSlots, "patient_name"));
  push(spoken(rawSlots, "pickup_facility"));
  push(spoken(rawSlots, "pickup_department"));
  push(spoken(rawSlots, "destination_facility"));
  push(spoken(rawSlots, "destination_department"));
  const reason = spoken(rawSlots, "transport_reason");
  push(reason ? formatReasonForSpeech(reason) : null);
  const timing = spoken(rawSlots, "transport_timing");
  push(timing ? formatReasonForSpeech(timing) : null);
  push(spoken(rawSlots, "special_equipment"));
  push(spoken(rawSlots, "sending_physician"));
  push(spoken(rawSlots, "receiving_physician"));
  push(spoken(rawSlots, "trip_notes"));
  return values;
}

/**
 * Given workflow items ALREADY in workflow order (stage, then item), return the
 * id of the earliest read-back-matching item, or null if none match. Lets the
 * caller ensure only the first read-back item recites the full list, so an
 * adjacent "confirm all information" follow-up doesn't repeat every slot.
 */
export function earliestReadBackItemId(orderedItems) {
  const match = (Array.isArray(orderedItems) ? orderedItems : []).find((it) =>
    isReadBackItem({
      itemType: it?.type,
      itemLabel: it?.label,
      itemPromptHint: it?.prompt_hint,
      itemHints: it?.hints,
    })
  );
  return match?.id ?? null;
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

/**
 * Format a captured value for a spoken read-back. Boolean slots (#1118) come
 * through as true/false — read those as "Yes"/"No" instead of "true"/"false".
 */
export function formatSlotValue(value) {
  if (value === true || value === "true") return "Yes";
  if (value === false || value === "false") return "No";
  return String(value).trim();
}

/** "patient_name" -> "Patient Name" */
export function humanizeSlotName(slotName) {
  return String(slotName || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Turn a { slot_name: value } map into an ordered [{ label, value }] list,
 * dropping empties. `labelBySlot` supplies human labels; missing ones fall back
 * to a humanized slot name. Preserves the map's own key order.
 */
export function orderedSlotsFromMap(prefilledSlots, labelBySlot = {}) {
  return Object.entries(prefilledSlots || {})
    .filter(([, value]) => hasValue(value))
    .map(([slotName, value]) => ({
      label: labelBySlot[slotName] || humanizeSlotName(slotName),
      value: formatSlotValue(value),
    }));
}

/**
 * Compose the spoken read-back line from an ordered [{ label, value }] list.
 * When rawSlots is provided and contains air-transport intake keys, uses a
 * compact one-liner format instead of the generic label: value list.
 * Returns null when there is nothing collected.
 */
export function buildReadBackSuggestion({ orderedSlots, rawSlots } = {}) {
  if (rawSlots && isTransportIntake(rawSlots)) {
    return buildTransportReadBack(rawSlots);
  }

  const entries = (Array.isArray(orderedSlots) ? orderedSlots : []).filter(
    (s) => s && hasValue(s.value) && String(s.label || "").trim() !== ""
  );
  if (entries.length === 0) return null;

  const list = entries.map(({ label, value }) => `${label}: ${value}`).join(". ");
  return `Let me read back what I have to make sure everything is correct. ${list}. Is that all correct, or is there anything you'd like to change?`;
}

// Exported so callers can tell which buildReadBackSuggestion branch fired
// without duplicating this check — the transport branch (buildTransportReadBack)
// returns compact data lines with no trailing confirmation question, unlike
// the generic branch just above which always asks one itself.
export function isTransportIntake(rawSlots) {
  return !!(rawSlots.patient_name || rawSlots.pickup_facility || rawSlots.destination_facility);
}

function v(rawSlots, key) {
  const val = rawSlots[key];
  if (val === null || val === undefined) return null;
  if (val === true || val === "true") return "Yes";
  if (val === false || val === "false") return "No";
  const str = String(val).trim();
  return str === "" ? null : str;
}

// "no value" sentinels: a slot resolved as not-applicable (e.g. an inferred
// bed) is real data for the checklist but reads badly spoken aloud — the
// narrative just omits that fragment.
const SPOKEN_NA = new Set(["n/a", "na", "none", "unknown"]);
function spoken(rawSlots, key) {
  const value = v(rawSlots, key);
  if (!value) return null;
  return SPOKEN_NA.has(value.toLowerCase()) ? null : value;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "1958-06-15" -> "Jun 15, 1958". Anything that isn't a plain ISO date (the
// shape the analyzer normalizes date slots to) is spoken as captured.
function formatDobForSpeech(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!m) return value;
  const [, year, month, day] = m;
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) return value;
  return `${monthName} ${Number(day)}, ${year}`;
}

// "198", "198 lbs", "198 pounds" -> "198 lbs (90 kg)"; "90 kg" -> "90 kg
// (198 lbs)". The captured unit stays primary; a bare number is assumed lbs
// (US intake). Unparseable weights are spoken as captured.
function formatWeightForSpeech(value) {
  const m = /^(\d+(?:\.\d+)?)\s*(lbs?|pounds?|kgs?|kilograms?)?\.?$/i.exec(String(value || "").trim());
  if (!m) return value;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return value;
  const unit = (m[2] || "lbs").toLowerCase();
  if (unit.startsWith("k")) {
    return `${amount} kg (${Math.round(amount / 0.45359237)} lbs)`;
  }
  return `${amount} lbs (${Math.round(amount * 0.45359237)} kg)`;
}

// Select-slot values are stored snake_case ("cardiac_cath"); spoken form is
// title-cased words. Free-text reasons (already containing spaces or
// capitals) pass through untouched.
function formatReasonForSpeech(value) {
  const s = String(value || "").trim();
  if (!s || /[A-Z\s]/.test(s)) return s;
  return s
    .split(/_+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// A location fragment: "Maplewood Regional Medical Center, Emergency
// Department, room 412, bed B" — facility and department when present,
// room/bed only when they carry a real value.
function locationFragment(rawSlots, prefix) {
  const parts = [];
  const facility = spoken(rawSlots, `${prefix}_facility`);
  const dept = spoken(rawSlots, `${prefix}_department`);
  const room = spoken(rawSlots, `${prefix}_room`);
  const bed = spoken(rawSlots, `${prefix}_bed`);
  if (facility) parts.push(facility);
  if (dept) parts.push(dept);
  if (room) parts.push(`room ${room}`);
  if (bed) parts.push(`bed ${bed}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

// The spoken confirmation summary, one narrative sentence (the reference workflow-requested
// format, Aug 12):
//
//   "We're transferring Marcus Webb, DOB Jun 15, 1958, 198 lbs (90 kg) —
//    from Maplewood Regional Medical Center, Emergency Department to
//    Riverside Medical, Cath Lab — reason: STEMI Alert. 2 IV drip(s),
//    companion: Yes. Notes: STEMI patient. Aspirin given, heparin drip
//    running. Wife accompanying. EMS contact: 940-555-0192."
//
// Missing fragments are OMITTED (an "N/A" mid-sentence reads badly aloud);
// captured booleans render Yes/No, the DOB is reformatted for speech, the
// weight carries its unit conversion, and the callback number is spoken in
// the 3-3-4 display mask. Physicians/equipment/timing are appended as short
// clauses when captured so the caller still reviews everything collected.
function buildTransportReadBack(rawSlots) {
  const name = spoken(rawSlots, "patient_name");
  const dob = spoken(rawSlots, "patient_dob");
  const weight = spoken(rawSlots, "patient_weight");

  let opening = `We're transferring ${name || "the patient"}`;
  if (dob) opening += `, DOB ${formatDobForSpeech(dob)}`;
  if (weight) opening += `, ${formatWeightForSpeech(weight)}`;

  const pickup = locationFragment(rawSlots, "pickup");
  const destination = locationFragment(rawSlots, "destination");
  if (pickup) opening += ` — from ${pickup}`;
  if (destination) opening += `${pickup ? "" : " —"} to ${destination}`;

  const reason = spoken(rawSlots, "transport_reason");
  if (reason) opening += ` — reason: ${formatReasonForSpeech(reason)}`;
  const sentences = [`${opening}.`];

  const details = [];
  const ivCount = spoken(rawSlots, "iv_count");
  if (ivCount) details.push(`${ivCount} IV drip(s)`);
  const companion = v(rawSlots, "accompanying");
  if (companion) details.push(`companion: ${companion}`);
  // Required the reference workflow scheduling detail — the caller must review it (Codex fifth
  // pass on #1367). Select values humanize like the reason ("emergent" ->
  // "Emergent", "as_soon_as_possible" -> "As Soon As Possible").
  const timing = spoken(rawSlots, "transport_timing");
  if (timing) details.push(`timing: ${formatReasonForSpeech(timing)}`);
  const equip = spoken(rawSlots, "special_equipment");
  if (equip) details.push(`equipment: ${equip}`);
  if (details.length > 0) sentences.push(`${details.join(", ")}.`);

  const sendingPhysician = spoken(rawSlots, "sending_physician");
  if (sendingPhysician) sentences.push(`Sending physician: ${sendingPhysician}.`);
  const receivingPhysician = spoken(rawSlots, "receiving_physician");
  if (receivingPhysician) sentences.push(`Receiving physician: ${receivingPhysician}.`);

  const notes = spoken(rawSlots, "trip_notes");
  if (notes) sentences.push(`Notes: ${notes.replace(/\.+$/, "")}.`);

  const callback = spoken(rawSlots, "callback_number");
  if (callback) sentences.push(`EMS contact: ${formatPhoneSlotDisplay(callback)}.`);

  return sentences.join(" ");
}
