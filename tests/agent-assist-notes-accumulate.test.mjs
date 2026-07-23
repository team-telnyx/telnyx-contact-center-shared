import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAccumulatingSlot, accumulateSlotValue } from "../lib/agent-assist/slot-accumulate.mjs";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("isAccumulatingSlot matches free-text notes/details/comments slots only", () => {
  assert.equal(isAccumulatingSlot({ type: "slot", slot_type: "text", slot_name: "trip_notes", label: "Trip notes" }), true);
  assert.equal(isAccumulatingSlot({ type: "slot", slot_type: "text", slot_name: "additional_details", label: "Additional details" }), true);
  assert.equal(isAccumulatingSlot({ type: "slot", slot_type: "text", slot_name: "comments", label: "Comments" }), true);
  // Ordinary value slots overwrite, not accumulate.
  assert.equal(isAccumulatingSlot({ type: "slot", slot_type: "text", slot_name: "patient_name", label: "Patient full name" }), false);
  assert.equal(isAccumulatingSlot({ type: "slot", slot_type: "text", slot_name: "destination_facility", label: "Destination facility name" }), false);
  // Non-text slots never accumulate even if named "notes".
  assert.equal(isAccumulatingSlot({ type: "slot", slot_type: "number", slot_name: "notes_count", label: "Notes count" }), false);
});

test("accumulateSlotValue appends multi-utterance fragments without losing earlier content", () => {
  let v = "";
  v = accumulateSlotValue(v, "he's mentally disordered");
  v = accumulateSlotValue(v, "may try to attack people");
  v = accumulateSlotValue(v, "can be very violent");
  v = accumulateSlotValue(v, "be cautious about that");
  // The whole safety warning survives — not just the last fragment.
  assert.match(v, /mentally disordered/);
  assert.match(v, /attack people/);
  assert.match(v, /very violent/);
  assert.match(v, /be cautious/);
});

test("accumulateSlotValue dedupes repeats and supersets", () => {
  assert.equal(accumulateSlotValue("be cautious", "be cautious"), "be cautious");
  assert.equal(accumulateSlotValue("cautious", "be cautious about that"), "be cautious about that"); // superset replaces
  assert.equal(accumulateSlotValue("a", ""), "a"); // empty incoming ignored
  assert.equal(accumulateSlotValue("", "first"), "first"); // seeds from empty
});

test("live analyze route guards the read-back item and accumulates notes slots", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // Read-back/confirm-all item must not complete while a slot is still unconfirmed.
  assert.match(route, /hasUnconfirmedSlot = pendingItems\.some\(\(p\) => p\.type === "slot"\)/);
  assert.match(route, /isReadBackItem\(\{[\s\S]*?itemHints: item\.hints/);
  // Notes slots accumulate instead of overwrite.
  assert.match(route, /isAccumulatingSlot\(item\)\s*\?\s*accumulateSlotValue\(/);
  // hints projected so isReadBackItem can see them.
  assert.match(route, /i\.hints,/);
});

test("admin analyze-test route mirrors the guard + accumulation", async () => {
  const route = await read("../app/api/admin/workflows/[id]/analyze-test/route.js");
  assert.match(route, /hasUnconfirmedSlot = pendingItems\.some\(\(p\) => p\.type === "slot"\)/);
  assert.match(route, /isReadBackItem\(\{/);
  assert.match(route, /isAccumulatingSlot\(item\)\s*\?\s*accumulateSlotValue\(/);
});

test("live route keeps COMPLETED notes slots analyzable so later fragments accumulate (Codex #1162/#1163)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // Completed notes slots are re-fetched and fed into the analyzer input (not pendingItems).
  assert.match(route, /ist\.status = 'completed' AND i\.type = 'slot'/);
  assert.match(route, /completedNotesItems = completedSlotRows\.filter/);
  assert.match(route, /const analyzerItems = \[\.\.\.relevantPendingItems, \.\.\.completedNotesItems, \.\.\.correctionCandidateItems\]/);
  // Stage-narrowing (workflow_analyzer_items_narrowed) trims relevantPendingItems
  // to nearby stages, but completedNotesItems are re-added unconditionally
  // afterward — a notes slot from an earlier stage must stay analyzable however
  // far the conversation has moved on.
  assert.match(route, /const narrowedAnalyzerItems = \[\.\.\.narrowedRelevantPendingItems, \.\.\.completedNotesItems, \.\.\.correctionCandidateItems\]/);
  assert.match(route, /pendingItems: narrowedAnalyzerItems/);
  // The completion loop looks items up in analyzerItems and appends for a completed notes slot.
  assert.match(route, /analyzerItems\.find\(p => p\.item_id === completed\.item_id\)/);
  assert.match(route, /item\.current_status === "completed" && item\.type === "slot" && isAccumulatingSlot\(item\)/);
  // The read-back guard must NOT be fooled by the re-included completed slot — it still keys on pendingItems.
  assert.match(route, /hasUnconfirmedSlot = pendingItems\.some\(\(p\) => p\.type === "slot"\)/);
});

test("live route fetches completed notes BEFORE the empty-pending return and gates append on threshold (Codex #1164)", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  // P1: the empty check is on the COMBINED analyzer input, and the completed-notes
  // query appears before it (so a note still accumulates when nothing is pending).
  assert.match(route, /if \(analyzerItems\.length === 0\)/);
  const idxQuery = route.indexOf("ist.status = 'completed' AND i.type = 'slot'");
  const idxEmptyReturn = route.indexOf("if (analyzerItems.length === 0)");
  assert.ok(idxQuery > 0 && idxEmptyReturn > 0 && idxQuery < idxEmptyReturn, "completed-notes query must precede the empty-pending return");
  // The old pending-only early return must be gone.
  assert.doesNotMatch(route, /if \(relevantPendingItems\.length === 0\)/);
  // P2: low-confidence fragments are NOT appended to a completed note.
  assert.match(route, /if \(completed\.confidence < confidenceThreshold\) \{\s*\n\s*continue;/);
});

test("analyze-test route also re-includes completed notes slots and appends", async () => {
  const route = await read("../app/api/admin/workflows/[id]/analyze-test/route.js");
  assert.match(route, /completedNotesItems = items[\s\S]*?isAccumulatingSlot\(item\)/);
  assert.match(route, /const analyzerItems = \[\.\.\.pendingItems, \.\.\.completedNotesItems\]/);
  assert.match(route, /pendingItems: analyzerItems/);
  assert.match(route, /item\.current_status === "completed" && item\.type === "slot" && isAccumulatingSlot\(item\)/);
});
