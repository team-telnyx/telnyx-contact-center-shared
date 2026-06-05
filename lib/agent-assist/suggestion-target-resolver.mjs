const STOP_WORDS = new Set([
  "the", "and", "for", "you", "your", "that", "this", "with", "from", "have", "has",
  "can", "could", "would", "should", "what", "when", "where", "how", "why", "who",
  "ask", "tell", "please", "customer", "agent", "item", "stage", "full", "details",
]);

const CONFIRMATION_TERMS = new Set([
  "confirm", "confirmed", "verify", "verified", "validate", "validated", "review", "summarize", "summary",
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

function itemIsOpen(item, itemStatuses = {}, slotsFilled = {}) {
  return !isWorkflowItemSatisfied(item, itemStatuses, slotsFilled);
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

  for (const matchedStage of matchedStages) {
    const { stage, matchedItem, score } = matchedStage;
    const items = sortedItems(stage);

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

    const suggestedSlot = items.find((item) => needsSlotConfirmation(item, itemStatuses));
    if (suggestedSlot) {
      return result({
        stage,
        item: suggestedSlot,
        mode: "confirm_slot",
        reason: "slot_confirmation_required",
        matchedItem,
        score,
        itemStatus: itemStatuses[suggestedSlot.id] || null,
      });
    }

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
  }

  const fallback = firstOpenWorkflowItem(stages, itemStatuses, slotsFilled);
  if (!fallback) return null;

  const fallbackMode = needsSlotConfirmation(fallback.item, itemStatuses)
    ? "confirm_slot"
    : fallback.item.type === "slot"
      ? "collect_missing_slot"
      : "continue_workflow";

  return result({
    stage: fallback.stage,
    item: fallback.item,
    mode: fallbackMode,
    reason: "first_open_item",
    itemStatus: itemStatuses[fallback.item.id] || null,
  });
}
