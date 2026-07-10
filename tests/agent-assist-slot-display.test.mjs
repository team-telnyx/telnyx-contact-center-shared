import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hasSlotValue, pickSlotValue, formatSlotDisplay } from "../lib/agent-assist/slot-display.mjs";
import { buildWorkflowAnalysisSystemPrompt } from "../lib/agent-assist/workflow-prompts.js";

test("focus prompt routes a bare yes/no to the boolean slot being asked", () => {
  const prompt = buildWorkflowAnalysisSystemPrompt({
    pendingItems: [{ item_id: "a", type: "slot", label: "Other aircraft currently responding?", slot_name: "other_aircraft_responding", slot_type: "boolean", stage_name: "Air Safety" }],
    slotsFilled: {},
    currentTarget: { label: "Other aircraft currently responding?", slotName: "other_aircraft_responding" },
  });
  assert.match(prompt, /yes\/no \(boolean\) slot/i);
  assert.match(prompt, /yes -> true, no -> false/);
  assert.match(prompt, /answer to THIS slot/);
});

test("hasSlotValue treats boolean false and 0 as present (a captured 'No' is a value)", () => {
  assert.equal(hasSlotValue(false), true);
  assert.equal(hasSlotValue(0), true);
  assert.equal(hasSlotValue("ICU"), true);
  assert.equal(hasSlotValue(null), false);
  assert.equal(hasSlotValue(undefined), false);
  assert.equal(hasSlotValue(""), false);
});

test("pickSlotValue keeps false/0 instead of falling through like a || b || c", () => {
  // The old `status.value || status.extracted_value || slotsFilled[...]` dropped false.
  assert.equal(pickSlotValue(undefined, false, undefined), false);
  assert.equal(pickSlotValue(null, 0, "x"), 0);
  assert.equal(pickSlotValue(undefined, undefined, "Mercy"), "Mercy");
  assert.equal(pickSlotValue(null, undefined, ""), null);
});

test("formatSlotDisplay renders booleans as Yes/No", () => {
  assert.equal(formatSlotDisplay(false), "No");
  assert.equal(formatSlotDisplay(true), "Yes");
  assert.equal(formatSlotDisplay("Mercy Hospital"), "Mercy Hospital");
});

test("AgentAssistWorkflow no longer gates the slot display on truthiness", async () => {
  const cmp = await readFile(new URL("../components/contact-center/AgentAssistWorkflow.jsx", import.meta.url), "utf8");
  // Uses the present-check + formatter, not `slotValue ?` / `|| ""` / `|| ...`.
  assert.match(cmp, /hasSlotValue, pickSlotValue, formatSlotDisplay/);
  assert.match(cmp, /\) : hasSlotValue\(slotValue\) \? \(/);
  assert.match(cmp, /\{formatSlotDisplay\(slotValue\)\}/);
  // The old truthiness gate must be gone.
  assert.doesNotMatch(cmp, /\) : slotValue \? \(/);
  assert.doesNotMatch(cmp, /status\.value \|\| status\.extracted_value \|\|/);
});

test("confirming a suggested slot preserves boolean false end-to-end (Codex #1167)", async () => {
  // Handler no longer bails on falsy — a captured "No" (false) can be confirmed.
  const cmp = await readFile(new URL("../components/contact-center/AgentAssistWorkflow.jsx", import.meta.url), "utf8");
  assert.match(cmp, /if \(!hasSlotValue\(value\)\) return;/);
  // The complete route stores false instead of nulling it, and still fills the slot.
  const route = await readFile(new URL("../app/api/agent-assist/workflow/item/[id]/complete/route.js", import.meta.url), "utf8");
  assert.match(route, /hasMeaningfulValue\(value\) \? value : null/);
  assert.match(route, /if \(item\.slot_name && hasMeaningfulValue\(value\)\)/);
  assert.doesNotMatch(route, /\[value \|\| null, workflowSession\.id, itemId\]/);
});
