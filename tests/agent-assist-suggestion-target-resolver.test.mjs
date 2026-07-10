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

test("leads in workflow order: does NOT follow the conversation past an open earlier stage", () => {
  // Sequential leading: the caller volunteers Patient-stage info, but an earlier
  // stage still has an uncollected slot (account number). The agent must keep
  // asking in order and collect the earlier open slot first, instead of jumping
  // ahead to the stage the caller mentioned. (Reproduces the reported bug:
  // "asked Destination facility before Pickup was collected.")
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {
      greet: { status: "completed" },
      "ask-help": { status: "completed" },
      permission: { status: "completed" },
    },
    slotsFilled: {},
    transcriptions: finalConversation("The patient name is Jane Doe and her birthday is March 4th 1988."),
  });

  assert.equal(result.stage.id, "stage-2");
  assert.equal(result.item.id, "account-number");
  assert.equal(result.mode, "collect_missing_slot");
});

test("still follows the conversation forward once the earlier stage's slot is collected", () => {
  // Counterpart to sequential leading: when the earlier open slot is filled the
  // clamp lifts, and the resolver follows the caller into the later stage
  // (advance-past-filled / #1117 preserved).
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {
      greet: { status: "completed" },
      "ask-help": { status: "completed" },
      permission: { status: "completed" },
      "account-number": { status: "completed", extracted_value: "12345" },
      "confirm-account": { status: "completed" },
      "patient-name": { status: "completed", extracted_value: "Jane Doe" },
    },
    slotsFilled: { account_number: "12345", patient_name: "Jane Doe" },
    transcriptions: finalConversation("The patient name is Jane Doe and her birthday is March 4th 1988."),
  });

  assert.equal(result.stage.id, "stage-3");
  assert.equal(result.item.id, "dob");
  assert.equal(result.reason, "conversation_stage_match");
});

test("non-slot items in an earlier stage do NOT block leading (clamp keys on open SLOTS only)", () => {
  // Deliberate design (see resolver comment): the clamp keys on the earliest
  // open SLOT, not the earliest open item. Required data lives in slots; a
  // non-slot opening item (greeting) stays non-blocking so an undetectable
  // non-slot item can't hard-stall the whole workflow. Here the opening
  // greeting/ask-help are still open, but the caller volunteers an account
  // number — the resolver follows into the Verification stage instead of
  // pinning on the greeting.
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {},
    slotsFilled: {},
    transcriptions: finalConversation("My account number is 123456."),
  });

  assert.equal(result.stage.id, "stage-2");
  assert.equal(result.reason, "conversation_stage_match");
});

test("a stale earlier-stage match does not preempt the lead slot once the caller jumped ahead", () => {
  // The greeting item is still open and an old "hello welcome" utterance is
  // still in the transcript window, but the caller has now volunteered
  // Patient-stage info. The later Patient match is clamped (past the lead slot),
  // and the stale Greeting match must NOT win — the resolver collects the
  // earliest open slot (account number) directly.
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {},
    slotsFilled: {},
    transcriptions: [
      { isFinal: true, track: "outbound", transcript: "Hello, welcome, thanks for calling." },
      { isFinal: true, track: "inbound", transcript: "The patient is Jane Doe, high fever." },
    ],
  });

  assert.equal(result.stage.id, "stage-2");
  assert.equal(result.item.id, "account-number");
  assert.equal(result.mode, "collect_missing_slot");
  assert.equal(result.reason, "lead_slot");
});

test("does not suggest a confirmation item when prerequisite slots in that stage are still missing", () => {
  // Earlier stages fully collected so the sequential-leading clamp is inert and
  // this isolates the stage-3 prerequisite-gating behavior.
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {
      greet: { status: "completed" },
      "ask-help": { status: "completed" },
      permission: { status: "completed" },
      "account-number": { status: "completed", extracted_value: "12345" },
      "confirm-account": { status: "completed" },
      "patient-name": { status: "completed", extracted_value: "Jane Doe" },
      dob: { status: "completed", extracted_value: "1988-03-04" },
    },
    slotsFilled: { account_number: "12345", patient_name: "Jane Doe", date_of_birth: "1988-03-04" },
    transcriptions: finalConversation("Can you confirm the patient details before we book the appointment?"),
  });

  assert.equal(result.stage.id, "stage-3");
  assert.equal(result.item.id, "symptoms");
  assert.equal(result.mode, "collect_prerequisite");
  assert.equal(result.blockedItem.id, "confirm-patient");
});

test("advances past a suggested low-confidence slot to the next uncollected slot (does not pin on confirmation)", () => {
  // Updated contract (#1117): a captured low-confidence slot no longer pins the
  // suggested response for confirmation. It advances to the next empty slot;
  // confirmation is deferred until every slot has a value (see next test).
  // Earlier stages are collected so this isolates the stage-3 #1117 behavior.
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {
      greet: { status: "completed" },
      "ask-help": { status: "completed" },
      permission: { status: "completed" },
      "account-number": { status: "completed", extracted_value: "12345" },
      "confirm-account": { status: "completed" },
      "patient-name": {
        status: "suggested",
        extracted_value: "Jane Doe",
        confidence_score: 0.72,
        confidence_threshold: 0.95,
      },
    },
    slotsFilled: { account_number: "12345" },
    transcriptions: finalConversation("The patient information is Jane Doe, she has a high fever."),
  });

  assert.equal(result.stage.id, "stage-3");
  assert.equal(result.item.id, "dob");
  assert.equal(result.mode, "collect_missing_slot");
});

test("confirms a suggested low-confidence slot once every slot has a value, before finalizing", () => {
  // All slots across the workflow are captured; patient-name is still a
  // low-confidence suggestion and the only remaining open item is the
  // confirm-patient action → confirm the slot before that action.
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {
      greet: { status: "completed" },
      "ask-help": { status: "completed" },
      permission: { status: "completed" },
      "account-number": { status: "completed", extracted_value: "123456" },
      "confirm-account": { status: "completed" },
      "patient-name": {
        status: "suggested",
        extracted_value: "Jane Doe",
        confidence_score: 0.72,
        confidence_threshold: 0.95,
      },
      dob: { status: "completed", extracted_value: "1988-03-04" },
      symptoms: { status: "completed", extracted_value: "high fever" },
    },
    slotsFilled: { account_number: "123456", date_of_birth: "1988-03-04", symptoms: "high fever" },
    transcriptions: finalConversation("The patient information is Jane Doe, she has a high fever."),
  });

  assert.equal(result.item.id, "patient-name");
  assert.equal(result.itemStatus.extracted_value, "Jane Doe");
  assert.equal(result.mode, "confirm_slot");
  assert.equal(result.reason, "slot_confirmation_pending");
});

test("tries another matched stage before falling back to the first open workflow item", () => {
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {
      greet: { status: "completed" },
      "ask-help": { status: "completed" },
      permission: { status: "completed" },
      "account-number": { status: "completed", extracted_value: "123456" },
      "confirm-account": { status: "completed" },
      "patient-name": { status: "completed", extracted_value: "Jane Doe" },
    },
    slotsFilled: { account_number: "123456", patient_name: "Jane Doe" },
    transcriptions: finalConversation(
      "The account is verified. For the patient information, her name is Jane Doe and the date of birth is next."
    ),
  });

  assert.equal(result.stage.id, "stage-3");
  assert.equal(result.item.id, "dob");
  assert.equal(result.mode, "collect_missing_slot");
  assert.equal(result.reason, "conversation_stage_match");
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
