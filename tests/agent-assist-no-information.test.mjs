import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowAnalysisSystemPrompt } from "../lib/agent-assist/workflow-prompts.js";

const PENDING = [
  { item_id: "r", type: "slot", label: "Destination room", slot_name: "destination_room", slot_type: "text", completion_trigger: "customer", stage_name: "Destination" },
];

test("prompt tells the analyzer to capture 'no information' answers as N/A so the flow advances", () => {
  const prompt = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {} });
  assert.match(prompt, /No information available/i);
  // The normalized sentinel value.
  assert.match(prompt, /"N\/A"/);
  // Examples of the "I don't have it" phrasing.
  assert.match(prompt, /don't have a room yet/i);
  // Scoped to the current slot only, and not for "hasn't answered yet".
  assert.match(prompt, /ONLY to the slot currently being collected/);
  assert.match(prompt, /hasn't answered yet/i);
});

test("prompt tells the analyzer to capture free-text notes verbatim (conversational, any length)", () => {
  const prompt = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {} });
  assert.match(prompt, /Free-text notes/i);
  assert.match(prompt, /VERBATIM/);
  // Doesn't require structured data and doesn't drop for length.
  assert.match(prompt, /do not drop it for length/i);
  // The real live example.
  assert.match(prompt, /they want him moved quickly/);
});
