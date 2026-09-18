import { mentionsCorrectionTrigger, isReadBackItem } from "./readback.mjs";

const STOP_WORDS = new Set([
  "the", "and", "for", "you", "your", "that", "this", "with", "from", "have", "has",
  "can", "could", "would", "should", "what", "when", "where", "how", "why", "who",
  "ask", "tell", "please", "customer", "agent", "item", "stage", "full", "details",
]);

const CONFIRMATION_TERMS = new Set([
  "confirm", "confirmed", "verify", "verified", "validate", "validated", "review", "summarize", "summary",
]);

// Closing/finalization steps: read-back, confirm-all, provide reference number,
// submit, thank & close. Superset of the confirmation terms plus closing verbs.
// Used to decide when a low-confidence slot must be confirmed before the agent
// is nudged to finish the call.
const FINALIZATION_TERMS = new Set([
  ...CONFIRMATION_TERMS,
  "confirmation", "recap", "readback",
  "close", "closing", "submit", "submitted", "finalize", "finalized",
  "dispatch", "complete", "completed", "thank", "thanks", "goodbye", "reference", "wrapup",
]);

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function tokenize(value) {
  return normalizeText(value)
    .replace(/[_-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function uniqueTokens(value) {
  return [...new Set(tokenize(value))];
}

function itemText(item) {
  return [
    item?.label,
    item?.description,
    item?.prompt_hint,
    item?.slot_name,
    ...(Array.isArray(item?.hints) ? item.hints : []),
    ...(Array.isArray(item?.slot_options) ? item.slot_options : []),
  ].filter(Boolean).join(" ");
}

function stageText(stage) {
  return [stage?.name, stage?.description, ...(stage?.items || []).map(itemText)].filter(Boolean).join(" ");
}

function hasMeaningfulValue(value) {
  return value !== undefined && value !== null && value !== "";
}

export function isWorkflowItemSatisfied(item, itemStatuses = {}, slotsFilled = {}) {
  const status = itemStatuses[item?.id];
  if (status?.status === "completed" || status?.status === "skipped") return true;
  if (item?.type === "slot" && item.slot_name) {
    if (hasMeaningfulValue(slotsFilled[item.slot_name])) return true;
    if (status?.status === "completed" && hasMeaningfulValue(status?.extracted_value)) return true;
  }
  return false;
}

function needsSlotConfirmation(item, itemStatuses = {}) {
  const status = itemStatuses[item?.id];
  // A correction candidate (see analyze/route.js) is deliberately excluded:
  // its pending value is instead folded into the read-back summary (see
  // mergeReadBackSlots in AgentAssistWorkflow.jsx) and confirmed all at once
  // when the customer gives the final read-back affirmative — not through a
  // separate "I captured X, please confirm" exchange per corrected slot.
  return (
    item?.type === "slot" &&
    status?.status === "suggested" &&
    hasMeaningfulValue(status?.extracted_value) &&
    !status?.is_correction
  );
}

// Only SLOT items are closed by having a captured value. Non-slot items
// (action/question/topic) can be persisted as status "suggested" with an
// extracted_value too, but needsSlotConfirmation only ever resurfaces slots —
// so treating a non-slot as closed here would skip it forever. Non-slot items
// stay open until they are completed or skipped.
function itemHasCapturedValue(item, itemStatuses = {}, slotsFilled = {}) {
  if (item?.type !== "slot") return false;
  const status = itemStatuses[item?.id];
  if (item.slot_name && hasMeaningfulValue(slotsFilled[item.slot_name])) {
    return true;
  }
  return hasMeaningfulValue(status?.extracted_value);
}

// "Open" = the item still needs its value collected. A slot that already has a
// captured value counts as closed even when its status is only "suggested"
// (AI-filled below the confidence threshold), so the suggested response advances
// to the next empty item instead of re-asking for one that is already filled.
// Confirming low-confidence suggestions is surfaced separately, after collection.
function itemIsOpen(item, itemStatuses = {}, slotsFilled = {}) {
  if (isWorkflowItemSatisfied(item, itemStatuses, slotsFilled)) return false;
  if (itemHasCapturedValue(item, itemStatuses, slotsFilled)) return false;
  return true;
}

function isConfirmationItem(item) {
  const tokens = uniqueTokens([item?.label, item?.prompt_hint, item?.description].filter(Boolean).join(" "));
  return tokens.some((token) => CONFIRMATION_TERMS.has(token));
}

function scoreTextAgainstConversation(searchText, conversationText) {
  const haystack = normalizeText(conversationText).replace(/[_-]/g, " ");
  const tokens = uniqueTokens(searchText);
  if (tokens.length === 0 || !haystack) return 0;

  return tokens.reduce((score, token) => {
    if (!haystack.includes(token)) return score;
    if (CONFIRMATION_TERMS.has(token)) return score + 1.5;
    return score + 1;
  }, 0);
}

function latestConversationText(transcriptions = []) {
  return (transcriptions || [])
    .filter((t) => t?.isFinal !== false && t?.transcript)
    .slice(-8)
    .map((t) => t.transcript)
    .join(" \n");
}

function sortedStages(stages = []) {
  return [...(stages || [])].sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
}

function sortedItems(stage) {
  return [...(stage?.items || [])].sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
}

// A non-slot item (greeting, "how can I help", "confirm intent understood")
// whose own completion detection can be unreliable (see the "Non-slot items
// ... intentionally non-blocking" comment on the leadSlot clamp below) is
// treated as effectively resolved once something LATER in the SAME stage
// already shows real progress (a captured value, or completed) — strong
// evidence the conversation already moved past it even though its own
// status update never landed. `items` is always the FULL sorted stage item
// list (not a truncated slice) so "later progress" is judged consistently
// regardless of which item is currently being tested.
//
// Reported live: a single combined agent utterance ("Thanks for calling...
// how can I help you today?") only completed the adjacent "Greet caller"
// item, leaving "Ask how to assist today" stuck pending. The very next turn
// (customer stating their intent, captured into the Call Intent slot — a
// LATER item in the same stage) kept re-suggesting "How can I help you?"
// verbatim instead of advancing to "Confirm intent understood", since
// nothing here previously accounted for a stuck EARLIER non-slot item once
// a LATER item in the same stage had already progressed.
function isEffectivelyOpen(item, index, items, itemStatuses, slotsFilled) {
  if (!itemIsOpen(item, itemStatuses, slotsFilled)) return false;
  if (item.type === "slot") return true;
  const hasLaterProgress = items
    .slice(index + 1)
    .some((later) => !itemIsOpen(later, itemStatuses, slotsFilled));
  return !hasLaterProgress;
}

function firstOpenItemInStage(stage, itemStatuses, slotsFilled) {
  const items = sortedItems(stage);
  return items.find((item, index) => isEffectivelyOpen(item, index, items, itemStatuses, slotsFilled)) || null;
}

/**
 * Is `item` still effectively open within its own stage — i.e. should a
 * suggested-response CARD for it still be shown? Exported for the UI's own
 * suggestion-list cleanup (AgentAssistWorkflow.jsx): the accumulating
 * suggestions list only drops a card once its item's status flips to
 * literal "completed", but a non-slot item stuck at "suggested" (or with no
 * status at all) never gets that flip if its own completion detection never
 * lands — so its card lingers in the panel even after the conversation has
 * genuinely moved on (reported live: "How can I help you today?" stayed
 * shown after the caller had already stated their intent). Mirrors
 * isEffectivelyOpen's same-stage "later progress" check used by the target
 * resolver above; deliberately a no-op for slot items (`isEffectivelyOpen`
 * returns `itemIsOpen` unchanged for slots), since a low-confidence SLOT
 * suggestion must keep accumulating in the panel until explicitly confirmed.
 */
export function isItemStillRelevantInStage(item, stage, itemStatuses = {}, slotsFilled = {}) {
  // Slots: leave untouched. itemIsOpen (and therefore isEffectivelyOpen)
  // already treats an unconfirmed "suggested" slot as "not open" — correct
  // for deciding what to COLLECT next, but wrong here: a low-confidence slot
  // suggestion card must keep accumulating in the panel until the agent
  // explicitly confirms it, not disappear the moment a value is captured.
  // The caller's own literal `status === "completed"` check already handles
  // removing a slot's card when it's genuinely done.
  if (item?.type === "slot") return true;
  const items = sortedItems(stage);
  const index = items.findIndex((candidate) => candidate.id === item?.id);
  if (index === -1) return true;
  return isEffectivelyOpen(items[index], index, items, itemStatuses, slotsFilled);
}

// minStageOrder skips stages STRICTLY before it — used to stop this fallback
// from resurfacing a non-slot item (e.g. an opening greeting) that never got
// marked complete, once the conversation has already moved past that stage.
// The main conversation-matching loop above deliberately leaves non-slot
// items non-blocking (their completion detection can be unreliable), but that
// same leniency must not let this fallback re-suggest a stale opening item
// after the call has progressed through several later stages via slots alone.
function firstOpenWorkflowItem(stages, itemStatuses, slotsFilled, minStageOrder = null) {
  for (const stage of sortedStages(stages)) {
    if (minStageOrder !== null && (stage?.order_index ?? 0) < minStageOrder) continue;
    const item = firstOpenItemInStage(stage, itemStatuses, slotsFilled);
    if (item) return { stage, item };
  }
  return null;
}

function firstMissingPrerequisite(stage, blockedItem, itemStatuses, slotsFilled) {
  const items = sortedItems(stage);
  const blockedIndex = items.findIndex((item) => item.id === blockedItem?.id);
  if (blockedIndex <= 0) return null;

  // isEffectivelyOpen (not the raw itemIsOpen) so a stuck, superseded earlier
  // non-slot item (e.g. "Ask how to assist today" after the caller already
  // stated their intent) is not reported as a missing prerequisite for a
  // later confirmation item — see isEffectivelyOpen's comment above.
  for (let i = 0; i < blockedIndex; i++) {
    if (isEffectivelyOpen(items[i], i, items, itemStatuses, slotsFilled)) return items[i];
  }
  return null;
}

function firstOpenSlot(stages, itemStatuses, slotsFilled) {
  for (const stage of sortedStages(stages)) {
    const item = sortedItems(stage).find(
      (it) => it?.type === "slot" && itemIsOpen(it, itemStatuses, slotsFilled),
    );
    if (item) return { stage, item };
  }
  return null;
}

// True once at least one slot ANYWHERE has a captured value. Distinguishes
// real conversational progress from the earliest-open-slot simply living in a
// later stage because earlier stages have no slots at all (e.g. an opening
// "Greeting" stage with only action/question items) — the latter must NOT be
// treated as "the conversation moved past stage 0".
function hasAnyCollectedSlot(stages, itemStatuses, slotsFilled) {
  return sortedStages(stages).some((stage) =>
    sortedItems(stage).some(
      (item) => item?.type === "slot" && itemHasCapturedValue(item, itemStatuses, slotsFilled),
    ),
  );
}

// The furthest (highest order_index) stage that has any filled slot. Unlike
// leadStageOrder (earliest OPEN slot, which goes null once every slot has a
// value), this stays put once real progress has happened — used as the
// progress floor for the end-of-call case, see callers below.
function furthestFilledSlotStageOrder(stages, itemStatuses, slotsFilled) {
  let max = null;
  for (const stage of sortedStages(stages)) {
    const hasFilledSlot = sortedItems(stage).some(
      (item) => item?.type === "slot" && itemHasCapturedValue(item, itemStatuses, slotsFilled),
    );
    if (hasFilledSlot) max = stage?.order_index ?? 0;
  }
  return max;
}

function firstSuggestedSlot(stages, itemStatuses) {
  for (const stage of sortedStages(stages)) {
    const item = sortedItems(stage).find((it) => needsSlotConfirmation(it, itemStatuses));
    if (item) return { stage, item };
  }
  return null;
}

// The (stageOrder, itemOrder) position of the last SLOT in the workflow, or null
// if there are no slots.
function lastSlotPosition(stages) {
  let last = null;
  for (const stage of sortedStages(stages)) {
    for (const item of sortedItems(stage)) {
      if (item?.type === "slot") {
        last = { stageOrder: stage?.order_index ?? 0, itemOrder: item?.order_index ?? 0 };
      }
    }
  }
  return last;
}

function matchesFinalizationKeyword(item) {
  const tokens = uniqueTokens([item?.label, item?.prompt_hint, item?.description].filter(Boolean).join(" "));
  return tokens.some((token) => FINALIZATION_TERMS.has(token));
}

// A "finalization" item is a NON-slot closing step: read-back / confirm / submit
// / thank & close. It must satisfy BOTH signals — a closing keyword AND a
// position after the last slot. Neither alone is enough:
//  - keyword-only mis-flags opening items ("Thank the customer for calling",
//    "Request permission to verify account"), which sit before the slots;
//  - position-only mis-flags normal mid-flow follow-ups after the last slot
//    (clarifying questions, resolution actions) that carry no closing keyword.
// Requiring both keeps opening items and mid-flow work running normally, even
// when an AI handoff pre-filled every slot, while still confirming a suggested
// slot before the true closing steps.
function isFinalizationItem(stage, item, stages) {
  if (!item || item.type === "slot") return false;
  if (!matchesFinalizationKeyword(item)) return false;
  const last = lastSlotPosition(stages);
  if (!last) return false;
  const so = stage?.order_index ?? 0;
  const io = item?.order_index ?? 0;
  return so > last.stageOrder || (so === last.stageOrder && io > last.itemOrder);
}

// Before suggesting a finalization item (read-back / submit / close), make sure
// no low-confidence slot is still awaiting confirmation. This fires only once
// every slot already has a value, so opening items and in-order slot collection
// are unaffected.
function pendingConfirmationBeforeFinalize(stages, itemStatuses, slotsFilled) {
  if (firstOpenSlot(stages, itemStatuses, slotsFilled)) return null;
  return firstSuggestedSlot(stages, itemStatuses);
}

function conversationStageMatches(stages, conversationText) {
  const matches = [];

  for (const stage of sortedStages(stages)) {
    const items = sortedItems(stage);
    const itemScores = items.map((item) => ({ item, score: scoreTextAgainstConversation(itemText(item), conversationText) }));
    const bestItem = itemScores.reduce((current, candidate) => candidate.score > current.score ? candidate : current, { item: null, score: 0 });
    const stageNameScore = scoreTextAgainstConversation([stage?.name, stage?.description].filter(Boolean).join(" "), conversationText);
    const score = bestItem.score + stageNameScore;

    if (score >= 2) matches.push({ stage, matchedItem: bestItem.item, score, itemScore: bestItem.score });
  }

  return matches.sort((a, b) => b.score - a.score || (a.stage?.order_index ?? 0) - (b.stage?.order_index ?? 0));
}

// Has the read-back/"confirm all information" item already been given the
// customer's final affirmative? Used to stop offering corrections once the
// review phase is over — see findCorrectionTargetSlot below.
//
// Some workflows split finalization into two items: an agent-completed
// "Read back transport details" ACTION, then a customer-facing "Confirm all
// information is correct" QUESTION. Both match isReadBackItem (it keys off
// "read back" phrasing too), but only the latter is the actual sign-off —
// the agent's own recitation completing (auto-detected from the AGENT'S
// utterance, or an "either"-trigger item completed from the agent's turn)
// must not be read as the caller having confirmed anything.
//
// Keys on completed_by === "customer" specifically. completed_by === "agent"
// is deliberately NOT accepted here even though it can also represent a
// genuine manual sign-off (an agent explicitly clicking "complete" via
// item/[id]/complete/route.js): that value is indistinguishable from the
// LLM auto-detecting completion from the AGENT'S OWN utterance (e.g. an
// "either"-trigger confirm-all item completed while the agent is talking,
// not the customer) — both write completed_by: "agent" today, and there is
// no reliable additional signal (item.type doesn't help: the confirm-all
// QUESTION item is exactly where both cases collide) to tell them apart
// without further plumbing. Erring toward NOT treating agent completions as
// sign-off avoids reintroducing the original recitation-blocks-corrections
// bug; the known cost is that a genuine manual agent completion doesn't
// unblock the reference/closing step on its own.
function readBackAlreadyConfirmed(stages, itemStatuses) {
  return sortedStages(stages).some((stage) =>
    sortedItems(stage).some((item) => {
      if (itemStatuses[item?.id]?.completed_by !== "customer") return false;
      if (!isReadBackItem({
        itemType: item?.type,
        itemLabel: item?.label,
        itemPromptHint: item?.prompt_hint,
        itemHints: item?.hints,
      })) return false;
      return itemStatuses[item?.id]?.status === "completed";
    }),
  );
}

// Once collection is done (every slot has a value), a caller can flag that an
// already-completed slot needs correcting ("pickup facility name needs to be
// Saint Mary Hospital"). The analyze pipeline can capture the new value
// (see the read-back correction handling in analyze/route.js), but on its own
// the suggestion side has no way to ask "what should the corrected value be?"
// for a slot it never targets once completed — it falls back to the generic
// read-back/confirm-all item instead. This finds the best-matching completed
// slot to target directly, gated on an explicit correction-trigger phrase
// being present in the conversation so a slot's value being merely mentioned
// again doesn't hijack the suggestion.
function findCorrectionTargetSlot(stages, itemStatuses, slotsFilled, conversationText) {
  if (!mentionsCorrectionTrigger(conversationText)) return null;

  let best = null;
  for (const stage of sortedStages(stages)) {
    for (const item of sortedItems(stage)) {
      if (item?.type !== "slot") continue;
      if (!itemHasCapturedValue(item, itemStatuses, slotsFilled)) continue;
      const score = scoreTextAgainstConversation(itemText(item), conversationText);
      if (score >= 2 && (!best || score > best.score)) {
        best = { stage, item, score };
      }
    }
  }
  return best;
}

function buildConversationContext({ reason, mode, stage, item, blockedItem, matchedItem, score }) {
  return {
    reason,
    mode,
    activeStageId: stage?.id || null,
    activeStageName: stage?.name || null,
    targetItemId: item?.id || null,
    targetItemLabel: item?.label || null,
    targetSlotName: item?.slot_name || null,
    matchedItemId: matchedItem?.id || null,
    matchedItemLabel: matchedItem?.label || null,
    blockedItemId: blockedItem?.id || null,
    blockedItemLabel: blockedItem?.label || null,
    matchScore: score || 0,
  };
}

function result({ stage, item, mode, reason, blockedItem = null, matchedItem = null, score = 0, itemStatus = null }) {
  if (!stage || !item) return null;
  return {
    stage,
    item,
    itemStatus,
    mode,
    targetMode: mode,
    reason,
    blockedItem,
    matchedItem,
    conversationContext: buildConversationContext({ reason, mode, stage, item, blockedItem, matchedItem, score }),
  };
}

export function resolveSuggestedResponseTarget({
  stages = [],
  itemStatuses = {},
  slotsFilled = {},
  transcriptions = [],
} = {}) {
  if (!Array.isArray(stages) || stages.length === 0) return null;

  const conversationText = latestConversationText(transcriptions);
  const matchedStages = conversationStageMatches(stages, conversationText);
  // Distinguishes "a real call is underway, this turn just didn't happen to
  // match anything strongly" from "nothing has been said yet at all" (a fresh
  // AI-handoff prefill, before the agent/customer have spoken) — see the
  // fallback's progressStageFloor below for why this matters.
  const hasAnyConversation = conversationText.length > 0;

  // Sequential leading: the agent should ask the workflow in order, even when
  // the caller volunteers information for a later stage. `leadSlot` is the
  // earliest stage that still holds an uncollected slot; we never follow the
  // conversation into a stage AFTER it (that would skip an open earlier stage,
  // e.g. jumping to Destination before Pickup was asked). A filled slot is not
  // "open", so leadSlot advances as slots are collected — this preserves
  // advance-past-filled (#1117). When leadSlot is null (every slot has a value)
  // the clamp is inert and finalization/confirmation logic runs unchanged.
  //
  // The clamp is keyed on the earliest open SLOT, deliberately NOT the earliest
  // open item (firstOpenWorkflowItem). The required data to collect lives in
  // slots; those must be asked in order. Non-slot items (greeting, "confirm
  // intent understood", topics) are intentionally non-blocking here: their
  // completion is detected heuristically and can be unreliable, so clamping on
  // them would let one undetectable non-slot item hard-stall the whole workflow
  // (never reaching any later slot). Letting the conversation move past a stuck
  // non-slot item is the desired escape valve.
  const leadSlot = firstOpenSlot(stages, itemStatuses, slotsFilled);
  const leadStageOrder = leadSlot ? leadSlot.stage?.order_index ?? 0 : null;

  // Once every slot is filled, a caller can flag that an already-completed
  // slot needs correcting. Check this BEFORE the conversation-stage-match loop
  // below (which only ever considers OPEN items) so an explicit correction
  // request targets that specific slot directly, instead of falling through
  // to whatever the read-back/confirm-all item's own suggestion says.
  //
  // Gated on the read-back item NOT already being confirmed: a correction
  // trigger phrase ("that's not correct") can still sit inside the rolling
  // conversation window for several turns after the caller has ALREADY moved
  // on and given the final "yes, all information is correct." Without this
  // gate, findCorrectionTargetSlot only checks itemHasCapturedValue (true for
  // ANY completed slot, correction or not) and can keep re-matching an
  // already-resolved slot (e.g. patient DOB) turn after turn — permanently
  // stuck there and never reaching "Provide confirmation/reference number",
  // because the SAME stuck target also gets silently discarded downstream
  // (its item is genuinely "completed", so the client's stale-response guard
  // drops the generated suggestion) with nothing else ever getting a chance
  // to be shown.
  if (leadStageOrder === null && !readBackAlreadyConfirmed(stages, itemStatuses)) {
    const correctionTarget = findCorrectionTargetSlot(stages, itemStatuses, slotsFilled, conversationText);
    if (correctionTarget) {
      return result({
        stage: correctionTarget.stage,
        item: correctionTarget.item,
        mode: "collect_correction",
        reason: "correction_requested",
        score: correctionTarget.score,
        itemStatus: itemStatuses[correctionTarget.item.id] || null,
      });
    }
  }

  // The caller has volunteered info for a stage AFTER the earliest open slot
  // when any matched stage sits past leadStageOrder. Once that happens, a
  // (possibly stale) match for an EARLIER non-slot stage — e.g. an old
  // "hello/welcome" still inside the transcript window while a greeting item
  // stays open — must not preempt collecting that slot. We record it here and
  // (a) ignore earlier-stage matches below, then (b) collect the lead slot
  // directly after the loop instead of letting the fallback resurface the
  // earlier open non-slot item.
  const jumpedAhead =
    leadStageOrder !== null &&
    matchedStages.some((m) => (m.stage?.order_index ?? 0) > leadStageOrder);

  // Once every slot has a value, leadStageOrder goes null and the two guards
  // above go fully inert (by design, so confirmation/finalization logic can
  // run) — but that also removes ALL protection against a stuck, never-
  // completed non-slot item (e.g. an opening greeting) winning a
  // conversation-stage match. Near call wrap-up, common closing language
  // ("thank you", "you're welcome", "is there anything else I can help
  // with") shares literal keywords with a greeting's own hint text, so it can
  // spuriously re-match — and unlike the jumpedAhead guard, this doesn't
  // require the SAME utterance to also match a later stage, so it would
  // otherwise slip through undetected. Once real progress has happened
  // (leadStageOrder null), floor matches at the furthest stage that has a
  // filled slot instead.
  const progressStageOrder =
    leadStageOrder === null ? furthestFilledSlotStageOrder(stages, itemStatuses, slotsFilled) : null;

  for (const matchedStage of matchedStages) {
    const { stage, matchedItem, score } = matchedStage;

    if (leadStageOrder !== null && (stage?.order_index ?? 0) > leadStageOrder) {
      // The caller jumped ahead to a later stage; keep leading in sequence by
      // deferring to the earliest open slot (handled after the loop).
      continue;
    }

    // Stale earlier-stage match: a stage strictly before leadStageOrder must
    // not preempt the earliest open slot once real progress has happened
    // (mirrors the leadStageOrder-null case below, for mid-call). Two ways to
    // detect that: the SAME utterance also matched a later stage (jumpedAhead),
    // OR any slot anywhere already has a value (hasAnyCollectedSlot) — the
    // latter catches a never-completed early item (e.g. a stuck greeting)
    // spuriously re-matching on its OWN turn, with nothing else matching, well
    // after the call has moved past it (reported live: "Hi, thanks for
    // calling..." resurfacing mid-way through Pickup Location questions).
    // Note this comparison is always false when leadStageOrder is null (`x <
    // null` is false in JS) — that end-of-call case is handled separately by
    // progressStageOrder below.
    if (
      (jumpedAhead || hasAnyCollectedSlot(stages, itemStatuses, slotsFilled)) &&
      (stage?.order_index ?? 0) < leadStageOrder
    ) {
      continue;
    }

    if (progressStageOrder !== null && (stage?.order_index ?? 0) < progressStageOrder) {
      // End-of-call case: every slot is filled, so leadStageOrder can't guard
      // this anymore. Don't let a stale earlier-stage item preempt the real
      // progress already made.
      continue;
    }

    const confirmationCandidate = isConfirmationItem(matchedItem) ? matchedItem : null;
    if (confirmationCandidate) {
      const missingPrerequisite = firstMissingPrerequisite(stage, confirmationCandidate, itemStatuses, slotsFilled);
      if (missingPrerequisite) {
        return result({
          stage,
          item: missingPrerequisite,
          mode: "collect_prerequisite",
          reason: "prerequisite_required",
          blockedItem: confirmationCandidate,
          matchedItem,
          score,
          itemStatus: itemStatuses[missingPrerequisite.id] || null,
        });
      }
    }

    // 1) Advance to the next item that still needs a value collected. This takes
    //    priority over confirming an already-filled (low-confidence) slot, so the
    //    suggested response moves on as soon as a value is captured.
    const openItem = firstOpenItemInStage(stage, itemStatuses, slotsFilled);
    if (openItem) {
      if (isConfirmationItem(openItem)) {
        const missingPrerequisite = firstMissingPrerequisite(stage, openItem, itemStatuses, slotsFilled);
        if (missingPrerequisite) {
          return result({
            stage,
            item: missingPrerequisite,
            mode: "collect_prerequisite",
            reason: "prerequisite_required",
            blockedItem: openItem,
            matchedItem,
            score,
            itemStatus: itemStatuses[missingPrerequisite.id] || null,
          });
        }
      }

      // If the next open item is a finalization action (read-back / submit /
      // close) but a captured slot is still an unconfirmed low-confidence
      // suggestion, confirm that slot first. Restricted to finalization items so
      // an opening greeting/question (before the slots) is never deferred.
      if (isFinalizationItem(stage, openItem, stages)) {
        const pending = pendingConfirmationBeforeFinalize(stages, itemStatuses, slotsFilled);
        if (pending) {
          return result({
            stage: pending.stage,
            item: pending.item,
            mode: "confirm_slot",
            reason: "slot_confirmation_pending",
            itemStatus: itemStatuses[pending.item.id] || null,
          });
        }
      }

      return result({
        stage,
        item: openItem,
        mode: openItem.type === "slot" ? "collect_missing_slot" : "continue_stage",
        reason: "conversation_stage_match",
        matchedItem,
        score,
        itemStatus: itemStatuses[openItem.id] || null,
      });
    }
    // No open item in this matched stage: fall through so other matched stages
    // and the global fallback can still surface an uncollected item. Confirming
    // low-confidence suggestions is deferred to the very end (see below), so a
    // filled slot here never preempts collecting an empty slot elsewhere.
  }

  // The caller volunteered a later stage but no match landed at (or before, in
  // sequence) the lead slot's stage — collect the earliest open slot directly
  // rather than letting the fallback resurface an earlier open non-slot item
  // (e.g. re-greeting from a stale utterance). See `jumpedAhead` above.
  if (jumpedAhead && leadSlot) {
    return result({
      stage: leadSlot.stage,
      item: leadSlot.item,
      mode: "collect_missing_slot",
      reason: "lead_slot",
      itemStatus: itemStatuses[leadSlot.item.id] || null,
    });
  }

  // Only clamp the fallback once real progress has happened (some slot,
  // anywhere, has a value) — otherwise leadStageOrder being > 0 just means
  // earlier stages have no slots at all, not that they were skipped.
  //
  // When leadStageOrder is null (every slot filled), floor by progressStageOrder
  // whenever there has been ANY real conversation (hasAnyConversation) — not
  // only when THIS turn's utterance happened to match and get suppressed above.
  // A quiet/non-matching turn late in a real call (e.g. right after the last
  // slot is collected, before read-back) must not leave the fallback fully
  // unclamped: without this, `firstOpenWorkflowItem` walks stages from the
  // start again and can resurface a stuck opening item (reported live: the
  // greeting reappearing between Trip Notes & Air Safety and read-back).
  // Genuinely no conversation at all (hasAnyConversation false — a straight
  // AI-handoff prefill before the agent/customer have said anything) is the
  // one case that must stay unclamped: a stuck opening non-slot item (e.g. a
  // greeting an AI handoff never ran) legitimately belongs there even though
  // every slot is pre-filled (see "a pending opening greeting is NOT deferred
  // even when all slots are pre-filled" in agent-assist-suggestion-advance.test.mjs).
  const progressStageFloor = leadStageOrder !== null
    ? (hasAnyCollectedSlot(stages, itemStatuses, slotsFilled) ? leadStageOrder : null)
    : (hasAnyConversation ? progressStageOrder : null);
  const fallback = firstOpenWorkflowItem(stages, itemStatuses, slotsFilled, progressStageFloor);
  if (fallback) {
    // Same finalization guard as the matched-stage path: don't advance to a
    // closing action while a low-confidence slot is still unconfirmed. Opening
    // non-slot items (greeting) are not finalization items, so they still run.
    if (isFinalizationItem(fallback.stage, fallback.item, stages)) {
      const pending = pendingConfirmationBeforeFinalize(stages, itemStatuses, slotsFilled);
      if (pending) {
        return result({
          stage: pending.stage,
          item: pending.item,
          mode: "confirm_slot",
          reason: "slot_confirmation_pending",
          itemStatus: itemStatuses[pending.item.id] || null,
        });
      }
    }

    return result({
      stage: fallback.stage,
      item: fallback.item,
      mode: fallback.item.type === "slot" ? "collect_missing_slot" : "continue_workflow",
      reason: "first_open_item",
      itemStatus: itemStatuses[fallback.item.id] || null,
    });
  }

  // Nothing left to collect anywhere. Surface any remaining low-confidence slot
  // for confirmation so the agent can finalize it before closing the call.
  for (const stage of sortedStages(stages)) {
    const suggestedSlot = sortedItems(stage).find((item) => needsSlotConfirmation(item, itemStatuses));
    if (suggestedSlot) {
      return result({
        stage,
        item: suggestedSlot,
        mode: "confirm_slot",
        reason: "slot_confirmation_pending",
        itemStatus: itemStatuses[suggestedSlot.id] || null,
      });
    }
  }

  return null;
}
