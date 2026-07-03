import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowAnalysisSystemPrompt } from "../lib/agent-assist/workflow-prompts.js";

const item = (over = {}) => ({
  item_id: "id",
  type: "slot",
  label: "Slot",
  stage_name: "Stage",
  slot_name: "slot",
  slot_type: "text",
  completion_trigger: "either",
  ...over,
});

const build = (items, opts = {}) =>
  buildWorkflowAnalysisSystemPrompt({ pendingItems: items, slotsFilled: {}, ...opts });

test("prompt documents matching each value to the correct slot (no cross-slot bleed)", () => {
  const p = build([item()]);
  assert.match(p, /Match each value to the correct slot/i);
  assert.match(p, /NEVER place an answer in an unrelated slot/i);
  // The concrete physician→patient-name example is present.
  assert.match(p, /physician'?s name must NOT fill a patient-name slot/i);
});

test("prompt documents multi-slot decomposition from one utterance", () => {
  const p = build([item()]);
  assert.match(p, /One utterance can fill multiple slots/i);
  assert.match(p, /SEPARATE completed_items entry for each/i);
});

test("prompt documents first/last name splitting", () => {
  const p = build([item()]);
  assert.match(p, /Sarah Thompson.*first="Sarah".*last="Thompson"/is);
  assert.match(p, /single combined name slot/i);
});

test("prompt documents boolean handling where a negative answer is a valid false", () => {
  const p = build([item({ slot_name: "accompanying", slot_type: "boolean" })]);
  // Boolean type is surfaced for the item...
  assert.match(p, /accompanying \(boolean\)/);
  // ...and the rule states "no" is a captured false, not missing.
  assert.match(p, /A negative answer IS a valid captured value \(false\)/i);
  assert.match(p, /No other aircraft responding.*->.*false/i);
});

test("prompt documents number and date normalization", () => {
  const p = build([item()]);
  assert.match(p, /two IV drips.*->.*2/i);
  assert.match(p, /1968-03-12/);
});

test("prompt documents speech-to-text mishearing tolerance with the reported examples", () => {
  const p = build([item()]);
  assert.match(p, /Speech-to-Text Mishearing Tolerance/i);
  // #7: "ICU" transcribed as "I see you" for the department slot.
  assert.match(p, /I see you.*->.*ICU/i);
  // #5: alphabetic bed "B" transcribed as "Bedby".
  assert.match(p, /bedby.*->.*B/i);
  // Guardrail: only correct when the slot makes it clear; don't invent.
  assert.match(p, /Do NOT invent values/i);
  assert.match(p, /when the (?:slot|expected)/i);
  // The letter/number reduction must be scoped to DEDICATED slots — a combined
  // location slot keeps the full value, not just the letter.
  assert.match(p, /dedicated/i);
  assert.match(p, /ICU room 412 bed B.*->.*ICU room 412 bed B/i);
});

test("select slot renders its allowed options; non-select slots do not", () => {
  const withOptions = build([
    item({ slot_name: "transport_reason", slot_type: "select", slot_options: ["Cardiac", "Trauma – Adult", "Surgical"] }),
  ]);
  assert.match(withOptions, /Allowed options \(choose the closest match\): Cardiac, Trauma – Adult, Surgical/);

  const noOptions = build([item({ slot_name: "pickup_facility", slot_type: "text" })]);
  assert.doesNotMatch(noOptions, /Allowed options/);
});

test("empty/absent slot_options does not render an options line", () => {
  const p = build([item({ slot_type: "select", slot_options: [] })]);
  assert.doesNotMatch(p, /Allowed options/);
});
