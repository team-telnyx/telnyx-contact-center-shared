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
  return item?.type === "slot" && status?.status === "suggested" && hasMeaningfulValue(status?.extracted_value);
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

function firstOpenItemInStage(stage, itemStatuses, slotsFilled) {
  return sortedItems(stage).find((item) => itemIsOpen(item, itemStatuses, slotsFilled)) || null;
}

function firstOpenWorkflowItem(stages, itemStatuses, slotsFilled) {
  for (const stage of sortedStages(stages)) {
    const item = firstOpenItemInStage(stage, itemStatuses, slotsFilled);
    if (item) return { stage, item };
  }
  return null;
}

function firstMissingPrerequisite(stage, blockedItem, itemStatuses, slotsFilled) {
  const items = sortedItems(stage);
  const blockedIndex = items.findIndex((item) => item.id === blockedItem?.id);
  if (blockedIndex <= 0) return null;

  return items.slice(0, blockedIndex).find((item) => itemIsOpen(item, itemStatuses, slotsFilled)) || null;
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

  for (const matchedStage of matchedStages) {
    const { stage, matchedItem, score } = matchedStage;

    if (leadStageOrder !== null && (stage?.order_index ?? 0) > leadStageOrder) {
      // The caller jumped ahead to a later stage; keep leading in sequence by
      // deferring to the earliest open slot (handled after the loop).
      continue;
    }

    if (jumpedAhead && (stage?.order_index ?? 0) < leadStageOrder) {
      // Stale earlier-stage match: the caller has already moved past it, so it
      // must not preempt the earliest open slot.
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

  const fallback = firstOpenWorkflowItem(stages, itemStatuses, slotsFilled);
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
