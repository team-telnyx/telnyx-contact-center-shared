import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowAnalysisSystemPrompt } from "../lib/agent-assist/workflow-prompts.js";

// Reported live: customer said "there's no other aircraft currently
// responding... also, the weather is declining [i.e. getting worse]" while
// giving trip notes. The LLM set "Air service declined for weather" (a
// boolean asking whether ANOTHER service refused/turned down the flight due
// to weather) to true, purely because the word "declining" (deteriorating
// conditions) shares a root with the slot's own "declined" (refused) wording
// — the customer never actually answered that question. Confirmed live: the
// agent reported "customer said no, but slot filling other air service
// declined for weather set to Yes".

test("boolean-slot extraction rule warns against inferring a value from shared word roots alone", () => {
  const prompt = buildWorkflowAnalysisSystemPrompt({
    pendingItems: [
      { item_id: "a", type: "slot", label: "Air Service Declined for Weather", slot_name: "weather_declined", slot_type: "boolean", stage_name: "Air Safety" },
    ],
    slotsFilled: {},
  });

  assert.match(prompt, /Don't infer a boolean value from shared wording alone/);
  // Explicitly calls out the exact word-root collision that caused the bug.
  assert.match(prompt, /"declin-"/);
  assert.match(prompt, /refuse\/turn down/);
  assert.match(prompt, /deteriorating\/getting worse/);
  assert.match(
    prompt,
    /omit the slot \(or use low confidence\) instead of guessing true/
  );
});
