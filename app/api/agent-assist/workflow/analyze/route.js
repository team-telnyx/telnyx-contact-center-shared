/**
 * Agent Assist Workflow - Analyze API
 * POST - Analyze transcript for workflow item completion and slot extraction
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { analyzeWorkflowTranscript } from "@/lib/agent-assist/workflow-analyzer";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import { runAndPersistSlotMcpBindings } from "@/lib/agent-assist/slot-mcp-execute";
import { isReadBackItem, mentionsCorrectionTrigger, matchesReadBackAffirmativeHints, matchesAgentRecitation } from "@/lib/agent-assist/readback.mjs";
import { isAccumulatingSlot, accumulateSlotValue } from "@/lib/agent-assist/slot-accumulate.mjs";
import { resolveInferredBeds, NO_BED_VALUE, INFERRED_BY } from "@/lib/agent-assist/room-bed-inference.mjs";
import { computeConceptGroups, classifyUtteranceGroup } from "@/lib/agent-assist/concept-groups.mjs";
import { reconcileDerivedSlots } from "@/lib/agent-assist/derived-slot-reconciliation.mjs";
import { withPermission } from "@/lib/authz/guard";

// How many pending items to send the analyzer per utterance. The old cap of 12
// starved larger intakes: on a 24+ slot workflow the first 12 pending items only
// reach the Destination stage, so Patient / Clinical / Trip-notes / Air-safety
// slots were NEVER analyzed and could not capture. Widened to cover realistic
// workflows — the output stays small (only matched items are returned) and the
// analyzer's max_tokens already scales with item count.
const MAX_ANALYZER_PENDING_ITEMS = 40;
const MAX_CONCURRENT_CONCEPT_GROUPS = 2;

// Always exempt from BOTH the MAX_ANALYZER_PENDING_ITEMS cap below and
// stage-distance narrowing further down (see narrowedRelevantPendingItems) —
// see the narrowing-exemption comment there for why these two slots must
// stay visible to the analyzer regardless of stage. Declared here (not
// inline where it was originally used only for stage-narrowing) because
// Codex review (P2) correctly caught that the cap below runs FIRST: on a
// workflow with >= MAX_ANALYZER_PENDING_ITEMS speaker-relevant pending items
// ahead of these two slots, .slice(0, MAX_ANALYZER_PENDING_ITEMS) would
// already have dropped them before the stage-narrowing exemption ever got a
// chance to keep them — silently defeating the exemption in precisely the
// larger-workflow case it exists for.
const ALWAYS_VISIBLE_SLOT_NAMES = new Set(["pickup_facility", "destination_facility"]);

async function allSettledWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

// No-information sentinels the analyzer may legitimately store in BOTH a first-
// and last-name slot when the caller doesn't know a name ("N/A", "unknown", ...).
// The duplicate-name reconciliation must NOT treat these shared sentinels as a
// mis-captured surname, or it would clear + re-ask the first name forever.
const NAME_DUP_SENTINELS = new Set([
  "n/a", "na", "n a", "unknown", "unk", "none", "not known", "not available",
  "not provided", "no name",
]);

function normalizeConfidenceThreshold(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 1) {
    return 0.95;
  }
  return Math.round(numericValue * 100) / 100;
}

function normalizeSpeakerType(speaker) {
  if (speaker === "inbound" || speaker === "customer") return "customer";
  if (speaker === "outbound" || speaker === "agent") return "agent";
  return null;
}

function hasMeaningfulExtractedValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

const baseSlotKey = (slotName) =>
  String(slotName || "").replace(/^(pickup|destination|sending|receiving)_/, "");
const normalizeForBleedCheck = (value) => String(value ?? "").trim().toLowerCase();

// Codex review (PR #1392, P1): destination_facility's own configured prompt
// hint (lib/medical-transport-intake-workflow.mjs: "going to, destination,
// transport to, receiving facility") explicitly tells the model "going to"
// and "transport to" are valid destination phrasings - so a caller saying
// "we're going to Summit Hospital" gets correctly extracted onto
// destination_facility, but neither phrase matched this regex. Every guard
// keyed on mentionsOwnStageWord() then treated that utterance as NOT
// naming its own stage and silently redirected the fill back to
// pickup_facility - swapping it right after the always-visible narrowing
// exemption let it through in the first place. Fixed by matching each
// slot's own configured hints exactly, not just the bare stage-name word.
// pickup_facility's hint ("pickup from, picking up at, origin, from
// hospital") has the same gap: "picking up" doesn't match pick[\s-]?up
// (that only allows a single space/hyphen between "pick" and "up", not
// "pick-ing up"). "from hospital" is deliberately NOT added - a bare "from"
// is too generic and would false-positive on unrelated sentences.
// Codex review (PR #1392, P1, round 7): transport(?:ing)? to covered the
// present/gerund forms but not the equally common past participle ("the
// patient is being TRANSPORTED TO Summit Hospital"). Widened to
// transport(?:ing|ed)? to, the same fix already applied to PICKUP_STAGE_
// WORDS in round 5 for "picked up".
const DESTINATION_STAGE_WORDS =
  /\b(destination|receiving|drop[\s-]?off|dropoff|transport(?:ing|ed)? to)\b/i;
// Codex review (PR #1392, P1, round 3): "going to" alone is ordinary
// future-tense English, not a reliable destination signal by itself (see
// the "which department will the patient be going TO?" pickup-context
// example a few guards down). Kept separate from DESTINATION_STAGE_WORDS
// (the strong/unambiguous set) so it can be conditioned, instead of firing
// unconditionally.
//
// Codex review (PR #1392, P1, round 6): the original round-3 fix
// conditioned this on the absence of a PICKUP word ANYWHERE in the combined
// text (e.g. the agent's own question: "which hospital are we going to
// pick up from?"). That's too coarse in the other direction: "going to"
// genuinely names a destination only when a PLACE follows it ("going to
// Mercy"); when a VERB follows instead ("I'm going to change it to Mercy"
// — correcting pickup_facility, not naming a destination), treating the
// bare phrase as a destination signal made transcriptNamesAnyStage (below)
// trust the current transcript alone and discard a preceding turn that was
// the ACTUAL relevant disambiguating context (it named "pickup"), then let
// "going to" wrongly corroborate destination_facility and redirect a
// correctly-resolved pickup correction onto the wrong sibling. Fixed at the
// root: "going to" only counts as a destination signal when NOT
// immediately followed by one of the common verbs that indicate ordinary
// future-tense intent rather than a place. Not exhaustive — the same
// residual-risk trade-off already accepted for this exact style of list
// elsewhere in this codebase (see NON_VALUE_PREDICATE_LOOKAHEAD in
// lib/agent-assist/readback.mjs) — but covers the reported case and the
// EMS-dispatch phrasings ("going to need", "going to check", "going to
// update") most likely to recreate it.
//
// Codex review (PR #1392, P1, round 7): the round-3 "no pickup word
// anywhere" condition (removed from mentionsOwnStageWord below, now that
// round 6's verb-exclusion handles the actual structural pattern - "going
// to" immediately followed by "pick" - more precisely) was ALSO wrong in
// the opposite direction: "Pickup remains General, but actually we're
// going to Mercy" has an unrelated pickup mention in a SEPARATE clause,
// which used to blanket-cancel the clearly-intended "going to Mercy"
// destination signal and redirect a correctly-resolved destination
// correction onto pickup_facility. The verb-exclusion below already
// excludes "going to pick" specifically at its root (checking what
// immediately FOLLOWS "going to", not whether "pickup" appears anywhere in
// a possibly multi-clause, multi-turn blended text), so the separate
// whole-text pickup check was both redundant for the cases it was meant to
// catch and actively wrong for cases like this one.
// Codex review (PR #1392, P1, round 8): "be" was in the flat excluded-verb
// list above (added in round 5 for "going to be picked up" - a passive
// PICKUP construction), but "be" is also how a genuine destination is
// commonly phrased WITHOUT "transport"/"destination" wording at all: "the
// patient is going to be AT Summit Hospital." Excluding "be" unconditionally
// rejected that destination signal too, letting the fourth guard redirect
// a correctly-resolved destination completion onto pickup_facility with
// pickup_facility still open. Carved "be" out as its own signal, trusted
// only when immediately followed by "at".
//
// Codex review (PR #1392, P1, round 9): that carve-out was itself too
// permissive. "going to be at" is a much more overloaded construction than
// a direct "going to <place>" - it can describe ANY entity's location, not
// just a destination: "Where is the PICKUP going to be at?" uses "going to
// be at" to ask about the PICKUP facility's own location, with "pickup" as
// its grammatical subject earlier in the very same clause. Split into two
// signals (DIRECT and BE_AT) so BE_AT could be gated on the absence of a
// contradicting pickup mention while DIRECT stayed ungated, per round 7.
//
// Codex review (PR #1392, P1, round 10): DIRECT's "ungated" design relied
// on the verb-exclusion lookahead catching "going to pick" at the root -
// but that lookahead only rejects a verb IMMEDIATELY adjacent to "going
// to". A disfluency ("going to, uh, pick up from") or an intervening
// preposition ("going to for the pickup") breaks that adjacency, and
// DIRECT matched anyway - corroborating destination_facility even though
// PICKUP_STAGE_WORDS also matched the same text. Round 7's fix rested on
// an assumption (verb-adjacency is a reliable enough proxy for "this
// clause is about picking up") that round 10 disproves for real spoken
// disfluency. No finite lookahead reliably tells "going to Mercy, but
// pickup is separate" (round 7 - destination should win) apart from
// "going to, uh, pick up" (round 10 - pickup should win) - both have a
// pickup word somewhere near "going to" with something else between them.
// Decision (explicit user call after being asked, weighing the two
// failure modes): reinstate the general pickup-conflict check for BOTH
// weak signals, accepting that round 7's specific scenario (an explicit
// contrastive correction naming both facilities in one breath) can once
// again be silently redirected - judged less likely in practice than
// round 10's failure mode (ordinary disfluency inside an everyday pickup
// question).
const DESTINATION_WEAK_GOING_TO_EXCLUDED_VERBS =
  "change|update|correct|fix|need|check|ask|call|have|get|see|make|take|arrive|come|go|meet|transfer|send|keep|hold|wait|look|discuss|know|confirm|verify|review|talk|speak|do|say|tell|give|find|try|cancel|page|dispatch|pick";
const DESTINATION_WEAK_GOING_TO_DIRECT = new RegExp(
  `\\bgoing to\\b(?!\\s+(?:${DESTINATION_WEAK_GOING_TO_EXCLUDED_VERBS}|be)\\b)`,
  "i"
);
const DESTINATION_WEAK_GOING_TO_BE_AT = /\bgoing to be at\b/i;
// Codex review (PR #1392, P1, round 5): the literal "picking up" alternative
// only covered the gerund; the equally common past-tense phrasing "picked
// up" ("which hospital are we going to be PICKED UP from?") matched
// neither pickup|pick[\s-]?up (that only allows a single space/hyphen
// directly between "pick" and "up", not "pick-ed up") nor "picking up".
// Missing it here means the destination-vs-pickup conflict check above
// wouldn't see the contradiction, letting the weak "going to" signal win
// unopposed and recreate the exact swap the conflict check exists to catch.
// Generalized to pick(?:ing|ed)?[\s-]?up so every real inflection
// (pickup, pick up, pick-up, picking up, picked up) is covered by one
// pattern instead of an ever-growing list of literal alternatives.
const PICKUP_STAGE_WORDS = /\b(pick(?:ing|ed)?[\s-]?up|sending|origin)\b/i;
function mentionsOwnStageWord(slotName, text) {
  const t = String(text || "");
  if (/^(destination|receiving)_/.test(slotName)) {
    // The strong set is trusted unconditionally - "destination facility is
    // Mercy" is unambiguous regardless of what else the text mentions.
    if (DESTINATION_STAGE_WORDS.test(t)) return true;
    // Both weak "going to" signals defer to an explicit pickup mention
    // anywhere in the text (round 10) - see the round-10 comment above for
    // why DIRECT can no longer be exempted from this.
    if (PICKUP_STAGE_WORDS.test(t)) return false;
    return DESTINATION_WEAK_GOING_TO_DIRECT.test(t) || DESTINATION_WEAK_GOING_TO_BE_AT.test(t);
  }
  if (/^(pickup|sending)_/.test(slotName)) return PICKUP_STAGE_WORDS.test(t);
  return false;
}

/**
 * Analyze ONE utterance against the current (already up-to-date, within this
 * request's transaction) workflow state, and apply its effects.
 *
 * Reused for both a single-transcript request and each item of a batch: when
 * called in a loop from the SAME client/transaction, every subsequent call
 * sees the previous call's item_status writes (client.query, not pool.query,
 * for every read here — Postgres only shows uncommitted writes to the SAME
 * connection), so a batch gets the same correctness as N separate sequential
 * requests did, but without N separate HTTP round trips. slotsFilled and
 * slotsDelta are mutated in place so the caller can persist/merge once after
 * the whole batch instead of per utterance.
 *
 * Returns { updates, analysisResult, skipped }. `skipped: true` means there
 * was nothing relevant to analyze for this utterance (mirrors the old
 * single-request "No pending items to analyze" early return, but as a
 * per-utterance no-op instead of a whole-request return so the rest of the
 * batch still runs).
 */
async function analyzeOneUtterance({
  connectionRef,
  pool,
  workflowSession,
  callControlId,
  assistConfig,
  llmModel,
  fallbackModel,
  reasoningEnabled,
  maxOutputTokens,
  confidenceThreshold,
  transcript,
  transcriptionId,
  speaker,
  recentContext,
  slotsFilled,
  slotsDelta,
  requestSignal,
  // Concurrent group batching only (see runConceptGroupBranch below): when
  // this utterance has been classified into a concept group and is running
  // in a CONCURRENT branch alongside other groups, restrict "pending items"
  // to just this group's own item_ids. Without this, currentTargetItem/
  // narrowing would treat an item belonging to a DIFFERENT concurrently-
  // running group as "the earliest open item" purely because that other
  // branch hasn't committed its own completion yet — confusing this
  // utterance's disambiguation with an irrelevant, unrelated slot. Left
  // undefined for the normal single-stream sequential path (the vast
  // majority of requests), which keeps today's whole-workflow view intact.
  scopeItemIds = null,
}) {
  const updates = [];

  // Get unfinished items for current and upcoming stages.
  // Include suggested rows so a later, clearer utterance can replace a low-confidence
  // suggestion instead of freezing the slot until the agent edits it manually.
  const { rows: allPendingItems } = await connectionRef.client.query(
    `SELECT
      i.id as item_id,
      i.type,
      i.label,
      i.prompt_hint,
      i.slot_name,
      i.slot_type,
      i.slot_options,
      i.slot_validation,
      i.completion_trigger,
      i.hints,
      s.name as stage_name,
      s.order_index as stage_order,
      ist.status as current_status
     FROM aa_workflow_items i
     JOIN aa_workflow_stages s ON i.stage_id = s.id
     JOIN aa_workflow_item_status ist ON ist.item_id = i.id AND ist.session_id = $1
     WHERE s.workflow_id = $2
       AND ist.status IN ('pending', 'suggested')
     ORDER BY s.order_index, i.order_index`,
    [workflowSession.id, workflowSession.workflow_id]
  );
  const pendingItems = scopeItemIds
    ? allPendingItems.filter((item) => scopeItemIds.has(item.item_id))
    : allPendingItems;

  const speakerType = normalizeSpeakerType(speaker);
  const speakerRelevantPendingItems = pendingItems.filter((item) => {
    const completionTrigger = item.completion_trigger || "agent";
    return (
      Boolean(speakerType) &&
      (completionTrigger === "either" || completionTrigger === speakerType)
    );
  });
  // Codex review (P2): applying the cap with a plain .slice(0, N) BEFORE
  // checking ALWAYS_VISIBLE_SLOT_NAMES would drop an always-visible item on
  // any workflow with >= N speaker-relevant items ahead of it, silently
  // defeating the exemption in exactly the larger-workflow case it exists
  // for. Every always-visible item is kept unconditionally; the cap is only
  // applied to the remaining budget, preserving original (stage) order.
  const alwaysVisibleCount = speakerRelevantPendingItems.reduce(
    (count, item) => count + (ALWAYS_VISIBLE_SLOT_NAMES.has(item.slot_name) ? 1 : 0),
    0
  );
  const otherItemBudget = Math.max(0, MAX_ANALYZER_PENDING_ITEMS - alwaysVisibleCount);
  let otherItemsSeen = 0;
  const relevantPendingItems = speakerRelevantPendingItems.filter((item) => {
    if (ALWAYS_VISIBLE_SLOT_NAMES.has(item.slot_name)) return true;
    if (otherItemsSeen < otherItemBudget) {
      otherItemsSeen++;
      return true;
    }
    return false;
  });

  // Are we at the final read-back/confirmation step? A read-back-matching
  // item (e.g. "Confirm all information is correct") stays pending for the
  // ENTIRE call until the very end, so checking pendingItems alone (as an
  // earlier version of this code did) makes isReadBackStage true from the
  // FIRST utterance onward — re-including every already-completed slot as a
  // "correction candidate" (see below) and adding the correction prompt
  // section for the whole call, not just read-back. That widened window is
  // exactly what let a pickup-stage address utterance get misattributed to
  // destination_facility: destination_facility was ALSO sitting in view as
  // a correction candidate, adding noise right when the model should be
  // tightly focused on pickup vs. destination. Require BOTH: a read-back
  // item is pending, AND every slot-type item is already collected — read-
  // back is only reached once there is nothing left to collect.
  //
  // A slot-type item with status "pending"/"suggested" does NOT count as
  // "still needs collecting" when slots_filled already has a value for
  // it — that's a correction candidate whose confirmation is still pending
  // (see the always-suggested correction branch below), not a genuine gap.
  // Without this exception, confirming ONE correction (e.g. date of birth)
  // would make that slot itself "pending" again, which would flip
  // isReadBackStage back to false and hide every OTHER slot from being
  // corrected until that one confirmation was resolved — i.e. only one
  // correction could ever be in flight at a time.
  // Deliberately checked against allPendingItems (whole workflow), NEVER the
  // scoped/filtered pendingItems: read-back readiness is inherently a
  // whole-workflow concept ("has EVERYTHING been collected"), not a
  // per-concept-group one. If this were scoped, a concurrent branch whose
  // OWN group's slots happen to already be filled would incorrectly think
  // read-back has been reached while a DIFFERENT, concurrently-running
  // group still has open slots.
  const isReadBackStage =
    !allPendingItems.some(
      (item) => item.type === "slot" && !hasMeaningfulExtractedValue(slotsFilled[item.slot_name])
    ) &&
    allPendingItems.some((item) =>
      isReadBackItem({
        itemType: item.type,
        itemLabel: item.label,
        itemPromptHint: item.prompt_hint,
        itemHints: item.hints,
      })
    );

  // Was a correction just flagged, in this utterance or a recent one? STT
  // often mangles a corrected value differently on each retry (e.g. "Twin
  // Hill" / "Stonemere" / "John Miller" for "John Mabry Hospital"), and the
  // caller then just repeats a plain name instead of re-explaining "that's
  // still wrong" every single time. When true, the correction prompt (below)
  // is told it can accept a bare restated value as continuing that same
  // correction instead of requiring the explicit trigger phrase again.
  // an earlier fix: an explicit correction can be made at ANY stage, not only during
  // read-back. Agents correct a captured value the moment the caller says it
  // was wrong, long before the read-back script is reached.
  //
  // How far back the trigger may sit differs by stage, because the cost of a
  // stale one differs. At read-back nothing is left to collect, so scanning
  // the whole recent window is safe and is the behaviour #1281 shipped.
  // Mid-call, collection is still running: a trigger left anywhere in the
  // window would keep every completed slot exposed — and keep the prompt's
  // "a bare restated value continues the correction" leniency switched on —
  // turn after turn. The customer's bare answer to the NEXT question would
  // then read as a continuation of the earlier correction and could flip an
  // already-correct slot back to suggested. So mid-call the trigger must be in
  // this utterance or the one immediately before it: enough for STT to mangle
  // a corrected value once and have the caller restate it bare, and it expires
  // as soon as collection moves on.
  const recentContextEntries = Array.isArray(recentContext) ? recentContext : [];
  const midCallCorrectionWindow = recentContextEntries.slice(-1);
  const correctionWindow = isReadBackStage ? recentContextEntries : midCallCorrectionWindow;
  const correctionRequested =
    mentionsCorrectionTrigger(transcript) ||
    correctionWindow.some((c) => mentionsCorrectionTrigger(c?.text));

  const correctionInProgress = correctionRequested;

  // Free-text notes slots keep accumulating AFTER they complete: a completed
  // item drops out of the pending set, so later STT fragments of a multi-
  // sentence note would be lost. Re-include completed accumulating (notes)
  // slots in the analyzer INPUT only — not in pendingItems — so subsequent
  // fragments accumulate without affecting the read-back guard or the current
  // target. Fetched BEFORE the empty-pending check so a note still accumulates
  // when it is the only thing the customer is still adding to.
  // is_manual_edit is selected so MANUALLY-edited rows can be excluded from
  // the correction-candidate set below (an earlier fix follow-up): a value the
  // agent typed by hand is ground truth the analyzer must never overwrite —
  // the manual edit is not in the transcript, so any "correction" the LLM
  // derives for that slot is at best the stale spoken value it replaced.
  //
  // is_manual_edit is set ONLY by the manual complete/slot routes — it is
  // NOT inferred from completed_by='agent' + confidence_score=1. That pair
  // is not unique to a manual edit: the auto-complete branch below can ALSO
  // write completed_by='agent' (when the AGENT SPOKE the value) with an LLM
  // confidence of exactly 1.0 for an unambiguous utterance (the analyzer's
  // own confidence clamp permits 1.0), which is indistinguishable from a
  // manual edit under a confidence-based heuristic and would wrongly block
  // that spoken value from ever being corrected again for the rest of the
  // call — confirmed live: completed_by='agent', confidence_score=1 rows
  // occur for values the agent RECITED, not typed.
  const { rows: completedSlotRows } = await connectionRef.client.query(
    `SELECT i.id as item_id, i.type, i.label, i.prompt_hint, i.slot_name,
            i.slot_type, i.slot_options, i.slot_validation, i.completion_trigger,
            i.hints, s.name as stage_name, s.order_index as stage_order,
            ist.status as current_status, ist.completed_by, ist.confidence_score, ist.is_manual_edit,
            ist.completed_at, ist.extracted_value as completed_value
       FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
       JOIN aa_workflow_item_status ist ON ist.item_id = i.id AND ist.session_id = $1
      WHERE s.workflow_id = $2 AND ist.status = 'completed' AND i.type = 'slot'
      ORDER BY s.order_index, i.order_index`,
    [workflowSession.id, workflowSession.workflow_id]
  );
  // One definition for "this row is a manual agent edit", shared by the JS
  // filter and mirrored by the SQL guard on the correction UPDATE.
  const isManualAgentRow = (row) => row?.is_manual_edit === true;
  const completedNotesItems = completedSlotRows.filter((it) => {
    if (!isAccumulatingSlot(it)) return false;
    const trigger = it.completion_trigger || "agent";
    return Boolean(speakerType) && (trigger === "either" || trigger === speakerType);
  });

  // Re-include every OTHER already-completed slot as a correction candidate —
  // not for re-collection. Two ways in:
  //
  //  * the read-back step, where the caller is explicitly reviewing prior
  //    answers, so every captured slot is fair game; and
  //  * any other stage, but ONLY once someone has explicitly said a value is
  //    wrong (an earlier fix — corrections happen mid-call, not just at read-back).
  //
  // The explicit-trigger requirement is what preserves the original guarantee:
  // with no correction in play, a completed slot stays entirely out of the
  // analyzer's view (see the "pending items" query above), so an offhand later
  // mention of a value still can't accidentally overwrite it. The prompt
  // (buildWorkflowAnalysisSystemPrompt) is the second gate, requiring an
  // EXPLICIT correction statement before returning one of these, and every
  // returned correction is surfaced as "suggested" pending confirmation rather
  // than silently applied.
  const correctionsAllowed = isReadBackStage || correctionRequested;
  // Manually-edited slots are excluded: the agent's typed value never appears
  // in the transcript, so exposing the slot invites the LLM to "correct" it
  // back to the stale spoken value — the exact revert loop an earlier fix reports.
  // The agent can still change their own edit with the pencil. Agent-SPOKEN
  // captures (completed_by='agent' with a real LLM confidence) remain
  // candidates — see isManualAgentRow above.
  const correctionCandidateItems = correctionsAllowed
    ? completedSlotRows.filter((it) => !isAccumulatingSlot(it) && !isManualAgentRow(it))
    : [];
  const analyzerItems = [...relevantPendingItems, ...completedNotesItems, ...correctionCandidateItems];

  if (analyzerItems.length === 0) {
    workflowLogger.info("workflow_analysis_skipped", agentAssistRuntimePayload({
      sessionId: workflowSession.id,
      interactionId: workflowSession.work_item_id,
      workflowId: workflowSession.workflow_id,
      callControlId,
      transcriptId: transcriptionId,
      reason: "no_relevant_pending_items",
      pendingItems: pendingItems.length,
      speaker: speaker || null,
    }));
    return { updates, analysisResult: null, skipped: true };
  }

  // NOTE: the safe half of a "skip agent questions" optimization already lives
  // in the empty-analyzerItems early-return above — for an agent utterance,
  // relevantPendingItems is filtered to only `either`/`agent`-triggered items,
  // so when the only open items are customer-only slots the LLM is already
  // skipped. We do NOT additionally skip agent utterances while `either` slots
  // are open: this workflow lets the agent state values for either-triggered
  // slots ("Can I get Mercy for the pickup facility?"), so any text heuristic
  // to guess "asking vs stating" would drop real captures.

  // Bleed guard: find the most recently completed slot (within a short window).
  // A stray numeric tail of a just-answered slot (e.g. "eight" from "nineteen
  // sixty-eight" arriving after DOB was captured as "1960-03-12") must not
  // bleed into the next pending slot (e.g. weight). Only activate when the
  // transcript itself looks like a numeric/ordinal fragment — clear boolean
  // answers ("No", "Yes") must NEVER be caught by this guard.
  const BLEED_WINDOW_MS = 8000;
  const NUMERIC_FRAGMENT_RE = /^(?:\d+(?:st|nd|rd|th)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth)(?:[\s-]+(?:\d+(?:st|nd|rd|th)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth))*$/i;
  const transcriptWords = transcript.trim().split(/\s+/);
  const isNumericFragment = transcriptWords.length <= 3 && NUMERIC_FRAGMENT_RE.test(transcript.trim());
  const recentlyCompletedSlot = isNumericFragment
    ? (completedSlotRows
        .filter((r) => r.completed_at && r.completed_value != null)
        .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))
        .find((r) => Date.now() - new Date(r.completed_at).getTime() < BLEED_WINDOW_MS)
        ?? null)
    : null;
  const bleedGuardSlot = recentlyCompletedSlot
    ? { slotName: recentlyCompletedSlot.slot_name, slotType: recentlyCompletedSlot.slot_type, value: recentlyCompletedSlot.completed_value }
    : null;

  // The slot the agent is currently collecting = the earliest still-open OR
  // still-unconfirmed slot (pendingItems are ordered by stage, then item).
  // Passed to the analyzer so an ambiguous answer is assigned to the slot
  // actually being asked, instead of a same-looking slot elsewhere (e.g. a
  // mis-heard destination facility going into a patient-name slot).
  //
  // Includes "suggested" (not just "pending"): a low-confidence capture
  // isn't confirmed yet, and the caller often repeats/clarifies it on the
  // very next turn. If that turn were treated as "moved on", current focus
  // would already be pointing at whatever's next (e.g. sending_physician
  // suggested at low confidence -> focus jumps to receiving_physician), so
  // an unrelated bare repeat of the SAME name gets misattributed to the
  // NEXT slot instead of confirming/refining the one actually still in
  // question. Reported live: "I was talking only sending physician name but
  // it fills up to both sending physician and receiving physician."
  let currentTargetItem = pendingItems.find(
    (i) => i.type === "slot" && (i.current_status === "pending" || i.current_status === "suggested")
  );

  // A bare yes/no from the customer answers the question the agent just
  // ASKED, not necessarily the earliest unresolved slot. With consecutive
  // boolean slots (for example: "declined for weather?" then "other aircraft
  // responding?"), the first answer can land as 'suggested' (below the
  // confidence threshold) and the earliest-open rule above would keep focus
  // parked there — the prompt's "a bare yes/no answers THIS slot" rule then
  // routes the SECOND "No" back into the first boolean and the last slot
  // never fills, stalling the read-back. When the transcript is a bare
  // affirmative/negative and the most recent AGENT context line clearly
  // names a different open boolean slot (its label/hint tokens overlap the
  // question), focus follows the question.
  const BARE_YES_NO_RE = /^(?:yes|yeah|yep|yup|correct|right|no|nope|none|nah|negative)[.,!\s]*$/i;
  if (speakerType === "customer" && BARE_YES_NO_RE.test(transcript.trim())) {
    const lastAgentContext = [...recentContextEntries]
      .reverse()
      .find((e) => e?.text && String(e.speaker || "").toLowerCase() !== "inbound");
    const questionText = String(lastAgentContext?.text || "").toLowerCase();
    if (questionText) {
      const questionedBoolean = pendingItems.find((i) => {
        if (i.type !== "slot" || i.slot_type !== "boolean") return false;
        if (i.current_status !== "pending" && i.current_status !== "suggested") return false;
        const hintTokens = `${i.label || ""} ${i.prompt_hint || ""}`
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length > 3);
        const hits = hintTokens.filter((t) => questionText.includes(t));
        return hits.length >= 2;
      });
      if (questionedBoolean && questionedBoolean.item_id !== currentTargetItem?.item_id) {
        workflowLogger.info("workflow_bare_answer_focus_override", agentAssistRuntimePayload({
          sessionId: workflowSession.id,
          interactionId: workflowSession.work_item_id,
          slotName: questionedBoolean.slot_name,
          previousFocus: currentTargetItem?.slot_name ?? null,
        }));
        currentTargetItem = questionedBoolean;
      }
    }
  }

  const currentTarget = currentTargetItem
    ? { label: currentTargetItem.label, slotName: currentTargetItem.slot_name }
    : null;
  // Stage name of the currently active stage, used by the LLM stage-boundary
  // rule to prevent cross-stage slot bleed (e.g. pickup dept bleeding into
  // destination dept).
  const currentStageName = currentTargetItem?.stage_name
    ?? pendingItems.find(i => i.current_status === "pending")?.stage_name
    ?? null;

  // Narrow the analyzer's input to the current stage (+ a small look-ahead
  // buffer) instead of every open item across the whole remaining workflow.
  // Smaller prompt -> faster inference, and fewer structurally-similar
  // future-stage slots in view to accidentally bleed into (the hard
  // backstop below still applies as defense-in-depth regardless). Still-open
  // items from EARLIER stages stay visible — the agent may circle back to a
  // skipped question — only far-future stages are trimmed.
  //
  // completedNotesItems are deliberately EXEMPT from narrowing: they're
  // already-completed, still-accumulating notes slots (see comment above
  // completedSlotRows) that must stay analyzable regardless of which stage
  // they belong to, or a later fragment of that note would stop accumulating.
  //
  // "suggested" items (a slot already captured at low confidence, awaiting
  // an explicit confirmation utterance) are ALSO exempt, for the same
  // reason: currentTargetItem anchors on the EARLIEST still-open slot, which
  // can regress back to an early stage once every later-stage slot is
  // either completed or merely "suggested" (e.g. one slot in "Intent
  // Identification" never got filled, so once every later stage's slots
  // are captured, that one early slot becomes the only remaining
  // type=slot/status=pending row and currentStageOrder snaps back to it).
  // Without this exemption, that regression narrows the analyzer's view
  // down to the early stage and permanently hides a later "suggested" slot
  // from ever being re-analyzed — so its confirmation utterance ("two IV
  // drips is correct") is never seen, the slot never flips to "completed",
  // and the low-confidence-confirmation fallback keeps re-prompting for it
  // near the end of the call even though the agent already confirmed it.
  // The read-back/"confirm all information" item is ALSO exempt, for the
  // same regression: it's a non-slot PENDING item (not "suggested"), so the
  // exemption above doesn't cover it. It sits in the final stage, so any
  // regression at all pushes it out of the narrowed window — permanently
  // hiding it from the analyzer even while the customer is actively giving
  // the read-back affirmative ("yes, all information is correct"), leaving
  // the read-back stuck open with no way to ever complete it.
  // pickup_facility/destination_facility are ALSO exempt from narrowing, for
  // a related but distinct reason: a caller routinely names the destination
  // facility (or vice versa) well before stage progression reaches it — e.g.
  // stating it during Caller Identification, two stages ahead of Destination
  // Information — and the utterance's own wording ("destination facility
  // name is...") already says exactly which slot it means. Hiding the real
  // slot behind stage-distance narrowing left the caller's explicit answer
  // nowhere valid to land, which is what motivated adding a separate merged
  // "Facility Identification" capture stage as a workaround. That merged
  // stage discarded the caller's own disambiguating wording by capturing
  // into a generic bucket that something else then had to guess pickup vs.
  // destination for — and that guess is what caused pickup/destination
  // facility names (and the department/room/bed items that key off which
  // one got filled) to get swapped. Keeping both slots permanently in view
  // lets the model route the explicit utterance directly to the correct
  // slot itself, the same way it already does for an in-window utterance;
  // the redirect-to-earlier-sibling guard below already special-cases an
  // utterance that names its own stage word (mentionsOwnStageWord), so this
  // exemption doesn't need its own disambiguation logic. (ALWAYS_VISIBLE_
  // SLOT_NAMES itself is declared at module scope, alongside MAX_ANALYZER_
  // PENDING_ITEMS — it's also used there to exempt these slots from the
  // pending-items cap, before this stage-narrowing filter ever runs.)
  const NARROW_STAGE_LOOKAHEAD = 1;
  const currentStageOrder = currentTargetItem?.stage_order
    ?? pendingItems.find(i => i.current_status === "pending")?.stage_order
    ?? null;
  const narrowedRelevantPendingItems = currentStageOrder == null
    ? relevantPendingItems
    : relevantPendingItems.filter((item) =>
        item.current_status === "suggested" ||
        ALWAYS_VISIBLE_SLOT_NAMES.has(item.slot_name) ||
        (item.stage_order ?? 0) <= currentStageOrder + NARROW_STAGE_LOOKAHEAD ||
        isReadBackItem({
          itemType: item.type,
          itemLabel: item.label,
          itemPromptHint: item.prompt_hint,
          itemHints: item.hints,
        })
      );
  // correctionCandidateItems are exempt from narrowing for the same reason as
  // completedNotesItems: they're already-completed slots from potentially
  // any earlier stage, re-included ONLY so an explicit correction at the
  // read-back step can be captured — narrowing by stage distance would
  // defeat that (a correction to an early-stage slot must stay visible even
  // though currentStageOrder now sits at the final Confirmation stage).
  const narrowedAnalyzerItems = [...narrowedRelevantPendingItems, ...completedNotesItems, ...correctionCandidateItems];
  workflowLogger.debug("workflow_analyzer_items_narrowed", agentAssistRuntimePayload({
    sessionId: workflowSession.id,
    interactionId: workflowSession.work_item_id,
    currentStageName,
    currentStageOrder,
    isReadBackStage,
    correctionInProgress,
    correctionCandidates: correctionCandidateItems.length,
    beforeCount: analyzerItems.length,
    afterCount: narrowedAnalyzerItems.length,
  }));

  // Release both the transaction and checked-out Postgres connection before
  // waiting on remote inference. The previous implementation held an idle
  // transaction for the entire model call; a few slow requests could consume
  // the five-connection pool even though the database was doing no work.
  await connectionRef.client.query("COMMIT");
  connectionRef.client.release();
  connectionRef.client = null;

  // Call LLM analyzer (using workflow's configured model)
  const analysisResult = await analyzeWorkflowTranscript({
    transcript,
    speaker: speaker || "unknown",
    pendingItems: narrowedAnalyzerItems,
    slotsFilled,
    model: llmModel,
    fallbackModel,
    // Intent and sentiment are auxiliary Agent Assist features. They run in
    // their own small request from the transcription router and must never
    // expand or delay the slot-extraction response.
    reasoningEnabled,
    maxOutputTokens,
    confidenceThreshold,
    currentTarget,
    currentStageName,
    isReadBackStage,
    // The correction section is driven by whether correction candidates are
    // actually in the analyzer input, not by the stage — outside read-back an
    // explicit trigger is what put them there (an earlier fix).
    allowCorrections: correctionCandidateItems.length > 0,
    correctionInProgress,
    recentContext: Array.isArray(recentContext) ? recentContext.slice(-6) : [],
    bleedGuardSlot,
    signal: requestSignal,
    observabilityContext: {
      sessionId: workflowSession.id,
      interactionId: workflowSession.work_item_id,
      workflowId: workflowSession.workflow_id,
      callControlId,
      transcriptId: transcriptionId,
    },
  });

  if (requestSignal?.aborted) {
    throw requestSignal.reason || new Error("Workflow analysis request cancelled");
  }
  connectionRef.client = await pool.connect();
  await connectionRef.client.query("BEGIN");

  // Hard backstop for cross-stage slot bleed (e.g. pickup_department also
  // filling destination_department) that slips past the LLM's stage-boundary
  // prompt instruction. Prompt-only guidance is a strong nudge, not an
  // enforced rule — the model can still copy a value to a structurally
  // identical slot in a later stage within the SAME response. Detect that
  // exact pattern here: two items in this response share a base slot concept
  // (stripping a pickup_/destination_/sending_/receiving_ prefix) and an
  // identical extracted value — keep only the earlier-stage one.
  const bleedRejectedItemIds = new Set();
  {
    const itemById = new Map(analyzerItems.map((i) => [i.item_id, i]));
    const candidates = (analysisResult.completed_items || [])
      .map((completed) => {
        const item = itemById.get(completed.item_id);
        if (!item?.slot_name) return null;
        const base = baseSlotKey(item.slot_name);
        if (base === item.slot_name) return null; // no pickup_/destination_/etc. prefix — not a paired slot
        return {
          itemId: completed.item_id,
          base,
          stageOrder: item.stage_order,
          value: normalizeForBleedCheck(completed.extracted_value),
        };
      })
      .filter(Boolean);

    for (let a = 0; a < candidates.length; a++) {
      for (let b = a + 1; b < candidates.length; b++) {
        const x = candidates[a];
        const y = candidates[b];
        if (x.base !== y.base || !x.value || x.value !== y.value) continue;
        if (x.stageOrder === y.stageOrder) continue;
        const later = x.stageOrder > y.stageOrder ? x : y;
        bleedRejectedItemIds.add(later.itemId);
        workflowLogger.warn("workflow_stage_bleed_rejected", agentAssistRuntimePayload({
          sessionId: workflowSession.id,
          interactionId: workflowSession.work_item_id,
          rejectedItemId: later.itemId,
          baseSlotKey: x.base,
          value: x.value,
        }));
      }
    }
  }

  // Softer companion to the hard backstop above: catches a SINGLE
  // mis-attributed fill, not just an exact same-value duplicate. Reported
  // live: agent asks "Which department is the patient in?" (pickup stage);
  // customer answers department/room/bed/physician in quick succession
  // ("...Room three three three. Bed A. Doctor Patel.") — the bare "Bed A"
  // filled destination_bed instead of pickup_bed, because narrowing's
  // stage lookahead makes both structurally-identical slots visible to the
  // LLM at once and it picked the wrong one. When a paired slot completes
  // for a LATER stage while its EARLIER-stage sibling (same base concept)
  // is still open, and the utterance doesn't explicitly name the later
  // stage itself ("destination", "receiving", ...), redirect the
  // completion to the earlier, still-open sibling instead.
  {
    const openSlotsByBase = new Map();
    for (const item of pendingItems) {
      if (item.type !== "slot" || !item.slot_name) continue;
      const base = baseSlotKey(item.slot_name);
      if (base === item.slot_name) continue; // not a paired slot
      if (!openSlotsByBase.has(base)) openSlotsByBase.set(base, []);
      openSlotsByBase.get(base).push(item);
    }
    // A bare customer reply ("323") carries no disambiguating word of its
    // own even when the AGENT's immediately preceding question already
    // named the stage ("What's the destination room?") — checking only
    // completed.source_text (the customer's own utterance) would redirect
    // that correct destination_room answer back to pickup_room. Fold in
    // ONLY the single most recent prior utterance (almost always the
    // agent's question that prompted this answer) — not the whole
    // recent-context window. A stage word mentioned several turns earlier
    // (e.g. the caller volunteering "destination is Mercy" while pickup was
    // still open) must not keep suppressing this redirect for a later,
    // unrelated bare pickup answer that has nothing to do with that older
    // mention.
    const lastRecentContextEntry = Array.isArray(recentContext) && recentContext.length > 0
      ? recentContext[recentContext.length - 1]
      : null;
    const recentContextText = lastRecentContextEntry?.text || "";

    for (const completed of analysisResult.completed_items || []) {
      if (bleedRejectedItemIds.has(completed.item_id)) continue;
      const item = analyzerItems.find((i) => i.item_id === completed.item_id);
      if (!item?.slot_name) continue;
      const base = baseSlotKey(item.slot_name);
      if (base === item.slot_name) continue; // not paired
      const disambiguationText = `${recentContextText} ${completed.source_text || ""}`;
      if (mentionsOwnStageWord(item.slot_name, disambiguationText)) continue;

      const earlierOpenSibling = (openSlotsByBase.get(base) || [])
        .filter((sib) => sib.item_id !== item.item_id && (sib.stage_order ?? 0) < (item.stage_order ?? 0))
        .sort((a, b) => (a.stage_order ?? 0) - (b.stage_order ?? 0))[0];

      // currentStageOrder is always <= any open item's stage_order (it IS
      // the earliest open slot's stage) — kept as an explicit condition
      // for readability/defense-in-depth rather than relying purely on
      // "an earlier open sibling exists".
      if (earlierOpenSibling && currentStageOrder != null && currentStageOrder <= (earlierOpenSibling.stage_order ?? 0)) {
        workflowLogger.warn("workflow_stage_bleed_redirected", agentAssistRuntimePayload({
          sessionId: workflowSession.id,
          interactionId: workflowSession.work_item_id,
          fromItemId: completed.item_id,
          toItemId: earlierOpenSibling.item_id,
          baseSlotKey: base,
          value: completed.extracted_value,
        }));
        completed.item_id = earlierOpenSibling.item_id;
      }
    }
  }

  // Third guard: neither check above catches an earlier-stage sibling that
  // was ALREADY completed in a PRIOR, separate analyze request (not just
  // within this same response, and not just while still open). Reported
  // live: pickup room/bed were already correctly completed one at a time;
  // a LATER, unrelated turn then filled destination_room/destination_bed
  // with the SAME values, even though destination_facility/address/
  // department were all still empty — the model appears to copy a value
  // it saw earlier in the conversation onto the structurally-identical,
  // still-open later-stage slot. There's nothing to redirect TO here (the
  // earlier slot is already correctly filled), so reject the later
  // duplicate outright, same as the hard backstop does — unless the
  // utterance explicitly names the later stage itself.
  {
    const completedSiblingsByBase = new Map();
    for (const row of completedSlotRows) {
      if (!row.slot_name || !hasMeaningfulExtractedValue(row.completed_value)) continue;
      const base = baseSlotKey(row.slot_name);
      if (base === row.slot_name) continue; // not a paired slot
      if (!completedSiblingsByBase.has(base)) completedSiblingsByBase.set(base, []);
      completedSiblingsByBase.get(base).push(row);
    }
    const recentContextText = (Array.isArray(recentContext) ? recentContext : [])
      .map((c) => c?.text)
      .filter(Boolean)
      .join(" ");

    for (const completed of analysisResult.completed_items || []) {
      if (bleedRejectedItemIds.has(completed.item_id)) continue;
      const item = analyzerItems.find((i) => i.item_id === completed.item_id);
      if (!item?.slot_name) continue;
      const base = baseSlotKey(item.slot_name);
      if (base === item.slot_name) continue; // not paired
      const newValue = normalizeForBleedCheck(completed.extracted_value);
      if (!newValue) continue;
      // The item actually being actively collected right now (the analyzer's
      // own "Current Collection Focus") is never rejected as bleed, even if
      // its value happens to duplicate an earlier stage's already-completed
      // sibling — a legitimate answer to the question actually being asked
      // (e.g. destination_department="ICU" when pickup_department was also
      // "ICU") must not be dropped just because the two stages share a value.
      // Text-based disambiguation alone can't catch this: the destination
      // prompt for a slot like department/room/bed often never says the word
      // "destination" (e.g. "Which department will the patient be going
      // to?"), so mentionsOwnStageWord finds nothing to disambiguate on.
      if (currentTargetItem && completed.item_id === currentTargetItem.item_id) continue;
      const disambiguationText = `${recentContextText} ${completed.source_text || ""}`;
      if (mentionsOwnStageWord(item.slot_name, disambiguationText)) continue;

      const matchesEarlierCompletedSibling = (completedSiblingsByBase.get(base) || [])
        .filter((sib) => (sib.stage_order ?? 0) < (item.stage_order ?? 0))
        .some((sib) => normalizeForBleedCheck(sib.completed_value) === newValue);

      if (matchesEarlierCompletedSibling) {
        bleedRejectedItemIds.add(completed.item_id);
        workflowLogger.warn("workflow_stage_bleed_rejected_completed_sibling", agentAssistRuntimePayload({
          sessionId: workflowSession.id,
          interactionId: workflowSession.work_item_id,
          rejectedItemId: completed.item_id,
          baseSlotKey: base,
          value: newValue,
        }));
      }
    }
  }

  // Fourth guard: a mid-call CORRECTION (an earlier fix) landing on the wrong
  // sibling of an already-completed pair. Guards 1-3 above only ever look at
  // pendingItems (status 'pending'/'suggested') — a correction candidate is
  // status 'completed' and re-included separately (see correctionCandidateItems),
  // so none of them can see it. Reported live: caller is in the Destination
  // stage, says "the destination facility AAA I said earlier is wrong, it
  // needs to be changed to BBB" — an explicit, unambiguous correction naming
  // "destination" — but the model's returned item_id resolved to
  // pickup_facility instead, silently overwriting the wrong (and already
  // long-completed) sibling.
  //
  // Both facility slots are shown to the model as correction candidates with
  // their own current values (see buildWorkflowAnalysisSystemPrompt's
  // "Currently collected value" line), so the raw material to get this right
  // is present — this guard is a deterministic backstop for when the model
  // picks the wrong one anyway, mirroring guard 2's redirect but for
  // corrections instead of fresh fills, and without guard 2's requirement
  // that the earlier sibling still be "open" (a correction target is always
  // already completed, never pending).
  {
    // Codex review (0557da1d54, P1, round 1): folding in the WHOLE
    // recentContext window (as originally written here) means a stage word
    // mentioned much earlier in the call — e.g. "pickup" from when
    // pickup_facility was first collected, several turns before this
    // correction — stays in the aggregate text forever, wrongly
    // corroborating a mis-resolved pick. Narrowed to the single
    // immediately-preceding turn, matching guard 2's pattern.
    //
    // Codex review (0cbf7ffc, P1, round 2): even the single preceding turn
    // can outvote the CURRENT utterance. If the caller is mid-destination-
    // stage and interrupts to correct a pickup value, the preceding turn is
    // the agent's own destination-stage prompt (naming "destination"), while
    // the current transcript names "pickup" — concatenating them with equal
    // weight lets the stale "destination" from the agent's prompt corroborate
    // a wrong destination pick even though the caller just said "pickup".
    // The transcript is authoritative when it names a stage at all; the
    // preceding turn is consulted ONLY as a fallback when the transcript
    // itself is silent on stage words (e.g. a bare "change it to Mercy").
    const lastRecentContextEntry = Array.isArray(recentContext) && recentContext.length > 0
      ? recentContext[recentContext.length - 1]
      : null;
    const transcriptText = transcript || "";
    // Codex review (PR #1392, P1, round 4): this must recognize the SAME
    // weak "going to" signal mentionsOwnStageWord does, or a genuine
    // destination correction phrased that way ("that value is wrong, we're
    // going to Mercy") is wrongly judged to NOT name any stage on its own —
    // prepending the prior turn's text below, which can itself contain an
    // unrelated pickup mention (e.g. the agent's earlier "which hospital
    // did we pick up from?"). That prepended pickup word then makes
    // mentionsOwnStageWord's own conflict check see a contradiction that
    // only exists because of the blend, defeating the very case this guard
    // exists for: the CURRENT transcript alone is authoritative when it
    // names a stage at all, weak signal included.
    const transcriptNamesAnyStage =
      DESTINATION_STAGE_WORDS.test(transcriptText) ||
      PICKUP_STAGE_WORDS.test(transcriptText) ||
      DESTINATION_WEAK_GOING_TO_DIRECT.test(transcriptText) ||
      DESTINATION_WEAK_GOING_TO_BE_AT.test(transcriptText);
    const disambiguationText = transcriptNamesAnyStage
      ? transcriptText
      : `${lastRecentContextEntry?.text || ""} ${transcriptText}`;

    for (const completed of analysisResult.completed_items || []) {
      if (bleedRejectedItemIds.has(completed.item_id)) continue;
      const item = analyzerItems.find((i) => i.item_id === completed.item_id);
      // Only a correction candidate carries current_status "completed" in
      // analyzerItems — a fresh pending fill is untouched by this guard.
      if (!item?.slot_name || item.current_status !== "completed") continue;
      const base = baseSlotKey(item.slot_name);
      if (base === item.slot_name) continue; // not a paired slot

      // The utterance already names this item's own stage explicitly — the
      // model's pick is corroborated by the transcript, nothing to redirect.
      if (mentionsOwnStageWord(item.slot_name, disambiguationText)) continue;

      // Only redirect when the utterance explicitly names exactly one
      // sibling's stage instead — an utterance naming neither (or somehow
      // both) stays with the model's original pick rather than guessing.
      const namedSiblings = analyzerItems.filter((sib) =>
        sib.item_id !== item.item_id &&
        sib.current_status === "completed" &&
        sib.slot_name &&
        baseSlotKey(sib.slot_name) === base &&
        mentionsOwnStageWord(sib.slot_name, disambiguationText)
      );
      if (namedSiblings.length !== 1) continue;

      const target = namedSiblings[0];

      // Codex review (aeed3ba9, P1): must run BEFORE either branch below,
      // not just before the redirect branch. Guard 1 (the hard backstop)
      // may have already rejected target.item_id as a same-response/
      // same-value duplicate — that can be true whether this entry ends up
      // being rejected in favor of target's own direct completion (the
      // block right below) or redirected onto target (further below). The
      // earlier version of this fix only cleared the rejection in the
      // redirect branch; the direct-completion branch `continue`d past it
      // entirely, so an equal-value target stayed rejected and BOTH entries
      // were silently dropped — reintroducing the exact bug this was
      // supposed to fix, just via the other branch. Clearing it once, up
      // front, covers both outcomes: whichever entry ends up representing
      // target.item_id (the kept direct completion, or the redirected one),
      // it must not still be marked rejected from guard 1's unrelated
      // same-value heuristic.
      bleedRejectedItemIds.delete(target.item_id);

      // Codex review (8093b981, P1): if the model's response ALSO produced a
      // DIRECT completion for target itself (it correctly attributed the
      // correction to target on its own, alongside also misattributing this
      // OTHER entry) - not just the identical-value case guard 1 handles
      // below - redirecting this entry onto target.item_id creates a SECOND
      // completed_items entry for the same row, possibly with a DIFFERENT
      // extracted_value. The processing loop below would then update that
      // row twice, and whichever entry happens to appear last in the array
      // silently wins - an explicit, correctly-attributed direct completion
      // could be overwritten by this misattributed one purely by array
      // order. The direct completion is the model's own clearer read for
      // that specific slot, so it must win outright: reject THIS entry
      // instead of redirecting it, leaving the direct completion as the
      // only one processed for target.item_id.
      const targetAlreadyCompletedDirectly = (analysisResult.completed_items || []).some(
        (c) => c !== completed && c.item_id === target.item_id
      );
      if (targetAlreadyCompletedDirectly) {
        bleedRejectedItemIds.add(completed.item_id);
        workflowLogger.warn("workflow_correction_bleed_redirect_superseded", agentAssistRuntimePayload({
          sessionId: workflowSession.id,
          interactionId: workflowSession.work_item_id,
          supersededItemId: completed.item_id,
          keptItemId: target.item_id,
          baseSlotKey: base,
        }));
        continue;
      }

      // target.item_id's rejection (if any) was already cleared above, before
      // either branch. This branch only fires when target has no OTHER
      // direct completion in this response to defer to, so the redirect
      // itself is the sole surviving completion for target.item_id.
      workflowLogger.warn("workflow_correction_bleed_redirected", agentAssistRuntimePayload({
        sessionId: workflowSession.id,
        interactionId: workflowSession.work_item_id,
        fromItemId: completed.item_id,
        toItemId: target.item_id,
        baseSlotKey: base,
        value: completed.extracted_value,
      }));
      completed.item_id = target.item_id;
    }
  }

  // Fifth guard: address-shaped text landing on a non-address sibling slot
  // (department/room/bed) instead of the group's own *_address slot, while
  // that address slot is still open. Reported live: MCP auto-fill for
  // pickup_address failed (an upstream dispatch system data gap - the caller's
  // phone number had no facility record), forcing the caller to speak the
  // address aloud. STT delivers a spoken address in fragments across several
  // SEPARATE analyze calls ("twenty five hundred" / "Parkway" / "Stamford,
  // California"), and out of context a fragment like "Soto Transport
  // Parkway" doesn't obviously read as "this belongs to the address slot" -
  // department/room/bed are also open, untyped text slots at that moment,
  // and the model sometimes attributes address fragments to them instead.
  //
  // Scoped conservatively to avoid false positives: only redirects when the
  // extracted value contains an unambiguous street-suffix word (parkway,
  // street, avenue, ...). A bare number ("2500") is deliberately left
  // alone - a room/bed number genuinely IS just a number most of the time,
  // and redirecting on numeric shape alone would be far too trigger-happy
  // (it would wrongly steal legitimate room/bed numbers constantly).
  {
    // Codex review (PR #1382, round 2, P1): short abbreviated forms (st,
    // ct, dr, ...) are dangerously ambiguous in THIS specific healthcare
    // domain - "CT" is a common department name (CT scan/imaging), "St."
    // routinely appears in hospital names ("St. Mary's ICU"), and "Dr." is
    // the single most common word in this workflow's physician fields.
    // Matching those would misfire on entirely correct department/doctor
    // values. STT transcribes spoken words in full ("Parkway", not "Pkwy")
    // under normal circumstances, so restricting to unabbreviated words
    // only costs recall on the rare literal-abbreviation case, in exchange
    // for not corrupting extremely common healthcare terms.
    const STREET_SUFFIX_WORDS =
      /\b(street|avenue|parkway|road|drive|boulevard|lane|way|court|place|circle|highway|terrace|trail|square)\b/i;
    // Codex review (PR #1382, P2): "not validated as address" is too broad a
    // source condition - it also matches the group's OWN *_facility slot.
    // A facility name like "Oak Street Health" or "Parkway Medical Center"
    // is a completely plausible real value that contains a street-suffix
    // word purely by coincidence of naming, not because it's actually an
    // address. Redirecting that would steal a correct facility name away
    // into the address slot, corrupting both. Restrict eligible SOURCE
    // slots to an explicit allowlist of exactly the fields this guard is
    // meant for - department/room/bed - never facility (or anything else).
    const ADDRESS_MISATTRIBUTION_SOURCE_SUFFIXES = /_(department|room|bed)$/;

    for (const completed of analysisResult.completed_items || []) {
      if (bleedRejectedItemIds.has(completed.item_id)) continue;
      const item = analyzerItems.find((i) => i.item_id === completed.item_id);
      if (!item?.slot_name || item.slot_validation === "address") continue;
      if (!ADDRESS_MISATTRIBUTION_SOURCE_SUFFIXES.test(item.slot_name)) continue;

      const valueText = typeof completed.extracted_value === "string" ? completed.extracted_value : "";
      if (!STREET_SUFFIX_WORDS.test(valueText)) continue;

      const prefixMatch = item.slot_name.match(/^(pickup|destination|sending|receiving)_/);
      if (!prefixMatch) continue;
      const prefix = prefixMatch[1];

      const addressSibling = pendingItems.find((sib) =>
        sib.slot_validation === "address" && sib.slot_name?.startsWith(`${prefix}_`)
      );
      if (!addressSibling) continue;

      // Same duplicate-target protection as guard 4: if this response ALSO
      // directly completed the address sibling itself, trust that direct
      // completion and drop this misattributed one rather than creating a
      // second entry for the same row (see the round-5 fix above for why).
      const addressAlreadyCompletedDirectly = (analysisResult.completed_items || []).some(
        (c) => c !== completed && c.item_id === addressSibling.item_id
      );
      if (addressAlreadyCompletedDirectly) {
        bleedRejectedItemIds.add(completed.item_id);
        continue;
      }

      workflowLogger.warn("workflow_address_shaped_value_redirected", agentAssistRuntimePayload({
        sessionId: workflowSession.id,
        interactionId: workflowSession.work_item_id,
        fromItemId: completed.item_id,
        toItemId: addressSibling.item_id,
        fromSlotName: item.slot_name,
        toSlotName: addressSibling.slot_name,
      }));
      completed.item_id = addressSibling.item_id;
    }
  }

  // Sixth guard: caller confirms the pickup facility IS the requesting
  // facility (e.g. a transfer/dispatch center calling on behalf of the
  // hospital it's already identified as caller_facility). Synthesize a
  // pickup_facility completion from the already-captured caller_facility
  // value instead of making the caller repeat the same name — the analyzer
  // itself can't do this: an already-completed slot's value is stripped from
  // its prompt context entirely outside the read-back correction path (see
  // the correction-candidate handling in the completed-items loop below), so
  // caller_facility's value is invisible to the LLM here regardless of hints.
  {
    // Reported live: the LLM extracted extracted_value: true at 0.85
    // confidence (above confidenceThreshold) for this item from the
    // utterance "I want to transfer. One patient Talisis." - text with zero
    // relation to the question. The model's self-reported confidence isn't
    // a reliable signal of genuine certainty here, and this completion
    // drives a high-consequence auto-copy (a wrong facility silently
    // becomes pickup_facility, and since transfer/dispatch centers are
    // structurally excluded from lookup_addresses, the pickup address then
    // silently never resolves with no visible error). Require recognizable
    // affirmative language as a deterministic backstop the confidence score
    // alone can't provide.
    const AFFIRMATIVE_LANGUAGE_RE = /\b(yes|yeah|yep|yup|correct|right|affirmative|sure|same|it is|we do|that's it|exactly)\b/i;
    // Codex review (round 3, P1): presence of an affirmative-sounding word
    // alone isn't enough either - "No, that's not the same facility" or
    // "I'm not sure" both contain a token from the list above ("same",
    // "sure") despite being a denial. This guard exists specifically
    // because the model's own true/false classification can't be trusted,
    // so it can't then turn around and assume the model got the
    // SURROUNDING negation right. Any negation word anywhere in the
    // transcript blocks the copy outright, even alongside an affirmative
    // token - a blanket, conservative rule (a real "yes, but not the same
    // department" false negative just means the caller/agent repeats
    // themselves; a false positive silently corrupts the pickup facility).
    // n't is matched WITHOUT a leading \b: a leading boundary can never
    // match there in real contractions ("isn't", "don't", "wasn't") since
    // the apostrophe is always preceded by a word character (part of the
    // stem), not a boundary. Only the trailing \b (before the following
    // space/punctuation) is meaningful.
    //
    // Codex review (round 4, P1): explicit no/not forms aren't the only way
    // to deny sameness. "It is a different facility" and "It is over at
    // another facility" both contain "it is" (an accepted affirmative
    // phrase) and NEITHER uses any word above - they're semantic denials
    // via contrast, not negation. Since this is a keyword backstop, not
    // real semantic understanding, contrast/differentiation words are
    // folded into the same blocking list rather than trying to enumerate
    // every way a denial can be phrased without "no"/"not".
    const NEGATION_RE = /\b(no|not|never|none|nope|nah|negative|different|another|separate|elsewhere)\b|n't\b/i;

    const requestingFacilityItem = analyzerItems.find(
      (i) => i.slot_name === "pickup_same_as_requesting_facility"
    );
    // Codex review (P1): a truthy answer alone isn't enough - a noisy or
    // ambiguous affirmative below threshold would otherwise get promoted
    // straight to a confidence-1 pickup_facility completion, even though
    // the boolean confirmation itself would only reach "suggested" (still
    // awaiting agent confirmation) through the normal completed-items path.
    const requestingFacilityRawCompletion = requestingFacilityItem
      ? (analysisResult.completed_items || []).find((c) => {
          if (c.item_id !== requestingFacilityItem.item_id) return false;
          if (typeof c.confidence === "number" && c.confidence < confidenceThreshold) return false;
          const v = c.extracted_value;
          return v === true || /^(true|yes)$/i.test(String(v ?? ""));
        })
      : null;

    let confirmedSame = null;
    if (requestingFacilityRawCompletion) {
      // Codex review (P1): validate against the TRUSTED transcript for this
      // pass, not completed.source_text - that field is generated by the
      // SAME LLM call that produced the (possibly hallucinated) boolean and
      // is never checked against what was actually said, so a hallucinated
      // "true" can arrive with an equally hallucinated supporting quote that
      // would sail through a source_text-only check. transcript is the real
      // STT output for this utterance, independent of anything the model
      // claims about it (same trust boundary the bare yes/no check elsewhere
      // in this function already relies on).
      if (AFFIRMATIVE_LANGUAGE_RE.test(transcript) && !NEGATION_RE.test(transcript)) {
        confirmedSame = requestingFacilityRawCompletion;
      } else {
        // Codex review (P2): don't let a rejected "true" silently complete
        // via the normal completed-items path below with no copy - an
        // already-completed boolean is never sent to the analyzer again, so
        // that would strand the confirmation exactly like the
        // callerFacilityUnsettled case below: no copy happens THIS pass, but
        // there's also no later pass that could retry it, and the caller has
        // to repeat the facility name after all. Reject the raw completion
        // outright instead, keeping the item open for a later, unambiguous
        // pass (or an agent confirmation) to try again.
        bleedRejectedItemIds.add(requestingFacilityRawCompletion.item_id);
      }
    }

    if (confirmedSame) {
      const pickupFacilityItem = pendingItems.find((i) => i.slot_name === "pickup_facility");
      // Only step in when nothing already gave pickup_facility a value this
      // pass — a caller who answers "yes" and then immediately states a
      // DIFFERENT facility name in the same breath means that direct
      // statement, not the copy. Nothing to copy at all once pickup_facility
      // is no longer open (already filled some other way) — let the plain
      // boolean completion through below.
      const pickupAlreadyCompletedDirectly = pickupFacilityItem
        ? (analysisResult.completed_items || []).some(
            (c) => c !== confirmedSame && c.item_id === pickupFacilityItem.item_id
          )
        : false;

      if (pickupFacilityItem && !pickupAlreadyCompletedDirectly) {
        const callerFacilityItem = analyzerItems.find((i) => i.slot_name === "caller_facility");
        const callerFacilityCompletionThisPass = callerFacilityItem
          ? (analysisResult.completed_items || []).find((c) => c.item_id === callerFacilityItem.item_id)
          : null;

        let currentCallerFacility;
        let callerFacilityUnsettled = false;

        if (callerFacilityCompletionThisPass) {
          // caller_facility is ALSO being touched in this same response —
          // either a first-time capture said in the same breath ("This is
          // Sutter calling... yes, that's the pickup facility too") or a
          // correction/reassertion of an already-completed value.
          const isCorrection = callerFacilityItem.current_status === "completed";
          const clearsThreshold =
            typeof callerFacilityCompletionThisPass.confidence !== "number" ||
            callerFacilityCompletionThisPass.confidence >= confidenceThreshold;
          if (!isCorrection && clearsThreshold) {
            // Safe to use directly — nothing stale is in play, it just
            // hasn't been persisted yet, and it clears the same bar the
            // completed-items loop below would apply to it anyway.
            currentCallerFacility = callerFacilityCompletionThisPass.extracted_value;
          } else {
            // A correction lands as a low-confidence "suggested" candidate
            // and does NOT update slotsFilled until confirmed (see the
            // correction-candidate handling below); a first-time extraction
            // that doesn't itself clear the threshold is no more
            // trustworthy borrowed than it would be kept. Not safe to copy
            // right now either way.
            callerFacilityUnsettled = true;
          }
        } else {
          // Codex review (P1): re-read caller_facility fresh from the
          // session row right before copying, instead of trusting the
          // slotsFilled snapshot loaded at the start of this request. A
          // manual edit landing concurrently (agent retypes caller_facility
          // while this analyze call's LLM round trip is still in flight)
          // commits directly to the session and would otherwise be
          // invisible here, letting a stale value get locked onto
          // pickup_facility at confidence 1.
          const { rows: [freshRow] } = await connectionRef.client.query(
            `SELECT slots_filled ->> 'caller_facility' AS caller_facility FROM aa_workflow_sessions WHERE id = $1`,
            [workflowSession.id]
          );
          currentCallerFacility = freshRow?.caller_facility ?? slotsFilled.caller_facility;
        }

        if (!callerFacilityUnsettled && hasMeaningfulExtractedValue(currentCallerFacility)) {
          workflowLogger.info("workflow_pickup_facility_copied_from_requesting_facility", agentAssistRuntimePayload({
            sessionId: workflowSession.id,
            interactionId: workflowSession.work_item_id,
            toItemId: pickupFacilityItem.item_id,
          }));
          // Codex review (P1): derived_from_slot travels ON this
          // completed_items entry and is written by the SAME atomic claim
          // UPDATE below, not a separate pass after the fact. A separate
          // post-loop stamp keyed on status='completed' would also match a
          // manual edit that won the race against this synthesized
          // completion (autoCompleteClaimed === 0), wrongly marking the
          // agent's own value as derived and exposing it to reconciliation.
          analysisResult.completed_items = [
            ...(analysisResult.completed_items || []),
            {
              item_id: pickupFacilityItem.item_id,
              extracted_value: currentCallerFacility,
              confidence: 1,
              source_text: confirmedSame.source_text,
              alternatives: [],
              derived_from_slot: "caller_facility",
            },
          ];
        } else {
          // Codex review (P2): don't let the "yes" itself be silently
          // consumed/completed when we can't safely apply its effect this
          // pass (caller_facility mid-correction, a too-uncertain first-time
          // extraction, or — rarer — still invisible here because a
          // concurrent concept-group branch split this same debounce batch
          // and hasn't committed its own slots_filled write yet — see
          // runConceptGroupBranch). Rejecting rather than completing avoids
          // locking in a wrong pickup facility, but this is NOT a seamless
          // retry: buildWorkflowAnalysisUserPrompt explicitly tells the
          // model not to extract values from a transcript line once it has
          // scrolled into "recent conversation" context, so this exact
          // utterance will not be silently reprocessed once it ages out of
          // the live segment. The caller/agent may need to reconfirm
          // explicitly on a later turn for this specific race — an accepted
          // tradeoff over risking the wrong pickup facility.
          bleedRejectedItemIds.add(confirmedSame.item_id);
        }
      }
    }
  }

  // Seventh guard: pickup_facility already has a value from a source OTHER
  // than the Sixth guard's copy (the caller stated it directly, e.g.
  // "pickup is Summit Hospital", without ever answering "is that the same as
  // your facility?"). Left open, that now-moot boolean would permanently
  // block: suggestion-target-resolver.mjs treats every open slot as
  // blocking regardless of is_required, and the read-back completion step
  // below is gated on hasUnconfirmedSlot, which scans the FULL unnarrowed
  // allPendingItems for any open slot-type item. Synthesize a completion
  // for the boolean (value doesn't matter beyond "not blocking" — nothing
  // else reads it) instead of stalling the rest of the call on a question
  // whose answer no longer changes anything.
  {
    const requestingFacilityOpenItem = allPendingItems.find(
      (i) => i.slot_name === "pickup_same_as_requesting_facility"
    );
    // Codex review (round 3, P2): a completed_items entry the Sixth guard
    // already rejected (bleedRejectedItemIds - a hallucinated "true" that
    // failed the affirmative-language check) gets skipped entirely in the
    // completed-items loop below, so it never actually answers anything.
    // Counting it here as "already answered this pass" would wrongly stop
    // THIS guard from synthesizing the moot resolution too - stranding the
    // boolean open forever whenever pickup_facility is ALSO already
    // resolved (directly or otherwise) in the very same response that
    // produced the rejected hallucination.
    const alreadyAnsweredThisPass = Boolean(
      requestingFacilityOpenItem &&
        (analysisResult.completed_items || []).some(
          (c) => c.item_id === requestingFacilityOpenItem.item_id && !bleedRejectedItemIds.has(c.item_id)
        )
    );

    if (requestingFacilityOpenItem && !alreadyAnsweredThisPass) {
      const pickupFacilityItemRef = analyzerItems.find((i) => i.slot_name === "pickup_facility");
      const pickupHasValueThisPass = Boolean(
        pickupFacilityItemRef &&
          (analysisResult.completed_items || []).some(
            (c) => c.item_id === pickupFacilityItemRef.item_id && hasMeaningfulExtractedValue(c.extracted_value)
          )
      );

      if (pickupHasValueThisPass || hasMeaningfulExtractedValue(slotsFilled.pickup_facility)) {
        workflowLogger.info("workflow_pickup_same_as_requesting_facility_moot", agentAssistRuntimePayload({
          sessionId: workflowSession.id,
          interactionId: workflowSession.work_item_id,
          itemId: requestingFacilityOpenItem.item_id,
        }));
        // Codex review (round 3, P2 follow-up): a hallucinated-and-rejected
        // "true" for this SAME item_id can already be sitting in
        // completed_items (the Sixth guard's bleedRejectedItemIds path) -
        // simply appending a second entry and un-rejecting the item_id
        // would expose that stale "true" to the completed-items loop below
        // too, since bleedRejectedItemIds matches by item_id, not by entry
        // reference. Overwrite the existing entry in place when there is
        // one, so exactly one outcome ever exists for this item_id.
        const existingEntry = (analysisResult.completed_items || []).find(
          (c) => c.item_id === requestingFacilityOpenItem.item_id
        );
        if (existingEntry) {
          existingEntry.extracted_value = false;
          existingEntry.confidence = 1;
          existingEntry.source_text = null;
          existingEntry.alternatives = [];
        } else {
          analysisResult.completed_items = [
            ...(analysisResult.completed_items || []),
            {
              item_id: requestingFacilityOpenItem.item_id,
              extracted_value: false,
              confidence: 1,
              source_text: null,
              alternatives: [],
            },
          ];
        }
        // Whichever entry now represents this item_id (mutated or freshly
        // appended) must actually be processed below, not skipped.
        bleedRejectedItemIds.delete(requestingFacilityOpenItem.item_id);
      }
    }
  }

  // Process completed items
  for (const completed of analysisResult.completed_items || []) {
    if (bleedRejectedItemIds.has(completed.item_id)) continue;
    // Get item details including completion_trigger (search the analyzer input,
    // which also carries completed notes slots still accumulating).
    const item = analyzerItems.find(p => p.item_id === completed.item_id);
    if (!item) continue;

    // Check if completion_trigger matches speaker
    const completionTrigger = item.completion_trigger || "agent";
    const shouldComplete =
      Boolean(speakerType) &&
      (completionTrigger === "either" ||
        (completionTrigger === "customer" && speakerType === "customer") ||
        (completionTrigger === "agent" && speakerType === "agent"));
    const hasExtractedSlotValue = item.type !== "slot" || hasMeaningfulExtractedValue(completed.extracted_value);

    // Ignore wrong-speaker detections and empty slot hits. This prevents an agent's
    // question or prompt hint from completing a customer-owned slot with a blank value.
    if (!shouldComplete || !hasExtractedSlotValue) {
      continue;
    }

    // Keep the final read-back / "confirm all information" item OPEN until every
    // slot has been collected AND confirmed. Otherwise a per-slot confirmation
    // exchange ("please confirm that's correct" / "that's correct") auto-completes
    // it and the agent never gets the full read-back. allPendingItems (not the
    // possibly-scoped pendingItems — see isReadBackStage above) still lists any
    // slot that is pending or an unconfirmed low-confidence suggestion, ANYWHERE
    // in the workflow, not just this concept group.
    const hasUnconfirmedSlot = allPendingItems.some((p) => p.type === "slot");
    if (
      item.type !== "slot" &&
      hasUnconfirmedSlot &&
      isReadBackItem({ itemType: item.type, itemLabel: item.label, itemPromptHint: item.prompt_hint, itemHints: item.hints })
    ) {
      continue;
    }

    // A notes slot that has ALREADY completed is re-analyzed so later
    // utterances of a multi-sentence note keep accumulating. Only append a
    // fragment that clears the confidence threshold — otherwise noisy/ambiguous
    // post-completion STT would be permanently glued onto the note. Dedup means
    // a repeated/echoed fragment is a no-op.
    if (item.current_status === "completed" && item.type === "slot" && isAccumulatingSlot(item)) {
      if (completed.confidence < confidenceThreshold) {
        continue;
      }
      const accumulated = accumulateSlotValue(slotsFilled[item.slot_name], completed.extracted_value);
      if (accumulated !== (slotsFilled[item.slot_name] ?? "")) {
        slotsFilled[item.slot_name] = accumulated;
        slotsDelta[item.slot_name] = accumulated;
        await connectionRef.client.query(
          `UPDATE aa_workflow_item_status
             SET extracted_value = $1, source_transcript = $2, updated_at = NOW()
           WHERE session_id = $3 AND item_id = $4`,
          [accumulated, transcript, workflowSession.id, completed.item_id]
        );
        updates.push({
          item_id: completed.item_id,
          status: "completed",
          confidence: completed.confidence,
          extracted_value: accumulated,
          source_text: completed.source_text,
          alternatives: [],
        });
      }
      continue;
    }

    // A correction candidate (already-completed slot, re-included ONLY at
    // the read-back stage — see correctionCandidateItems) is ALWAYS
    // surfaced as "suggested" — pending agent confirmation — never
    // silently auto-completed and never silently dropped, regardless of
    // confidence. Confidence alone isn't a reliable signal for a
    // correction: STT can garble the corrected value into something that
    // still scores high confidence (e.g. "Stonemere" for "John Mabry
    // Hospital" scored 0.92 and was auto-applied before this change,
    // landing on the wrong value with no visible flag that anything had
    // changed). Routing every correction through "suggested" reuses the
    // EXISTING low-confidence confirmation UI (chips / "please confirm")
    // instead of a silent overwrite, and — because a "suggested" slot is
    // NOT written to slots_filled until confirmed — the OLD value stays
    // authoritative for read-back until the agent explicitly confirms the
    // new one, so a bad guess can't silently become the record of truth.
    if (item.current_status === "completed") {
      if (!hasMeaningfulExtractedValue(completed.extracted_value)) continue;
      const correctionAlternatives =
        Array.isArray(completed.alternatives) && completed.alternatives.length > 0
          ? JSON.stringify(completed.alternatives)
          : null;
      // Guarded in SQL, not just by the candidate filter above: the agent can
      // pencil-edit this slot DURING the multi-second LLM window, after the
      // candidate set was built. A manual row (is_manual_edit=TRUE, set only
      // by the manual complete/slot routes) is never downgraded — the
      // agent's typed value is not in the transcript, so an LLM "correction"
      // for it can only be the stale value it replaced (an earlier fix).
      // Agent-SPOKEN captures (completed_by='agent' but is_manual_edit=FALSE)
      // carry a real LLM confidence and stay correctable, even when that
      // confidence happens to be exactly 1.0. rowCount drives the response
      // so the client is never told to un-complete a row the guard refused.
      const { rowCount: correctionClaimed } = await connectionRef.client.query(
        `UPDATE aa_workflow_item_status
           SET status = 'suggested',
               completed_at = NULL,
               completed_by = 'ai',
               extracted_value = $1,
               confidence_score = $2,
               source_transcript = $3,
               alternatives = $6::jsonb,
               updated_at = NOW()
         WHERE session_id = $4 AND item_id = $5
           AND is_manual_edit IS NOT TRUE`,
        [
          completed.extracted_value,
          completed.confidence,
          transcript,
          workflowSession.id,
          completed.item_id,
          correctionAlternatives,
        ]
      );
      if (correctionClaimed === 0) continue;
      updates.push({
        item_id: completed.item_id,
        status: "suggested",
        confidence: completed.confidence,
        extracted_value: completed.extracted_value,
        source_text: completed.source_text,
        alternatives: Array.isArray(completed.alternatives) ? completed.alternatives : [],
        completed_by: "ai",
        low_confidence: true,
        confidence_threshold: confidenceThreshold,
        is_correction: true,
      });
      continue;
    }

    // Only auto-complete if confidence is high enough; otherwise persist a suggestion.
    if (completed.confidence >= confidenceThreshold) {
      // Update item status. completed_at uses clock_timestamp(), NOT NOW():
      // NOW() is frozen at the whole (possibly multi-utterance) batch
      // transaction's START time, not the actual moment this statement
      // executes — a later utterance in the same batch checking the bleed
      // guard's BLEED_WINDOW_MS freshness (below) against this timestamp
      // would see an artificially inflated age once the batch's total LLM
      // latency approaches the window, silently weakening the guard.
      // clock_timestamp() advances with real wall-clock time even inside a
      // single transaction.
      // Guarded on status: this item was pending/suggested when the batch's
      // SELECT ran, but the agent can manually complete it (pencil edit, or
      // confirming a suggestion) during the multi-second LLM window. A row
      // that reached 'completed' since then — necessarily an agent action,
      // the analyzer itself is sequential within a group — must not be
      // overwritten with the transcript-derived value (an earlier fix). rowCount
      // gates the response and slots_filled so a refused write is never
      // reported to the client or promoted into dispatch data.
      //
      // derived_from_slot defaults to NULL for a normal completion (spoken
      // value, correction, whatever) — it's this item's own independent
      // answer, not a copy. The Sixth guard's pickup_facility <-
      // caller_facility copy goes through this exact same branch
      // (confidence 1) and carries its own derived_from_slot value on the
      // completed_items entry, written by THIS SAME atomic claim — never by
      // a separate pass after the fact, which could otherwise stamp a
      // manual edit that won this exact claim race (Codex review, P1).
      const { rowCount: autoCompleteClaimed } = await connectionRef.client.query(
        `UPDATE aa_workflow_item_status
         SET status = 'completed',
             completed_at = clock_timestamp(),
             completed_by = $1,
             extracted_value = $2,
             confidence_score = $3,
             source_transcript = $4,
             alternatives = NULL,
             derived_from_slot = $7,
             updated_at = NOW()
         WHERE session_id = $5 AND item_id = $6
           AND status IN ('pending', 'suggested')`,
        [
          speakerType || "auto",
          completed.extracted_value ?? null,
          completed.confidence,
          transcript,
          workflowSession.id,
          completed.item_id,
          completed.derived_from_slot ?? null,
        ]
      );
      if (autoCompleteClaimed === 0) continue;

      // If this is a slot item with a value, update slots_filled. Use the
      // meaningful-value check (not truthiness) so boolean false / numeric 0
      // are kept — e.g. accompanying=false, iv_count=0. Free-text notes slots
      // accumulate across utterances instead of overwriting, so a multi-
      // sentence answer isn't reduced to its last fragment.
      if (item?.slot_name && hasMeaningfulExtractedValue(completed.extracted_value)) {
        slotsFilled[item.slot_name] = isAccumulatingSlot(item)
          ? accumulateSlotValue(slotsFilled[item.slot_name], completed.extracted_value)
          : completed.extracted_value;
        slotsDelta[item.slot_name] = slotsFilled[item.slot_name];
      }

      updates.push({
        item_id: completed.item_id,
        status: "completed",
        confidence: completed.confidence,
        extracted_value: completed.extracted_value,
        source_text: completed.source_text,
        alternatives: [],
        // Only surfaced for the read-back/confirm-all item, and only when
        // the CUSTOMER's own utterance completed it — the resolver's
        // readBackAlreadyConfirmed gate needs this signal specifically.
        // Deliberately NOT set when speakerType is "agent": the LLM can
        // auto-complete "Read back transport details" from the AGENT'S
        // OWN recitation, and completed_by: "agent" is also what the
        // manual-complete endpoint (item/[id]/complete/route.js) writes
        // for an explicit agent click — conflating the two would let an
        // auto-detected recitation look like a deliberate manual
        // confirmation. Omitted (falls back to "ai") for every other
        // case so the existing completed_by:"ai" UI badge behavior (see
        // AgentAssistWorkflow.jsx / WorkflowHistoryView.jsx) is unchanged.
        ...(speakerType === "customer" &&
        isReadBackItem({
          itemType: item.type,
          itemLabel: item.label,
          itemPromptHint: item.prompt_hint,
          itemHints: item.hints,
        })
          ? { completed_by: "customer" }
          : null),
      });
    } else {
      // Persist as suggestion (don't auto-complete) so the agent can confirm or correct it.
      // Store the low-confidence alternatives so the agent desktop can render
      // confirmation chips (previously only the insights path produced these).
      const suggestedAlternatives =
        Array.isArray(completed.alternatives) && completed.alternatives.length > 0
          ? JSON.stringify(completed.alternatives)
          : null;
      // Same status guard as the auto-complete branch: never demote a row an
      // agent completed during the LLM window back to 'suggested' (an earlier fix).
      const { rowCount: suggestClaimed } = await connectionRef.client.query(
        `UPDATE aa_workflow_item_status
         SET status = $1::varchar,
             completed_at = NULL,
             completed_by = 'ai',
             extracted_value = $2,
             confidence_score = $3,
             source_transcript = $4,
             alternatives = $7::jsonb,
             updated_at = NOW()
         WHERE session_id = $5 AND item_id = $6
           AND status IN ('pending', 'suggested')`,
        [
          'suggested',
          completed.extracted_value ?? null,
          completed.confidence,
          transcript,
          workflowSession.id,
          completed.item_id,
          suggestedAlternatives,
        ]
      );
      if (suggestClaimed === 0) continue;

      updates.push({
        item_id: completed.item_id,
        status: "suggested",
        confidence: completed.confidence,
        extracted_value: completed.extracted_value,
        source_text: completed.source_text,
        alternatives: Array.isArray(completed.alternatives) ? completed.alternatives : [],
        completed_by: "ai",
        low_confidence: completed.confidence < confidenceThreshold,
        confidence_threshold: confidenceThreshold,
        completion_trigger_pending: !shouldComplete,
      });
    }
  }

  // Deterministic backstop: the read-back "confirm all information is
  // correct"-style item is a single, extremely high-value completion that
  // the LLM has repeatedly missed in live testing despite an unambiguous
  // customer affirmative. If the model didn't already flag it above, check
  // the raw transcript directly against the item's own hints and complete
  // it deterministically when customer-spoken at the read-back stage.
  // pendingItems only lists items still pending/suggested, so this
  // naturally no-ops once the item is already completed.
  if (isReadBackStage && speakerType === "customer") {
    // allPendingItems, NOT the possibly concept-group-scoped pendingItems: in
    // a multi-group batch the affirmative utterance is classified into
    // whatever group its content resembles, while the Confirmation items
    // belong to their own group — a scoped lookup finds nothing and the
    // backstop silently never fires (Codex P1 on #1367; same class as the
    // recitation lookup below). isReadBackStage is already computed against
    // the whole workflow, so the gate and the lookup now agree.
    const readBackConfirmItem = allPendingItems.find(
      (item) =>
        item.completion_trigger === "customer" &&
        isReadBackItem({
          itemType: item.type,
          itemLabel: item.label,
          itemPromptHint: item.prompt_hint,
          itemHints: item.hints,
        })
    );
    const alreadyHandledThisTurn =
      readBackConfirmItem && updates.some((u) => u.item_id === readBackConfirmItem.item_id);
    if (
      readBackConfirmItem &&
      !alreadyHandledThisTurn &&
      matchesReadBackAffirmativeHints(transcript, readBackConfirmItem)
    ) {
      await connectionRef.client.query(
        `UPDATE aa_workflow_item_status
           SET status = 'completed', completed_at = clock_timestamp(), completed_by = $1,
               extracted_value = $2, confidence_score = 1, source_transcript = $3,
               alternatives = NULL, updated_at = NOW()
         WHERE session_id = $4 AND item_id = $5`,
        [speakerType, true, transcript, workflowSession.id, readBackConfirmItem.item_id]
      );
      updates.push({
        item_id: readBackConfirmItem.item_id,
        status: "completed",
        confidence: 1,
        extracted_value: true,
        source_text: transcript,
        alternatives: [],
        // This block only runs for speakerType === "customer" (checked
        // above), so this is always the caller's own sign-off.
        completed_by: speakerType,
      });
    }
  }

  // Deterministic backstop for the AGENT's recitation (Observed in field testing: "the
  // confirmation needs to move on once the agent speaks it"). The
  // agent-triggered "Read back transport details" action otherwise completes
  // only if the LLM flags it at >= the confidence threshold — a path that has
  // been seen to miss, leaving the panel stuck on the read-back card and the
  // session capped below 100%. When the agent's own utterance carries several
  // distinct captured slot values at once (matchesAgentRecitation), that IS
  // the recitation — complete it directly.
  //
  // Deliberately gated on isReadBackStage rather than the hasUnconfirmedSlot
  // guard used by the LLM path: isReadBackStage tolerates a correction parked
  // at 'suggested' whose slot already has a value, so re-reciting the updated
  // summary during an in-flight correction still advances. Everything
  // customer-owned is untouched: the confirm-all item still requires the
  // customer's own affirmative (block above), and the correction-promotion
  // sweep below keys on completion_trigger === 'customer'.
  if (isReadBackStage && speakerType === "agent") {
    // allPendingItems for the same reason as the customer backstop above: a
    // recitation utterance is FULL of clinical/location slot values, so group
    // classification routes it into one of those groups — the Confirmation
    // group's recitation action is never in the scoped pendingItems and a
    // scoped lookup would make this backstop unreachable in exactly the
    // batched case (Codex P1 on #1367).
    const recitationItem = allPendingItems.find(
      (item) =>
        item.completion_trigger === "agent" &&
        isReadBackItem({
          itemType: item.type,
          itemLabel: item.label,
          itemPromptHint: item.prompt_hint,
          itemHints: item.hints,
        })
    );
    // Only a COMPLETED update this turn counts as handled. The LLM path can
    // park the recitation at 'suggested' (below the confidence threshold) in
    // this same batch — that is exactly the miss this backstop exists for,
    // so a suggested entry must not suppress the deterministic match (Codex
    // P1 on #1367).
    const alreadyCompletedThisTurn =
      recitationItem &&
      updates.some((u) => u.item_id === recitationItem.item_id && u.status === "completed");
    if (
      recitationItem &&
      !alreadyCompletedThisTurn &&
      matchesAgentRecitation(transcript, slotsFilled)
    ) {
      const { rowCount: recitationClaimed } = await connectionRef.client.query(
        `UPDATE aa_workflow_item_status
           SET status = 'completed', completed_at = clock_timestamp(), completed_by = 'agent',
               confidence_score = 1, source_transcript = $1,
               alternatives = NULL, updated_at = NOW()
         WHERE session_id = $2 AND item_id = $3
           AND status IN ('pending', 'suggested')`,
        [transcript, workflowSession.id, recitationItem.item_id]
      );
      if (recitationClaimed > 0) {
        // Supersede a same-turn 'suggested' entry for this item so the client
        // never renders a low-confidence flash before the completion lands.
        const supersededIndex = updates.findIndex((u) => u.item_id === recitationItem.item_id);
        if (supersededIndex !== -1) updates.splice(supersededIndex, 1);
        updates.push({
          item_id: recitationItem.item_id,
          status: "completed",
          confidence: 1,
          extracted_value: true,
          source_text: transcript,
          alternatives: [],
          // The agent's own recitation — NOT 'customer' (the resolver's
          // readBackAlreadyConfirmed gate must not see it as the caller's
          // sign-off), and NOT is_manual_edit (nobody clicked anything).
          completed_by: "agent",
        });
        workflowLogger.info("workflow_recitation_autocompleted", agentAssistRuntimePayload({
          sessionId: workflowSession.id,
          interactionId: workflowSession.work_item_id,
          itemId: recitationItem.item_id,
        }));
      }
    }
  }

  // The customer just gave the final read-back affirmative (e.g. "Confirm
  // all information is correct" completing). Auto-promote every OTHER
  // still-pending correction candidate in the same breath: the caller
  // already reviewed and accepted the WHOLE updated summary (which folds
  // in every pending correction — see buildReadBackSuggestion's
  // callers), not just the read-back item by itself. Without this, each
  // correction would still need its own separate "please confirm"
  // exchange even after the caller already said the whole thing looks
  // right.
  //
  // Requires completion_trigger === "customer" specifically — isReadBackItem
  // alone also matches the AGENT's own "Read back transport details"
  // recitation action (both share "read back" phrasing). Without this,
  // the agent completing their own recitation — e.g. by manually
  // checking it off, or the LLM auto-detecting it from the agent's own
  // utterance — would satisfy this check and promote every pending
  // correction into slots_filled as authoritative BEFORE the customer
  // has actually reviewed or approved anything, letting a misheard
  // correction become the record of truth on the agent's say-so alone.
  //
  // A correction candidate is identified the same way isReadBackStage's
  // slot check is: a "suggested" slot whose slot_name ALREADY has a value
  // in slots_filled. A genuine first-time low-confidence suggestion has
  // no slots_filled entry yet, so it is deliberately NOT swept up here —
  // it still needs its own individual confirmation.
  const readBackJustConfirmed = updates.some((u) => {
    if (u.status !== "completed") return false;
    const completedItem =
      analyzerItems.find((p) => p.item_id === u.item_id) ||
      pendingItems.find((p) => p.item_id === u.item_id);
    return (
      completedItem &&
      completedItem.completion_trigger === "customer" &&
      isReadBackItem({
        itemType: completedItem.type,
        itemLabel: completedItem.label,
        itemPromptHint: completedItem.prompt_hint,
        itemHints: completedItem.hints,
      })
    );
  });

  if (readBackJustConfirmed) {
    const { rows: pendingCorrectionRows } = await connectionRef.client.query(
      `SELECT i.id as item_id, i.slot_name, ist.extracted_value, ist.confidence_score
         FROM aa_workflow_item_status ist
         JOIN aa_workflow_items i ON i.id = ist.item_id
        WHERE ist.session_id = $1 AND ist.status = 'suggested' AND i.type = 'slot'`,
      [workflowSession.id]
    );
    for (const row of pendingCorrectionRows) {
      if (!row.slot_name) continue;
      if (!hasMeaningfulExtractedValue(slotsFilled[row.slot_name])) continue; // not a correction candidate
      if (!hasMeaningfulExtractedValue(row.extracted_value)) continue;
      // completed_at uses clock_timestamp(), not NOW() — same reasoning as
      // the auto-complete branch above: this promotes a slot within the
      // same (possibly multi-utterance) batch transaction, and a later
      // utterance's bleed guard freshness check needs the TRUE completion
      // moment, not the transaction's frozen start time.
      await connectionRef.client.query(
        `UPDATE aa_workflow_item_status
           SET status = 'completed', completed_at = clock_timestamp(), completed_by = $1,
               alternatives = NULL, derived_from_slot = NULL, updated_at = NOW()
         WHERE session_id = $2 AND item_id = $3`,
        [speakerType || "customer", workflowSession.id, row.item_id]
      );
      slotsFilled[row.slot_name] = row.extracted_value;
      slotsDelta[row.slot_name] = row.extracted_value;
      updates.push({
        item_id: row.item_id,
        status: "completed",
        confidence: row.confidence_score,
        extracted_value: row.extracted_value,
        source_text: transcript,
        alternatives: [],
      });
    }
  }

  // an earlier fix: a room resolved as not-applicable (scene pickup, residence — the
  // analyzer returns "N/A" for these, see the "No information available" rule
  // in buildWorkflowAnalysisSystemPrompt) means there is no bed either. Resolve
  // the paired bed slot here rather than leaving it open, so the suggested-
  // response panel advances instead of asking for a bed number that cannot
  // exist. Runs after every completion above has landed in slotsFilled, so a
  // room resolved earlier in THIS same batch is already visible.
  //
  // Scoped to allPendingItems: a bed that already holds a value is not in this
  // list, so a bed the caller genuinely answered is never overwritten.
  const inferredBeds = await resolveInferredBeds({
    client: connectionRef.client,
    sessionId: workflowSession.id,
    items: allPendingItems,
    slotsFilled,
  });

  for (const { item: bedItem, roomSlotName, roomValue } of inferredBeds) {
    slotsDelta[bedItem.slot_name] = NO_BED_VALUE;

    updates.push({
      item_id: bedItem.item_id,
      status: "completed",
      confidence: 1,
      extracted_value: NO_BED_VALUE,
      source_text: transcript,
      alternatives: [],
      completed_by: INFERRED_BY,
    });

    workflowLogger.info("workflow_bed_inferred_from_no_room", agentAssistRuntimePayload({
      sessionId: workflowSession.id,
      interactionId: workflowSession.work_item_id,
      slotName: bedItem.slot_name,
      reason: `${roomSlotName}=${roomValue ?? "(skipped)"}`,
    }));
  }

  return { updates, analysisResult, skipped: false };
}

/**
 * Run one concept group's ordered utterances sequentially, in their OWN DB
 * connection/transaction — separate from any other concurrently-running
 * group's branch. Postgres can't run two queries concurrently on one
 * connection, so true cross-group concurrency requires separate connections;
 * each branch commits its own slots_filled delta independently via the same
 * atomic jsonb-merge UPDATE the single-stream path already uses (safe for
 * concurrent writers since groups touch disjoint slot keys by construction —
 * see computeConceptGroups).
 *
 * Returns { updates, analysisResult, ok }. ok: false means this branch's
 * transaction was rolled back (its utterances contributed nothing) — the
 * caller uses Promise.allSettled so one group's failure doesn't lose other
 * groups' results.
 */
async function runConceptGroupBranch({
  pool,
  workflowSession,
  callControlId,
  assistConfig,
  llmModel,
  fallbackModel,
  reasoningEnabled,
  maxOutputTokens,
  confidenceThreshold,
  utterances,
  scopeItemIds,
  requestSignal,
}) {
  let branchClient = await pool.connect();
  const connectionRef = { client: branchClient };
  const branchUpdates = [];
  const branchSlotsDelta = {};
  let branchAnalysisResult = null;
  try {
    await branchClient.query("BEGIN");
    // Fresh read at branch start: concurrent branches only ever write DISJOINT
    // slot keys (different concept groups), so another branch's in-flight
    // writes are irrelevant to this one's accumulating-slot merges.
    const { rows: [freshSession] } = await branchClient.query(
      `SELECT slots_filled FROM aa_workflow_sessions WHERE id = $1`,
      [workflowSession.id]
    );
    const branchSlotsFilled = freshSession?.slots_filled || {};
    for (const item of utterances) {
      const result = await analyzeOneUtterance({
        connectionRef,
        pool,
        workflowSession,
        callControlId,
        assistConfig,
        llmModel,
        fallbackModel,
        reasoningEnabled,
        maxOutputTokens,
        confidenceThreshold,
        transcript: item.transcript,
        transcriptionId: item.transcriptionId,
        speaker: item.speaker,
        recentContext: item.recentContext,
        slotsFilled: branchSlotsFilled,
        slotsDelta: branchSlotsDelta,
        scopeItemIds,
        requestSignal,
      });
      branchClient = connectionRef.client;
      branchUpdates.push(...result.updates);
      if (!result.skipped) branchAnalysisResult = result.analysisResult;
    }
    if (Object.keys(branchSlotsDelta).length > 0) {
      await branchClient.query(
        `UPDATE aa_workflow_sessions
         SET slots_filled = COALESCE(slots_filled, '{}'::jsonb) || $1::jsonb,
                 slots_version = COALESCE(slots_version, 0) + 1,
                 updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(branchSlotsDelta), workflowSession.id]
      );
    }
    await branchClient.query("COMMIT");
    return { updates: branchUpdates, analysisResult: branchAnalysisResult, ok: true };
  } catch (error) {
    branchClient = connectionRef.client;
    try {
      if (branchClient) await branchClient.query("ROLLBACK");
    } catch {
      // Connection may already be broken — nothing more to do.
    }
    workflowLogger.error("workflow_concept_group_branch_failed", agentAssistRuntimePayload({
      error,
      sessionId: workflowSession.id,
      interactionId: workflowSession.work_item_id,
    }));
    return { updates: [], analysisResult: null, ok: false };
  } finally {
    if (branchClient) branchClient.release();
  }
}

// POST /api/agent-assist/workflow/analyze - Analyze transcript
async function POST_handler(request) {
  let client;
  let connectionRef;
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { sessionId, interactionId } = body;

    // Backward compatible: accept either a single {transcript, speaker,
    // recentContext} (the original shape) or a batch: [{transcript, speaker,
    // recentContext}, ...] array. A batch is processed in order within ONE
    // request/transaction — every utterance sees the previous one's slot
    // updates before its own analysis runs (see analyzeOneUtterance) — which
    // eliminates the N separate HTTP round trips a debounced multi-utterance
    // batch previously needed (one full request per utterance, chained
    // client-side) while still avoiding the stale-snapshot race a fully
    // concurrent Promise.all approach had.
    const batchInput = Array.isArray(body.batch) && body.batch.length > 0
      ? body.batch
      : (body.transcript ? [{ transcript: body.transcript, speaker: body.speaker, recentContext: body.recentContext }] : []);
    const validBatch = batchInput.filter((item) => item?.transcript?.trim());

    if (validBatch.length === 0) {
      return NextResponse.json(
        { error: "transcript is required" },
        { status: 400 }
      );
    }

    client = await pool.connect();
    await client.query("BEGIN");

    // Find session
    let workflowSession;
    if (sessionId) {
      const { rows: [s] } = await client.query(
        `SELECT * FROM aa_workflow_sessions WHERE id = $1 AND status = 'in_progress'`,
        [sessionId]
      );
      workflowSession = s;
    } else if (interactionId) {
      const { rows: [s] } = await client.query(
        `SELECT * FROM aa_workflow_sessions WHERE work_item_id::text = $1 AND status = 'in_progress'`,
        [interactionId]
      );
      workflowSession = s;
    }

    if (!workflowSession) {
      await client.query("ROLLBACK");
      workflowLogger.info("workflow_analysis_skipped", agentAssistRuntimePayload({
        sessionId,
        interactionId,
        reason: "no_active_workflow_session",
      }));
      return NextResponse.json({
        ok: true,
        message: "No active workflow session found",
        updates: [],
      });
    }

    let assistConfig = {};
    let callControlId = null;
    if (workflowSession.work_item_id) {
      const { rows: [interaction] } = await client.query(
        `SELECT metadata, call_control_id FROM acd_history_interactions WHERE id = $1`,
        [workflowSession.work_item_id]
      );
      assistConfig = interaction?.metadata?.agent_assist_config || {};
      callControlId = interaction?.call_control_id || interaction?.metadata?.call_control_id || null;
    }

    if (assistConfig.auto_detect_completion === false) {
      await client.query("ROLLBACK");
      workflowLogger.info("workflow_analysis_skipped", agentAssistRuntimePayload({
        sessionId: workflowSession.id,
        interactionId: workflowSession.work_item_id,
        workflowId: workflowSession.workflow_id,
        reason: "auto_detect_completion_disabled",
      }));
      return NextResponse.json({
        ok: true,
        message: "Auto-detect completion is disabled",
        updates: [],
      });
    }

    // Get workflow's LLM model and confidence threshold
    const { rows: [workflow] } = await client.query(
      `SELECT llm_model, llm_fallback_model, llm_confidence_threshold, llm_reasoning_enabled, llm_max_output_tokens FROM aa_workflows WHERE id = $1`,
      [workflowSession.workflow_id]
    );
    const llmModel = workflow?.llm_model || "openai/gpt-4o";
    const fallbackModel = workflow?.llm_fallback_model || "openai/gpt-5.6-luna";
    const reasoningEnabled = workflow?.llm_reasoning_enabled === true;
    const maxOutputTokens = Number.isInteger(workflow?.llm_max_output_tokens)
      ? workflow.llm_max_output_tokens
      : 1200;
    const confidenceThreshold = normalizeConfidenceThreshold(workflow?.llm_confidence_threshold);

    // Fetch the whole workflow's item list (every status) once, to compute
    // the static "concept group" partition used below to decide which
    // utterances in this batch can run concurrently — see
    // computeConceptGroups. Read-only, safe on the still-open outer
    // transaction regardless of which path (single-group vs. concurrent
    // multi-group) this batch ends up taking.
    const { rows: allWorkflowItemRows } = await client.query(
      `SELECT i.id as item_id, i.type, i.slot_name, i.label, i.prompt_hint, i.hints,
              s.name as stage_name, s.order_index as stage_order,
              i.order_index as item_order, ist.status as current_status
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON i.stage_id = s.id
         LEFT JOIN aa_workflow_item_status ist ON ist.item_id = i.id AND ist.session_id = $1
        WHERE s.workflow_id = $2
        ORDER BY s.order_index, i.order_index`,
      [workflowSession.id, workflowSession.workflow_id]
    );
    const { itemGroup, groupItemIds, groupHintTokens } = computeConceptGroups(allWorkflowItemRows);

    // Classify each utterance in the batch into a concept group (cheap
    // heuristic, no LLM call). An utterance with no clear lexical signal (a
    // bare/ambiguous fragment, e.g. just "412") inherits the PRECEDING
    // utterance's group — exactly the case that most needs to stay
    // sequential relative to its context. The very first ambiguous
    // utterance falls back to whichever group the earliest still-open item
    // across the WHOLE workflow belongs to, matching today's single-stream
    // behavior when the batch can't be confidently classified at all.
    const defaultOpenItemRow = allWorkflowItemRows.find(
      (r) => !r.current_status || r.current_status === "pending" || r.current_status === "suggested"
    );
    let inheritedGroupKey = defaultOpenItemRow ? itemGroup.get(defaultOpenItemRow.item_id) : null;
    const runsByGroup = new Map(); // groupKey -> utterance items, in original order
    const groupKeyOrder = []; // first-seen order; length 1 == common single-group case
    for (const item of validBatch) {
      const classifiedGroupKey = classifyUtteranceGroup(item.transcript, groupHintTokens);
      const groupKey = classifiedGroupKey || inheritedGroupKey || "unclassified";
      inheritedGroupKey = groupKey;
      if (!runsByGroup.has(groupKey)) {
        runsByGroup.set(groupKey, []);
        groupKeyOrder.push(groupKey);
      }
      runsByGroup.get(groupKey).push(item);
    }

    // slotsDelta accumulates ONLY the slots this whole request (batch)
    // changed, across every utterance in it, so the persist below can
    // jsonb-merge the delta instead of overwriting the whole object.
    // Overwriting is a lost-update race: when analyze is slow, two requests
    // overlap, each reads this snapshot, and the later write wipes the
    // earlier one's slots (e.g. a freshly captured `other_aircraft_responding:
    // false` vanishes, so the suggested response re-targets an already-filled
    // slot).
    let slotsFilled = workflowSession.slots_filled || {};
    const slotsDelta = {};
    let allUpdates = [];
    let lastAnalysisResult = null;

    // Finalization utterances must stay SEQUENTIAL relative to the rest of
    // the batch (Codex P1 on #1367). In a concurrent multi-group batch each
    // branch snapshots slots_filled before the others commit — so when the
    // LAST slot answer and the agent's read-back recitation drain together,
    // the recitation's branch still sees an unfilled slot, isReadBackStage
    // computes false, and the deterministic backstop can never fire. The
    // probe uses the PRE-batch slots (matchesAgentRecitation keys on
    // distinctive values, not completeness, so a recitation is recognizable
    // before the final boolean lands) plus the item hints for the customer
    // affirmative. Read-back happens once per call, so degrading that one
    // batch to the sequential path costs nothing measurable.
    const readBackItemRows = allWorkflowItemRows.filter(
      (r) =>
        (!r.current_status || r.current_status === "pending" || r.current_status === "suggested") &&
        isReadBackItem({ itemType: r.type, itemLabel: r.label, itemPromptHint: r.prompt_hint, itemHints: r.hints })
    );
    // The customer-affirmative probe only makes sense once every slot already
    // holds a value pre-batch — a bare "yes" mid-call must not keep degrading
    // batches to the sequential path (read-back items pend the whole call).
    // The agent-recitation probe needs no such gate: it keys on several
    // distinctive values landing in one utterance, which ordinary agent
    // speech does not do.
    const preBatchAllSlotsFilled = allWorkflowItemRows.every(
      (r) => r.type !== "slot" || !r.slot_name || hasMeaningfulExtractedValue(slotsFilled[r.slot_name])
    );
    const batchHasFinalizationUtterance =
      readBackItemRows.length > 0 &&
      validBatch.some((item) => {
        const speakerType = normalizeSpeakerType(item.speaker);
        if (speakerType === "agent") {
          return matchesAgentRecitation(item.transcript, slotsFilled);
        }
        if (speakerType === "customer" && preBatchAllSlotsFilled) {
          return readBackItemRows.some((row) =>
            matchesReadBackAffirmativeHints(item.transcript, { hints: row.hints })
          );
        }
        return false;
      });

    if (groupKeyOrder.length <= 1 || batchHasFinalizationUtterance) {
      connectionRef = { client };
      // Common case: every utterance in this batch classified into the SAME
      // concept group (or it's a single-utterance batch). Process exactly as
      // before — sequentially, sharing the outer client/transaction — no
      // branching overhead for the overwhelmingly common path.
      for (const item of validBatch) {
        const { transcript, speaker, recentContext, transcriptionId } = item;
        const result = await analyzeOneUtterance({
          connectionRef,
          pool,
          workflowSession,
          callControlId,
          assistConfig,
          llmModel,
          fallbackModel,
          reasoningEnabled,
          maxOutputTokens,
          confidenceThreshold,
          transcript,
          transcriptionId,
          speaker,
          recentContext,
          slotsFilled,
          slotsDelta,
          requestSignal: request.signal,
        });
        client = connectionRef.client;
        allUpdates.push(...result.updates);
        if (!result.skipped) lastAnalysisResult = result.analysisResult;
      }

      // Persist ONLY the slots the WHOLE BATCH changed, merged once into
      // whatever the row currently holds — never overwrite the whole object.
      // This is atomic at the DB level, so a concurrent analyze (a different
      // request entirely) that filled a DIFFERENT slot is preserved instead of
      // clobbered. Re-read the merged result so the response reflects the true
      // post-merge state (including a concurrent request's slots), not just
      // this request's local snapshot.
      if (Object.keys(slotsDelta).length > 0) {
        const { rows: [merged] } = await client.query(
          `UPDATE aa_workflow_sessions
           SET slots_filled = COALESCE(slots_filled, '{}'::jsonb) || $1::jsonb,
               slots_version = COALESCE(slots_version, 0) + 1,
               updated_at = NOW()
           WHERE id = $2
           RETURNING slots_filled`,
          [JSON.stringify(slotsDelta), workflowSession.id]
        );
        if (merged?.slots_filled && typeof merged.slots_filled === "object") {
          for (const key of Object.keys(slotsFilled)) delete slotsFilled[key];
          Object.assign(slotsFilled, merged.slots_filled);
        }
      } else {
        // No delta from this batch — the response still must not carry the
        // request-start snapshot. An agent's manual edit (complete route)
        // may have committed during the LLM window, and returning the stale
        // snapshot would tell the client an old value for the edited slot
        // (an earlier fix). Re-read so the response reflects the live row.
        const { rows: [fresh] } = await client.query(
          `SELECT slots_filled FROM aa_workflow_sessions WHERE id = $1`,
          [workflowSession.id]
        );
        if (fresh?.slots_filled && typeof fresh.slots_filled === "object") {
          for (const key of Object.keys(slotsFilled)) delete slotsFilled[key];
          Object.assign(slotsFilled, fresh.slots_filled);
        }
      }
    } else {
      // This batch's utterances span multiple, non-conflicting concept
      // groups (e.g. the tail end of a caller-identity burst overlapping the
      // start of a pickup-location burst in the same debounce window). Run
      // each group's own ordered run CONCURRENTLY, each in its own DB
      // connection/transaction (see runConceptGroupBranch) — Postgres can't
      // run two queries concurrently on one connection, so true concurrency
      // needs separate connections. The outer transaction has only done
      // reads so far, so commit it (cheap no-op) before handing off, then
      // reopen a fresh one for the shared final steps below once every
      // branch has committed its own work.
      await client.query("COMMIT");
      client.release();
      client = null;
      const branchResults = await allSettledWithConcurrency(
        groupKeyOrder,
        MAX_CONCURRENT_CONCEPT_GROUPS,
        (groupKey) => runConceptGroupBranch({
            pool,
            workflowSession,
            callControlId,
            assistConfig,
            llmModel,
            fallbackModel,
            reasoningEnabled,
            maxOutputTokens,
            confidenceThreshold,
            utterances: runsByGroup.get(groupKey),
            scopeItemIds: groupItemIds.get(groupKey) || new Set(),
            requestSignal: request.signal,
          }),
      );
      for (const settled of branchResults) {
        if (settled.status === "fulfilled" && settled.value.ok) {
          allUpdates.push(...settled.value.updates);
          if (settled.value.analysisResult) lastAnalysisResult = settled.value.analysisResult;
        }
      }
      workflowLogger.info("workflow_concept_groups_batched_concurrently", agentAssistRuntimePayload({
        sessionId: workflowSession.id,
        interactionId: workflowSession.work_item_id,
        groupCount: groupKeyOrder.length,
        batchSize: validBatch.length,
      }));

      client = await pool.connect();
      await client.query("BEGIN");
      const { rows: [freshSession] } = await client.query(
        `SELECT slots_filled FROM aa_workflow_sessions WHERE id = $1`,
        [workflowSession.id]
      );
      for (const key of Object.keys(slotsFilled)) delete slotsFilled[key];
      Object.assign(slotsFilled, freshSession?.slots_filled || {});
    }

    // Deterministic name reconciliation. Per-utterance analysis with the
    // "current focus" tie-breaker can drop a lone surname into a `*_first_name`
    // slot (e.g. the agent asks "first name?" and STT yields the family name),
    // leaving first === last (both "Thompson"). Equal first/last is virtually
    // never a real person, so clear the first-name slot and reset its status so
    // the agent re-asks for the given name. Only the unambiguous duplicate case
    // is auto-corrected: a full name mis-dumped into one slot is left to the
    // prompt, because "Mary Jo" is a valid two-word first name that must not be
    // split. Runs AFTER the merge on the freshest state, and each clear is a
    // SINGLE atomic UPDATE guarded on the LIVE DB still showing first === last —
    // so a concurrent request that just captured the correct first name is never
    // wiped (the guard fails and we skip). Self-heals a duplicate created on an
    // earlier utterance since it scans the whole slot set.
    for (const key of Object.keys(slotsFilled)) {
      if (!key.endsWith("_first_name")) continue;
      const lastKey = `${key.slice(0, -"_first_name".length)}_last_name`;
      const norm = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
      if (!(norm(slotsFilled[key]) && norm(slotsFilled[key]) === norm(slotsFilled[lastKey]))) continue;
      // A shared no-info sentinel ("N/A"/"unknown") in both slots is a valid
      // "caller doesn't know the name", not a duplicate surname — leave it.
      if (NAME_DUP_SENTINELS.has(norm(slotsFilled[key]))) continue;

      // Atomic + conditional: only drop the first-name key if the DB STILL shows
      // it equal to the last name. If a concurrent analyze corrected it, the
      // WHERE matches nothing and we leave the fresh value alone.
      const { rows: clearedSession } = await client.query(
        `UPDATE aa_workflow_sessions
            SET slots_filled = slots_filled - $2,
                slots_version = COALESCE(slots_version, 0) + 1,
                updated_at = NOW()
          WHERE id = $1
            AND (slots_filled->>$2) IS NOT NULL
            AND lower(btrim(slots_filled->>$2)) = lower(btrim(slots_filled->>$3))
          RETURNING id`,
        [workflowSession.id, key, lastKey]
      );
      if (clearedSession.length === 0) continue; // concurrent correction won

      slotsFilled[key] = null; // response carries null -> client merges -> re-asks
      // is_manual_edit reset too (Codex review, P2): this reopens the slot
      // for re-collection from scratch — the NEXT value could come from
      // anywhere (speech, prefill, another manual edit). Leaving a stale
      // TRUE here would wrongly protect whatever gets captured next from
      // ever being corrected, even if it's a plain spoken value.
      const { rows: cleared } = await client.query(
        `UPDATE aa_workflow_item_status ist
            SET status = 'pending', extracted_value = NULL, completed_at = NULL,
                confidence_score = NULL, source_transcript = NULL,
                alternatives = NULL, completed_by = NULL, is_manual_edit = FALSE, updated_at = NOW()
           FROM aa_workflow_items i
          WHERE ist.item_id = i.id AND ist.session_id = $1 AND i.slot_name = $2
          RETURNING ist.item_id`,
        [workflowSession.id, key]
      );
      for (const row of cleared) {
        allUpdates.push({
          item_id: row.item_id,
          status: "pending",
          extracted_value: null,
          cleared_reason: "name_first_equals_last",
        });
      }
    }

    // Codex review (PR #1387, P1/P2): a completion synthesized by the Sixth
    // guard (pickup_facility <- caller_facility, marked derived_from_slot =
    // 'caller_facility') has no relationship to its source recorded outside
    // this marker. Left alone, a later correction to EITHER premise -
    // caller_facility itself, or pickup_same_as_requesting_facility
    // flipping back to false - would leave the stale copied facility name
    // sitting there indistinguishable from a real spoken value, silently
    // feeding MCP lookup and dispatch. Shared with the manual item-complete
    // and slot-update routes (see derived-slot-reconciliation.mjs) — those
    // are the OTHER two paths that can change either premise by hand and
    // must reconcile atomically with their own write, not just this one.
    // Runs on the final merged slotsFilled, same as the name-dedup pass
    // above, so it sees every branch's writes.
    {
      const { updates: derivedUpdates } = await reconcileDerivedSlots({ client, sessionId: workflowSession.id });
      for (const update of derivedUpdates) {
        if (update.status === "pending") {
          delete slotsFilled[update.slot_name];
        } else {
          slotsFilled[update.slot_name] = update.extracted_value;
        }
        allUpdates.push(update);
      }
    }

    // Recalculate completion percentage
    const { rows: [stats] } = await client.query(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed
       FROM aa_workflow_item_status
       WHERE session_id = $1`,
      [workflowSession.id]
    );

    const completionPercentage = stats.total > 0
      ? Math.round((stats.completed / stats.total) * 100)
      : 0;

    await client.query(
      `UPDATE aa_workflow_sessions
       SET completion_percentage = $1, updated_at = NOW()
       WHERE id = $2`,
      [completionPercentage, workflowSession.id]
    );

    // Check if workflow is complete
    if (completionPercentage === 100) {
      await client.query(
        `UPDATE aa_workflow_sessions
         SET status = 'completed', completed_at = NOW()
         WHERE id = $1`,
        [workflowSession.id]
      );
    }

    await client.query("COMMIT");

    // Per-slot MCP bindings run only after the transaction commits: a remote
    // tool round trip is far slower than the SQL above and must not hold row
    // locks. Enrichment is best-effort - a tool outage degrades the assist, it
    // does not fail the analyze pass.
    let mcpInvocations = [];
    let mcpCompletionPercentage = null;
    // Distinguishes a post-MCP read of the whole document from this route's own
    // pre-MCP snapshot. The store MERGES by default to survive out-of-order
    // analyze responses; it may only REPLACE when the map is authoritative,
    // because an ambiguous MCP rerun removes slots and a merge resurrects them.
    let slotsFilledAuthoritative = false;
    try {
      const bindingRun = await runAndPersistSlotMcpBindings({
        sessionId: workflowSession.id,
        workflowId: workflowSession.workflow_id,
        interactionId: workflowSession.work_item_id,
      });
      mcpInvocations = bindingRun.invocations;
      // Take the authoritative slot map rather than merging into this pre-MCP
      // snapshot: an ambiguous rerun REMOVES slots, and a merge would keep
      // returning values the session no longer holds.
      if (bindingRun.slotsFilled) {
        slotsFilled = bindingRun.slotsFilled;
        slotsFilledAuthoritative = true;
      }
      // Derived items ride the normal updates channel so the checklist ticks
      // immediately instead of waiting for the next session refetch.
      if (bindingRun.itemUpdates.length > 0) allUpdates.push(...bindingRun.itemUpdates);
      if (typeof bindingRun.completionPercentage === "number") {
        mcpCompletionPercentage = bindingRun.completionPercentage;
      }
    } catch (mcpErr) {
      workflowLogger.error("slot_mcp_bindings_failed", agentAssistRuntimePayload({
        sessionId: workflowSession.id,
        interactionId: workflowSession.work_item_id,
        workflowId: workflowSession.workflow_id,
        reason: mcpErr?.message || "binding run failed",
      }));
    }

    workflowLogger.info("workflow_analysis_completed", agentAssistRuntimePayload({
      sessionId: workflowSession.id,
      interactionId: workflowSession.work_item_id,
      workflowId: workflowSession.workflow_id,
      callControlId,
      updates: allUpdates.length,
      completionPercentage,
      batchSize: validBatch.length,
      confidenceThreshold,
      model: llmModel,
      fallbackModel,
      reasoningEnabled,
      maxOutputTokens,
    }));

    return NextResponse.json({
      ok: true,
      updates: allUpdates,
      slotsFilled,
      completionPercentage: mcpCompletionPercentage ?? completionPercentage,
      mcpInvocations,
      slotsFilledAuthoritative,
    });
  } catch (error) {
    if (connectionRef) client = connectionRef.client;
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Connection may already be broken — nothing more to do.
      }
    }
    workflowLogger.error("agent_assist_workflow", agentAssistRuntimePayload({ error }));
    return NextResponse.json(
      { error: error.message || "Failed to analyze transcript" },
      { status: 500 }
    );
  } finally {
    if (client) client.release();
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("agent:self", POST_handler, { route: "/api/agent-assist/workflow/analyze" });
