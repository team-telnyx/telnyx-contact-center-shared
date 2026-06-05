import test from "node:test";
import assert from "node:assert/strict";

import { resolveSuggestedResponseTarget } from "../lib/agent-assist/suggestion-target-resolver.mjs";

const stages = [
  {
    id: "stage-1",
    name: "Greeting",
    order_index: 0,
    items: [
      { id: "greet", type: "action", label: "Greet the customer", prompt_hint: "hello welcome", order_index: 0 },
      { id: "ask-help", type: "question", label: "Ask how you can help", prompt_hint: "how can I help", order_index: 1 },
    ],
  },
  {
    id: "stage-2",
    name: "Account Verification",
    order_index: 1,
    items: [
      { id: "permission", type: "question", label: "Request permission to verify account", prompt_hint: "verify account security", order_index: 0 },
      { id: "account-number", type: "slot", label: "Account number", slot_name: "account_number", prompt_hint: "account number", order_index: 1 },
      { id: "confirm-account", type: "action", label: "Confirm account verified", prompt_hint: "confirm verified", order_index: 2 },
    ],
  },
  {
    id: "stage-3",
    name: "Patient Information",
    order_index: 2,
    items: [
      { id: "patient-name", type: "slot", label: "Patient full name", slot_name: "patient_name", prompt_hint: "patient name full name", order_index: 0 },
      { id: "dob", type: "slot", label: "Date of birth", slot_name: "date_of_birth", prompt_hint: "date of birth birthday dob", order_index: 1 },
      { id: "symptoms", type: "slot", label: "Symptoms", slot_name: "symptoms", prompt_hint: "symptoms pain fever condition", order_index: 2 },
      { id: "confirm-patient", type: "action", label: "Confirm patient details", prompt_hint: "confirm patient details", order_index: 3 },
    ],
  },
];

const finalConversation = (text) => [
  { isFinal: true, track: "inbound", transcript: text },
];

test("follows the conversation into a later stage instead of the first pending workflow item", () => {
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {
      greet: { status: "completed" },
      "patient-name": { status: "completed", extracted_value: "Jane Doe" },
    },
    slotsFilled: { patient_name: "Jane Doe" },
    transcriptions: finalConversation("The patient name is Jane Doe and her birthday is March 4th 1988."),
  });

  assert.equal(result.stage.id, "stage-3");
  assert.equal(result.item.id, "dob");
  assert.equal(result.mode, "collect_missing_slot");
  assert.equal(result.reason, "conversation_stage_match");
});

test("does not suggest a confirmation item when prerequisite slots in that stage are still missing", () => {
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {
      greet: { status: "completed" },
      "patient-name": { status: "completed", extracted_value: "Jane Doe" },
      dob: { status: "completed", extracted_value: "1988-03-04" },
    },
    slotsFilled: { patient_name: "Jane Doe", date_of_birth: "1988-03-04" },
    transcriptions: finalConversation("Can you confirm the patient details before we book the appointment?"),
  });

  assert.equal(result.stage.id, "stage-3");
  assert.equal(result.item.id, "symptoms");
  assert.equal(result.mode, "collect_prerequisite");
  assert.equal(result.blockedItem.id, "confirm-patient");
});

test("prioritizes a suggested low-confidence slot in the active stage for agent confirmation", () => {
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {
      greet: { status: "completed" },
      "patient-name": {
        status: "suggested",
        extracted_value: "Jane Doe",
        confidence_score: 0.72,
        confidence_threshold: 0.95,
      },
    },
    slotsFilled: {},
    transcriptions: finalConversation("The patient information is Jane Doe, she has a high fever."),
  });

  assert.equal(result.stage.id, "stage-3");
  assert.equal(result.item.id, "patient-name");
  assert.equal(result.mode, "confirm_slot");
  assert.equal(result.reason, "slot_confirmation_required");
});

test("falls back to first open workflow item when conversation does not match any later stage", () => {
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: { greet: { status: "completed" } },
    slotsFilled: {},
    transcriptions: finalConversation("Okay."),
  });

  assert.equal(result.stage.id, "stage-1");
  assert.equal(result.item.id, "ask-help");
  assert.equal(result.mode, "continue_workflow");
  assert.equal(result.reason, "first_open_item");
});
