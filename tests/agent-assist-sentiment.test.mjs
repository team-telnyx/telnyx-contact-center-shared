import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowAnalysisSystemPrompt } from "../lib/agent-assist/workflow-prompts.js";

const PENDING = [
  { item_id: "a", type: "slot", label: "Other aircraft currently responding?", slot_name: "other_aircraft", slot_type: "boolean", stage_name: "Air Safety" },
];

test("sentiment instruction treats operational/clinical negatives as neutral, not negative", () => {
  const prompt = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {}, includeSentiment: true });
  assert.match(prompt, /EMOTIONAL STATE/);
  // A factual negative is neutral.
  assert.match(prompt, /operational\/clinical NEGATIVE is neutral/i);
  assert.match(prompt, /No other aircraft are responding/);
  // Negative sentiment only for genuine distress/dissatisfaction.
  assert.match(prompt, /Only use negative sentiment when the caller actually expresses/i);
});

test("sentiment guidance is only present when sentiment is requested", () => {
  const withSentiment = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {}, includeSentiment: true });
  assert.match(withSentiment, /"sentiment":/);
  const without = buildWorkflowAnalysisSystemPrompt({ pendingItems: PENDING, slotsFilled: {} });
  assert.doesNotMatch(without, /EMOTIONAL STATE/);
});
