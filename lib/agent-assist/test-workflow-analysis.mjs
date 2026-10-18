/**
 * Test AI Agent slot analysis: which items go to the analyzer, and how its
 * answer becomes updates (POST /api/admin/workflows/[id]/analyze-test).
 *
 * The test route has no DB session. The page sends its own item statuses and
 * slots with every line and applies the updates it gets back, so this module
 * is pure and works only from what the request carries. It mirrors the live
 * route (app/api/agent-assist/workflow/analyze/route.js) wherever that logic
 * does not depend on persisted session rows:
 *
 * - pending and still-"suggested" items are analysed, and completed notes
 *   slots stay analyzable so a multi-utterance note keeps accumulating;
 * - an earlier fix corrections: at the read-back step, or once a line says a value is
 *   wrong (this line, or the one right before it mid-call), every other
 *   completed slot goes back to the analyzer as a correction candidate with
 *   its current value. A correction is always returned as "suggested" with
 *   is_correction, never auto-completed, and slotsFilled keeps the old value
 *   until the new one is confirmed;
 * - the caller's read-back affirmative completes the confirm-all item and
 *   promotes every pending correction into slotsFilled.
 *
 * The live route's other guards (stage narrowing, the stray-fragment bleed
 * guard, facility redirects, the agent recitation backstop) are not ported.
 * The live manual-edit exclusion has no counterpart: the test page has no
 * pencil edit, so every completed value came from the conversation.
 */

import {
  isReadBackItem,
  matchesReadBackAffirmativeHints,
  mentionsCorrectionTrigger,
} from "./readback.mjs";
import { isAccumulatingSlot, accumulateSlotValue } from "./slot-accumulate.mjs";

export function normalizeSpeakerType(speaker) {
  if (speaker === "inbound" || speaker === "customer") return "customer";
  if (speaker === "outbound" || speaker === "agent") return "agent";
  return null;
}

export function hasMeaningfulExtractedValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

// Slot items default to "customer" - customer provides the value; others default to "agent"
const getDefaultCompletionTrigger = (type) =>
  type === "slot" ? "customer" : "agent";

const isReadBack = (item) =>
  isReadBackItem({
    itemType: item.type,
    itemLabel: item.label,
    itemPromptHint: item.prompt_hint,
    itemHints: item.hints,
  });

function statusEntry(itemStatuses, itemId) {
  const entry = itemStatuses?.[itemId];
  return entry && typeof entry === "object" ? entry : null;
}

const asObject = (value) => (value && typeof value === "object" ? value : {});

function entryValue(entry) {
  const value = entry?.extracted_value ?? entry?.value;
  return hasMeaningfulExtractedValue(value) ? value : null;
}

function toAnalyzerItem(item, current_status) {
  return {
    item_id: item.id,
    type: item.type,
    label: item.label,
    prompt_hint: item.prompt_hint,
    hints: item.hints,
    slot_name: item.slot_name,
    slot_type: item.slot_type,
    slot_validation: item.slot_validation,
    completion_trigger: item.completion_trigger || getDefaultCompletionTrigger(item.type),
    stage_name: item.stage_name,
    stage_order: item.stage_order,
    current_status,
  };
}

/**
 * Decide what the analyzer sees for one line.
 *
 * @param {object} options
 * @param {Array<object>} options.items workflow item rows (with stage_name / stage_order)
 * @param {object} [options.itemStatuses] the page's statuses, keyed by item id
 * @param {object} [options.slotsFilled] the page's collected slot values
 * @param {string} [options.transcript] the line being analysed
 * @param {Array<{speaker?: string, text?: string}>} [options.recentContext] preceding lines, oldest first
 */
export function planTestWorkflowAnalysis({
  items = [],
  itemStatuses = {},
  slotsFilled = {},
  transcript = "",
  recentContext = [],
} = {}) {
  slotsFilled = asObject(slotsFilled);
  const statusOf = (item) => statusEntry(itemStatuses, item.id)?.status;

  // Not completed yet. A "suggested" item stays analyzable so a clearer later
  // line can confirm or replace the low-confidence value.
  const pendingItems = items
    .filter((item) => statusOf(item) !== "completed")
    .map((item) => toAnalyzerItem(item, statusOf(item) === "suggested" ? "suggested" : "pending"));

  // Completed slots carry the value they hold, so the prompt marks them
  // ALREADY CONFIRMED instead of treating them as blank.
  const completedSlotItems = items
    .filter((item) => statusOf(item) === "completed" && item.type === "slot")
    .map((item) => ({
      ...toAnalyzerItem(item, "completed"),
      completed_value:
        entryValue(statusEntry(itemStatuses, item.id)) ??
        (hasMeaningfulExtractedValue(slotsFilled[item.slot_name]) ? slotsFilled[item.slot_name] : null),
    }));

  // Completed notes slots stay analyzable so multi-utterance notes accumulate
  // (mirrors the live analyze route).
  const completedNotesItems = completedSlotItems.filter((item) => isAccumulatingSlot(item));

  // Read-back is reached once a read-back item is still open AND every slot
  // already has a value. A "suggested" slot that already holds a value is a
  // correction waiting for confirmation, not a gap, so it does not count.
  const isReadBackStage =
    !pendingItems.some(
      (item) => item.type === "slot" && !hasMeaningfulExtractedValue(slotsFilled[item.slot_name])
    ) && pendingItems.some(isReadBack);

  // an earlier fix: a correction can come at any stage. At read-back the whole recent
  // window may hold the trigger; mid-call only this line or the one right
  // before it, so a stale "that's wrong" does not keep every completed slot
  // exposed while collection moves on (same windows as the live route).
  const recentContextEntries = Array.isArray(recentContext) ? recentContext : [];
  const midCallCorrectionWindow = recentContextEntries.slice(-1);
  const correctionWindow = isReadBackStage ? recentContextEntries : midCallCorrectionWindow;
  const correctionRequested =
    mentionsCorrectionTrigger(transcript) ||
    correctionWindow.some((c) => mentionsCorrectionTrigger(c?.text));
  const correctionInProgress = correctionRequested;

  // Every other completed slot becomes a correction candidate, but only at
  // read-back or behind an explicit trigger. Without one, a completed slot
  // stays out of the analyzer's view, so a later passing mention of a value
  // cannot overwrite it.
  const correctionsAllowed = isReadBackStage || correctionRequested;
  const correctionCandidateItems = correctionsAllowed
    ? completedSlotItems.filter((item) => !isAccumulatingSlot(item))
    : [];

  const analyzerItems = [...pendingItems, ...completedNotesItems, ...correctionCandidateItems];

  // The slot currently being collected (earliest open slot) — mirrors the live
  // analyze route so tests exercise the same current-target disambiguation.
  const currentTargetItem = pendingItems.find((i) => i.type === "slot");
  const currentTarget = currentTargetItem
    ? { label: currentTargetItem.label, slotName: currentTargetItem.slot_name }
    : null;

  return {
    pendingItems,
    completedNotesItems,
    correctionCandidateItems,
    analyzerItems,
    currentTarget,
    isReadBackStage,
    correctionInProgress,
    // The prompt's correction section follows the candidates actually sent.
    allowCorrections: correctionCandidateItems.length > 0,
  };
}

/**
 * Turn the analyzer's answer into the route's response.
 *
 * @param {object} options
 * @param {ReturnType<typeof planTestWorkflowAnalysis>} options.plan
 * @param {{completed_items?: Array<object>}} options.analysisResult
 * @param {string} options.speaker
 * @param {object} [options.slotsFilled]
 * @param {object} [options.itemStatuses]
 * @param {number} options.confidenceThreshold
 * @param {string} [options.transcript]
 * @returns {{ updates: Array<object>, slotsFilled: object }}
 */
export function applyTestWorkflowAnalysis({
  plan,
  analysisResult,
  speaker,
  slotsFilled = {},
  itemStatuses = {},
  confidenceThreshold,
  transcript = "",
}) {
  const { pendingItems, analyzerItems, correctionCandidateItems, isReadBackStage } = plan;

  // Apply completion_trigger and confidence threshold (same logic as live API)
  const speakerType = normalizeSpeakerType(speaker);

  const updates = [];
  const newSlotsFilled = { ...asObject(slotsFilled) };

  for (const completed of analysisResult?.completed_items || []) {
    const item = analyzerItems.find((p) => p.item_id === completed.item_id);
    if (!item) continue;

    const completionTrigger = item.completion_trigger || getDefaultCompletionTrigger(item.type);
    const shouldComplete =
      Boolean(speakerType) &&
      (completionTrigger === "either" ||
        (completionTrigger === "customer" && speakerType === "customer") ||
        (completionTrigger === "agent" && speakerType === "agent"));
    const hasExtractedSlotValue = item.type !== "slot" || hasMeaningfulExtractedValue(completed.extracted_value);

    if (!shouldComplete || !hasExtractedSlotValue) {
      continue;
    }

    // Keep the final read-back / "confirm all" item open until every slot is
    // collected and confirmed (mirrors the live route).
    const hasUnconfirmedSlot = pendingItems.some((p) => p.type === "slot");
    if (
      item.type !== "slot" &&
      hasUnconfirmedSlot &&
      isReadBackItem({ itemType: item.type, itemLabel: item.label, itemPromptHint: item.prompt_hint, itemHints: item.hints })
    ) {
      continue;
    }

    // Already-completed notes slot re-analyzed → append the new fragment.
    if (item.current_status === "completed" && item.type === "slot" && isAccumulatingSlot(item)) {
      if (completed.confidence < confidenceThreshold) {
        continue;
      }
      const accumulated = accumulateSlotValue(newSlotsFilled[item.slot_name], completed.extracted_value);
      if (accumulated !== (newSlotsFilled[item.slot_name] ?? "")) {
        newSlotsFilled[item.slot_name] = accumulated;
        updates.push({
          item_id: completed.item_id,
          status: "completed",
          confidence: completed.confidence,
          extracted_value: accumulated,
          source_text: completed.source_text,
        });
      }
      continue;
    }

    // A correction candidate (an already-completed slot re-included above) is
    // ALWAYS returned as "suggested", whatever its confidence: speech-to-text
    // can garble a corrected value into something that still scores high, so
    // it waits for confirmation instead of silently overwriting. slotsFilled
    // is deliberately left alone, so the old value stays the record until the
    // new one is confirmed (an earlier fix).
    if (item.current_status === "completed") {
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

    if (completed.confidence >= confidenceThreshold) {
      updates.push({
        item_id: completed.item_id,
        status: "completed",
        confidence: completed.confidence,
        extracted_value: completed.extracted_value,
        source_text: completed.source_text,
      });
      if (item.slot_name && completed.extracted_value) {
        newSlotsFilled[item.slot_name] = isAccumulatingSlot(item)
          ? accumulateSlotValue(newSlotsFilled[item.slot_name], completed.extracted_value)
          : completed.extracted_value;
      }
    } else {
      updates.push({
        item_id: completed.item_id,
        status: "suggested",
        confidence: completed.confidence,
        extracted_value: completed.extracted_value,
        source_text: completed.source_text,
        alternatives: Array.isArray(completed.alternatives) ? completed.alternatives : [],
        low_confidence: shouldComplete && completed.confidence < confidenceThreshold,
        confidence_threshold: confidenceThreshold,
      });
    }
  }

  // Deterministic backstop (mirrors the live route): the LLM path above keeps
  // the confirm-all item open while any slot is unconfirmed, which includes a
  // correction parked at "suggested". At the read-back stage the caller's own
  // affirmative completes it directly.
  if (isReadBackStage && speakerType === "customer") {
    const readBackConfirmItem = pendingItems.find(
      (item) => item.completion_trigger === "customer" && isReadBack(item)
    );
    const alreadyHandledThisTurn =
      readBackConfirmItem && updates.some((u) => u.item_id === readBackConfirmItem.item_id);
    if (
      readBackConfirmItem &&
      !alreadyHandledThisTurn &&
      matchesReadBackAffirmativeHints(transcript, readBackConfirmItem)
    ) {
      updates.push({
        item_id: readBackConfirmItem.item_id,
        status: "completed",
        confidence: 1,
        extracted_value: true,
        source_text: transcript,
        alternatives: [],
        completed_by: "customer",
      });
    }
  }

  // The caller accepted the whole read-back summary, which already folds in
  // every pending correction, so promote them together instead of asking for
  // each one again. Only the customer-triggered confirm-all item counts: the
  // agent's own recitation must not make a misheard correction the record.
  // A correction is a "suggested" slot that already has a value in
  // slotsFilled; a first-time low-confidence suggestion has none and still
  // needs its own confirmation.
  const readBackJustConfirmed = updates.some((u) => {
    if (u.status !== "completed") return false;
    const confirmedItem = analyzerItems.find((p) => p.item_id === u.item_id);
    return Boolean(confirmedItem) && confirmedItem.completion_trigger === "customer" && isReadBack(confirmedItem);
  });

  if (readBackJustConfirmed) {
    const latestUpdateById = new Map(updates.map((u) => [u.item_id, u]));
    for (const item of [...pendingItems, ...correctionCandidateItems]) {
      if (item.type !== "slot" || !item.slot_name) continue;
      const latest = latestUpdateById.get(item.item_id);
      const status = latest ? latest.status : item.current_status;
      if (status !== "suggested") continue;
      if (!hasMeaningfulExtractedValue(newSlotsFilled[item.slot_name])) continue; // not a correction candidate
      const source = latest ?? statusEntry(itemStatuses, item.item_id);
      const value = entryValue(source);
      if (value === null) continue;
      newSlotsFilled[item.slot_name] = value;
      updates.push({
        item_id: item.item_id,
        status: "completed",
        confidence: latest ? latest.confidence : source?.confidence_score ?? null,
        extracted_value: value,
        source_text: transcript,
        alternatives: [],
      });
    }
  }

  return { updates, slotsFilled: newSlotsFilled };
}
