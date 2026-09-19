import test from "node:test";
import assert from "node:assert/strict";

import { resolveSuggestedResponseTarget, isItemStillRelevantInStage } from "../lib/agent-assist/suggestion-target-resolver.mjs";

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

test("a stuck opening question is skipped once a LATER item in the SAME stage already progressed (Call Intent bug)", () => {
  // Reported live (the reference workflow healthcare intake): agent's one combined opening
  // utterance ("Thanks for calling... how can I help you today?") only
  // completed "Greet caller", leaving "Ask how to assist today" stuck
  // pending — an unreliable non-slot completion detection, same class of
  // issue the other tests in this file already cover for CROSS-stage
  // staleness. Unlike those, here the stuck item and the slot that
  // progressed past it (Call Intent) are in the SAME stage, so the
  // stage-level clamp (leadStageOrder/progressStageOrder) never applies —
  // this needs the item-level fix (isEffectivelyOpen). Once the caller
  // states their intent, the suggestion must advance to "Confirm intent
  // understood", not keep re-suggesting "How can I help you?" verbatim.
  const callerIdStages = [
    {
      id: "caller-id",
      name: "Caller Identification",
      order_index: 0,
      items: [
        { id: "greet", type: "action", label: "Greet caller with brand name", prompt_hint: "hello, this is Acme Air Medical, thank you for calling", order_index: 0 },
        { id: "ask-help", type: "question", label: "Ask how to assist today", prompt_hint: "how can I help, what can I do, assist you with", order_index: 1 },
        { id: "intent", type: "slot", label: "Call intent", slot_name: "intent", prompt_hint: "new transport, request flight, check status", order_index: 2 },
        { id: "confirm-intent", type: "topic", label: "Confirm intent understood", prompt_hint: "so you need, requesting, want to check, let me confirm", order_index: 3 },
        { id: "caller-first-name", type: "slot", label: "Caller First Name", slot_name: "caller_first_name", prompt_hint: "my name is, first name", order_index: 4 },
      ],
    },
  ];
  const itemStatuses = {
    greet: { status: "completed" },
    // "ask-help" deliberately has NO status entry — stuck pending, exactly
    // as when the LLM only flagged one of the two adjacent opening items.
  };
  const slotsFilled = { intent: "request_new_transport" };

  const result = resolveSuggestedResponseTarget({
    stages: callerIdStages,
    itemStatuses,
    slotsFilled,
    transcriptions: finalConversation("I want to request transfer patient to another hospital"),
  });

  assert.equal(result?.item.id, "confirm-intent");
  assert.notEqual(result?.item.id, "ask-help");
});

test("isItemStillRelevantInStage: a stale non-slot suggestion card is dropped once a LATER item in the stage has a value, EVEN if only 'suggested' (not confirmed)", () => {
  // Matches the exact live report: Call Intent was captured at 85% LLM
  // confidence — still status "suggested" pending explicit confirmation,
  // not "completed" — yet the stuck "Ask how to assist today" card (no
  // status at all) must still be dropped from the panel. This is what the
  // UI's Fix-5b cleanup filter calls per suggestion card; unlike the
  // resolver's own leadSlot logic, a "suggested" (unconfirmed) slot value
  // is enough evidence of progress for a NON-slot item, since itemHasCapturedValue
  // already treats a "suggested" slot's extracted_value as captured.
  const stage = {
    id: "caller-id",
    name: "Caller Identification",
    order_index: 0,
    items: [
      { id: "greet", type: "action", label: "Greet caller with brand name", order_index: 0 },
      { id: "ask-help", type: "question", label: "Ask how to assist today", order_index: 1 },
      { id: "intent", type: "slot", label: "Call intent", slot_name: "intent", order_index: 2 },
    ],
  };
  const itemStatuses = {
    greet: { status: "completed" },
    intent: { status: "suggested", extracted_value: "transfer" },
    // "ask-help" has NO status entry at all — matches the live report where
    // it never got marked completed OR suggested by the analyzer.
  };

  const askHelpItem = stage.items.find((i) => i.id === "ask-help");
  assert.equal(isItemStillRelevantInStage(askHelpItem, stage, itemStatuses, {}), false);

  // Sanity check: a SLOT suggestion is untouched by this — it stays
  // "relevant" (still shown) until explicitly confirmed, regardless of
  // whether anything later has progressed.
  const intentItem = stage.items.find((i) => i.id === "intent");
  assert.equal(isItemStillRelevantInStage(intentItem, stage, itemStatuses, {}), true);
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

test("fallback does NOT resurface a stuck opening item (e.g. greeting) once real progress has been made via slots", () => {
  // Reproduces the reported bug: an opening non-slot item ("ask-help") never
  // got marked complete (its completion detection is heuristic/unreliable —
  // see the file-level comment on leadSlot), but the call has since collected
  // slots in TWO later stages. A generic utterance that doesn't strongly
  // match any stage falls through to the fallback — it must continue from
  // where the call actually is (the next open slot), not jump back to the
  // never-resolved greeting from the very start of the call.
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {
      greet: { status: "completed" },
      // ask-help intentionally has no status entry — stuck open, like the
      // real bug report.
      permission: { status: "completed" },
      "account-number": { status: "completed", extracted_value: "12345" },
      "confirm-account": { status: "completed" },
      "patient-name": { status: "completed", extracted_value: "Jane Doe" },
    },
    slotsFilled: { account_number: "12345", patient_name: "Jane Doe" },
    transcriptions: finalConversation("Okay."),
  });

  assert.equal(result.stage.id, "stage-3");
  assert.equal(result.item.id, "dob");
  assert.equal(result.mode, "collect_missing_slot");
  assert.equal(result.reason, "first_open_item");
});

test("a stuck opening item does NOT win a conversation-stage match near call wrap-up, once every slot is filled", () => {
  // Reproduces the reported bug precisely: "Hi, thanks for calling, how can I
  // help you today?" resurfaced in the LAST moment of the call, after every
  // slot had already been filled via real conversation elsewhere. Once every
  // slot has a value, leadStageOrder goes null and the sequential-leading
  // clamp goes fully inert (by design, so confirmation/finalization logic can
  // run) — but common closing language ("is there anything else I can help
  // you with today", "thanks for calling") shares literal keywords with a
  // greeting's own hint text, so it can win a fresh conversation-stage match
  // on its own, with no other stage also matching this turn (so the
  // `jumpedAhead` guard, which requires a later-stage match in the SAME
  // turn, never engages either).
  const closingStages = [
    {
      ...stages[0],
      items: [
        { ...stages[0].items[0], prompt_hint: "hello welcome thanks for calling" },
        { ...stages[0].items[1], prompt_hint: "is there anything else I can help you with today" },
      ],
    },
    stages[1],
    stages[2],
  ];

  const result = resolveSuggestedResponseTarget({
    stages: closingStages,
    itemStatuses: {
      greet: { status: "completed" },
      // ask-help intentionally has no status entry — stuck open, same as the
      // real bug report.
      permission: { status: "completed" },
      "account-number": { status: "completed", extracted_value: "12345" },
      "confirm-account": { status: "completed" },
      "patient-name": { status: "completed", extracted_value: "Jane Doe" },
      dob: { status: "completed", extracted_value: "1988-03-04" },
      symptoms: { status: "completed", extracted_value: "high fever" },
    },
    slotsFilled: {
      account_number: "12345",
      patient_name: "Jane Doe",
      date_of_birth: "1988-03-04",
      symptoms: "high fever",
    },
    transcriptions: finalConversation(
      "Is there anything else I can help you with today? Thanks so much for calling, have a great day!"
    ),
  });

  assert.equal(result.stage.id, "stage-3");
  assert.equal(result.item.id, "confirm-patient");
  assert.notEqual(result.reason, "conversation_stage_match");
});

test("once every slot is filled, an explicit correction request targets the named completed slot directly", () => {
  // Reproduces the reported gap: the caller says "the account number is
  // incorrect, it should be 54321" at read-back. Before this fix, a completed
  // slot was invisible to the resolver entirely (it only ever targets OPEN
  // items) — the suggestion fell back to the read-back/confirm-all item's own
  // line instead of asking what the corrected value should be.
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
      symptoms: { status: "completed", extracted_value: "high fever" },
    },
    slotsFilled: {
      account_number: "12345",
      patient_name: "Jane Doe",
      date_of_birth: "1988-03-04",
      symptoms: "high fever",
    },
    transcriptions: finalConversation("The account number is incorrect, it should be 54321."),
  });

  assert.equal(result.stage.id, "stage-2");
  assert.equal(result.item.id, "account-number");
  assert.equal(result.mode, "collect_correction");
  assert.equal(result.reason, "correction_requested");
});

test("without an explicit correction trigger, merely mentioning a completed slot's value again does NOT hijack the suggestion", () => {
  // Guards against a false positive: the caller re-confirming a value ("yes,
  // the account number is 12345, that's right") must not be mistaken for a
  // correction request just because it names the slot.
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
      symptoms: { status: "completed", extracted_value: "high fever" },
    },
    slotsFilled: {
      account_number: "12345",
      patient_name: "Jane Doe",
      date_of_birth: "1988-03-04",
      symptoms: "high fever",
    },
    transcriptions: finalConversation("Yes, the account number is 12345, that's right."),
  });

  assert.notEqual(result?.mode, "collect_correction");
});

test("correction-targeting stops once the read-back item has already been given the customer's final affirmative", () => {
  // Reproduces the live report: agent asked "Can you confirm all information
  // is correct?", customer said "Yes, all information is correct." (which
  // completed the read-back item) — but earlier in the SAME rolling
  // conversation window, the customer had said "No, something is not
  // correct" while correcting the patient's date of birth. Before this fix,
  // that older trigger phrase (still inside the last-8-utterances window)
  // kept findCorrectionTargetSlot re-matching the now-fully-resolved DOB slot
  // turn after turn, forever — permanently stuck, since that stale target
  // also gets silently discarded downstream (the slot really is "completed"),
  // so "Provide confirmation/reference number" never got a chance to show.
  const readBackStages = [
    {
      id: "s1",
      name: "Patient Information",
      order_index: 0,
      items: [
        { id: "dob", type: "slot", label: "Patient date of birth", slot_name: "patient_dob", prompt_hint: "date of birth, DOB, born", order_index: 0 },
      ],
    },
    {
      id: "s2",
      name: "Confirmation",
      order_index: 1,
      items: [
        { id: "confirm-all", type: "question", label: "Confirm all information is correct", completion_trigger: "customer", order_index: 0 },
        { id: "provide-ref", type: "action", label: "Provide confirmation/reference number", order_index: 1 },
      ],
    },
  ];
  const result = resolveSuggestedResponseTarget({
    stages: readBackStages,
    itemStatuses: {
      dob: { status: "completed", extracted_value: "1965-03-20" },
      "confirm-all": { status: "completed", extracted_value: true, completed_by: "customer" },
    },
    slotsFilled: { patient_dob: "1965-03-20" },
    transcriptions: finalConversation(
      "No, something is not correct. Date of birth is March twentieth nineteen sixty five. Yes, all information is correct."
    ),
  });

  assert.notEqual(result?.mode, "collect_correction");
  assert.equal(result.stage.id, "s2");
  assert.equal(result.item.id, "provide-ref");
});

test("an agent-completed read-back RECITATION item does NOT gate off corrections before the customer's own confirmation", () => {
  // Split-item workflow: the agent completes "Read back transport details"
  // (completion_trigger: agent) themselves while reciting, BEFORE the
  // customer has said anything. Both this item and "Confirm all information
  // is correct" match isReadBackItem (it keys off "read back" phrasing too),
  // but only the customer's own item is the actual sign-off. Gating on any
  // read-back-matching item completing — instead of specifically the
  // customer's — would freeze correction-targeting the instant the agent
  // starts reciting, even though the customer hasn't confirmed anything yet.
  const readBackStages = [
    {
      id: "s1",
      name: "Patient Information",
      order_index: 0,
      items: [
        { id: "dob", type: "slot", label: "Patient date of birth", slot_name: "patient_dob", prompt_hint: "date of birth, DOB, born", order_index: 0 },
      ],
    },
    {
      id: "s2",
      name: "Confirmation",
      order_index: 1,
      items: [
        { id: "read-back", type: "action", label: "Read back transport details", completion_trigger: "agent", order_index: 0 },
        { id: "confirm-all", type: "question", label: "Confirm all information is correct", completion_trigger: "customer", order_index: 1 },
      ],
    },
  ];
  const result = resolveSuggestedResponseTarget({
    stages: readBackStages,
    itemStatuses: {
      dob: { status: "completed", extracted_value: "1965-03-20" },
      "read-back": { status: "completed" },
    },
    slotsFilled: { patient_dob: "1965-03-20" },
    transcriptions: finalConversation(
      "Wait, that's not correct, the date of birth should be March twentieth nineteen seventy."
    ),
  });

  assert.equal(result.mode, "collect_correction");
  assert.equal(result.item.id, "dob");
});

function readBackEitherStages() {
  return [
    {
      id: "s1",
      name: "Patient Information",
      order_index: 0,
      items: [
        { id: "dob", type: "slot", label: "Patient date of birth", slot_name: "patient_dob", prompt_hint: "date of birth, DOB, born", order_index: 0 },
      ],
    },
    {
      id: "s2",
      name: "Confirmation",
      order_index: 1,
      items: [
        { id: "confirm-all", type: "question", label: "Confirm all information is correct", completion_trigger: "either", order_index: 0 },
        { id: "provide-ref", type: "action", label: "Provide confirmation/reference number", order_index: 1 },
      ],
    },
  ];
}

test("a completion_trigger 'either' confirmation item gates corrections off when the CUSTOMER completed it", () => {
  // Some workflows let either party complete the final confirmation item.
  // The gate must key on who actually completed it (completed_by), not just
  // that the trigger admits the customer — a customer completion should
  // still gate corrections off.
  const result = resolveSuggestedResponseTarget({
    stages: readBackEitherStages(),
    itemStatuses: {
      dob: { status: "completed", extracted_value: "1965-03-20" },
      "confirm-all": { status: "completed", extracted_value: true, completed_by: "customer" },
    },
    slotsFilled: { patient_dob: "1965-03-20" },
    transcriptions: finalConversation(
      "No, something is not correct. Date of birth is March twentieth nineteen sixty five. Yes, all information is correct."
    ),
  });

  assert.notEqual(result?.mode, "collect_correction");
  assert.equal(result.stage.id, "s2");
  assert.equal(result.item.id, "provide-ref");
});

test("a completion_trigger 'either' confirmation item does NOT gate corrections off when the AGENT completed it", () => {
  // The reported gap: an "either" item can complete from the AGENT's own
  // utterance, not just the customer's. That must not be read as the
  // customer's sign-off — the caller's own correction request right after
  // must still be collectible.
  const result = resolveSuggestedResponseTarget({
    stages: readBackEitherStages(),
    itemStatuses: {
      dob: { status: "completed", extracted_value: "1965-03-20" },
      "confirm-all": { status: "completed", extracted_value: true, completed_by: "agent" },
    },
    slotsFilled: { patient_dob: "1965-03-20" },
    transcriptions: finalConversation(
      "Wait, that's not correct, the date of birth should be March twentieth nineteen seventy."
    ),
  });

  assert.equal(result.mode, "collect_correction");
  assert.equal(result.item.id, "dob");
});

test("a stuck opening item does NOT win a conversation-stage match MID-CALL either, once real progress has been made", () => {
  // Reported live: "Hi, thanks for calling. How can I help you today?"
  // resurfaced in the middle of Pickup Location questions — not at the end of
  // the call. The earlier wrap-up fix only guarded the leadStageOrder-null
  // (every slot filled) case; mid-call, leadStageOrder is still set (dob is
  // still open), and the ONLY existing protection for a stale earlier-stage
  // match (jumpedAhead) requires the SAME utterance to ALSO match a later
  // stage. Here nothing else matches this turn, so without the fix the stuck
  // "ask-help" item wins purely because it's the only match.
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {
      greet: { status: "completed" },
      // ask-help intentionally has no status entry — stuck open.
      permission: { status: "completed" },
      "account-number": { status: "completed", extracted_value: "12345" },
      "confirm-account": { status: "completed" },
      "patient-name": { status: "completed", extracted_value: "Jane Doe" },
      // dob and symptoms remain open — this is mid-call, not read-back.
    },
    slotsFilled: { account_number: "12345", patient_name: "Jane Doe" },
    transcriptions: finalConversation("Thanks, how can I help with that?"),
  });

  assert.notEqual(result?.stage?.id, "stage-1");
  assert.equal(result.stage.id, "stage-3");
  assert.equal(result.item.id, "dob");
});

test("a stuck opening item does NOT resurface on a QUIET turn (no stage match at all) once every slot is filled, in a real call", () => {
  // Reported live: the greeting resurfaced between "Trip Notes & Air Safety"
  // and read-back — i.e. right after the LAST slot was collected, on a turn
  // that didn't happen to match any stage strongly at all (matchedStages
  // empty), not via a coincidental keyword match. The earlier wrap-up fix
  // only clamped the fallback when the primary loop had just suppressed a
  // live stage match this same turn (suppressedStaleMatch) — a quiet/
  // non-matching turn set that flag to its initial `false`, so the fallback
  // fell back to `hasAnyCollectedSlot(...) ? leadStageOrder : null`, and
  // leadStageOrder is ALSO null at this point (every slot filled) — so the
  // floor silently evaluated to null (fully unclamped) regardless of real
  // conversation history, letting firstOpenWorkflowItem walk back to the
  // stuck opening item from the very start of the call.
  const result = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {
      greet: { status: "completed" },
      // ask-help intentionally has no status entry — stuck open.
      permission: { status: "completed" },
      "account-number": { status: "completed", extracted_value: "12345" },
      "confirm-account": { status: "completed" },
      "patient-name": { status: "completed", extracted_value: "Jane Doe" },
      dob: { status: "completed", extracted_value: "1988-03-04" },
      symptoms: { status: "completed", extracted_value: "high fever" },
    },
    slotsFilled: {
      account_number: "12345",
      patient_name: "Jane Doe",
      date_of_birth: "1988-03-04",
      symptoms: "high fever",
    },
    // Deliberately generic — must not match any stage (matchedStages empty) —
    // while still being a REAL utterance in an ongoing call, unlike the
    // AI-handoff case which has transcriptions: [] (nothing said at all).
    transcriptions: finalConversation("Okay, one moment please."),
  });

  assert.notEqual(result?.stage?.id, "stage-1");
  assert.equal(result.stage.id, "stage-3");
  assert.equal(result.item.id, "confirm-patient");
});
