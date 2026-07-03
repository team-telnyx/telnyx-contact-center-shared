import test from "node:test";
import assert from "node:assert/strict";
import { resolveSuggestedResponseTarget } from "../lib/agent-assist/suggestion-target-resolver.mjs";

const slot = (id, slot_name, order_index, extra = {}) => ({
  id,
  type: "slot",
  label: slot_name.replace(/_/g, " "),
  slot_name,
  order_index,
  ...extra,
});

const stage = (id, name, order_index, items) => ({ id, name, order_index, items });

const action = (id, label, order_index, type = "action") => ({ id, type, label, order_index });

test("advances past a filled-but-suggested slot to the next empty item (no transcript match → fallback)", () => {
  const stages = [
    stage("s1", "Pickup Location", 0, [
      slot("i1", "pickup_department", 0),
      slot("i2", "pickup_room", 1),
    ]),
  ];
  // i1 is AI-filled below threshold (suggested + value); i2 is empty.
  const itemStatuses = { i1: { status: "suggested", extracted_value: "Emergency room" } };

  const target = resolveSuggestedResponseTarget({ stages, itemStatuses, slotsFilled: {}, transcriptions: [] });
  assert.equal(target?.item.id, "i2", "should target the next EMPTY slot, not the filled suggested one");
  assert.equal(target?.mode, "collect_missing_slot");
});

test("a completed slot is likewise skipped for advancement", () => {
  const stages = [
    stage("s1", "Pickup Location", 0, [
      slot("i1", "pickup_department", 0),
      slot("i2", "pickup_room", 1),
    ]),
  ];
  const itemStatuses = { i1: { status: "completed", extracted_value: "ICU" } };
  const target = resolveSuggestedResponseTarget({ stages, itemStatuses, slotsFilled: {}, transcriptions: [] });
  assert.equal(target?.item.id, "i2");
});

test("when every slot has a value, a low-confidence suggestion is surfaced for confirmation (last)", () => {
  const stages = [
    stage("s1", "Pickup Location", 0, [
      slot("i1", "pickup_department", 0),
      slot("i2", "pickup_room", 1),
    ]),
  ];
  const itemStatuses = {
    i1: { status: "completed", extracted_value: "ICU" },
    i2: { status: "suggested", extracted_value: "412" },
  };
  const target = resolveSuggestedResponseTarget({ stages, itemStatuses, slotsFilled: {}, transcriptions: [] });
  assert.equal(target?.item.id, "i2", "the remaining suggested slot is offered for confirmation");
  assert.equal(target?.mode, "confirm_slot");
});

test("returns null when everything is captured and confirmed", () => {
  const stages = [
    stage("s1", "Pickup Location", 0, [slot("i1", "pickup_department", 0)]),
  ];
  const itemStatuses = { i1: { status: "completed", extracted_value: "ICU" } };
  assert.equal(
    resolveSuggestedResponseTarget({ stages, itemStatuses, slotsFilled: {}, transcriptions: [] }),
    null
  );
});

test("empty workflow item is targeted for collection", () => {
  const stages = [stage("s1", "Pickup Location", 0, [slot("i1", "pickup_department", 0)])];
  const target = resolveSuggestedResponseTarget({ stages, itemStatuses: {}, slotsFilled: {}, transcriptions: [] });
  assert.equal(target?.item.id, "i1");
  assert.equal(target?.mode, "collect_missing_slot");
});

test("within a conversation-matched stage, advances past the suggested slot to the empty one", () => {
  const stages = [
    stage("s2", "Destination", 1, [
      slot("i1", "destination_facility_name", 0),
      slot("i2", "destination_department", 1),
    ]),
  ];
  const itemStatuses = { i1: { status: "suggested", extracted_value: "Tommy Hospital" } };
  // Transcript strongly matches the Destination stage/items so the matched-stage
  // path (not just the fallback) is exercised.
  const transcriptions = [
    { isFinal: true, transcript: "destination facility name department hospital" },
  ];
  const target = resolveSuggestedResponseTarget({ stages, itemStatuses, slotsFilled: {}, transcriptions });
  assert.equal(target?.item.id, "i2", "matched-stage path must also advance past the filled suggested slot");
});

test("a filled-suggested slot in the conversation-matched stage does NOT preempt an empty slot in a later stage", () => {
  const stages = [
    stage("s1", "Pickup Location", 0, [slot("i1", "pickup_department", 0)]),
    stage("s2", "Destination", 1, [slot("i2", "destination_facility", 0)]),
  ];
  // Recent transcript matches the Pickup stage, whose only slot is filled
  // (suggested). The Destination stage still has an empty slot.
  const itemStatuses = { i1: { status: "suggested", extracted_value: "Emergency room" } };
  const transcriptions = [{ isFinal: true, transcript: "pickup location department" }];
  const target = resolveSuggestedResponseTarget({ stages, itemStatuses, slotsFilled: {}, transcriptions });
  assert.equal(target?.item.id, "i2", "must advance to the later empty slot, not confirm the filled one");
  assert.equal(target?.mode, "collect_missing_slot");
});

test("confirmation is only offered once nothing anywhere is left to collect", () => {
  const stages = [
    stage("s1", "Pickup Location", 0, [slot("i1", "pickup_department", 0)]),
    stage("s2", "Destination", 1, [slot("i2", "destination_facility", 0)]),
  ];
  // Both slots have values; i1 is a low-confidence suggestion → confirm it last.
  const itemStatuses = {
    i1: { status: "suggested", extracted_value: "ICU" },
    i2: { status: "completed", extracted_value: "Northwestern" },
  };
  const transcriptions = [{ isFinal: true, transcript: "pickup location department" }];
  const target = resolveSuggestedResponseTarget({ stages, itemStatuses, slotsFilled: {}, transcriptions });
  assert.equal(target?.item.id, "i1");
  assert.equal(target?.mode, "confirm_slot");
});

test("confirms a suggested slot BEFORE a non-slot finalization action", () => {
  const stages = [
    stage("s1", "Clinical", 0, [slot("i1", "iv_count", 0)]),
    stage("s2", "Confirmation", 1, [action("i2", "Thank caller and close", 0)]),
  ];
  // All slots captured; i1 is a low-confidence suggestion. The only open item is
  // the closing action. The suggestion must confirm the slot first.
  const itemStatuses = { i1: { status: "suggested", extracted_value: "2" } };
  const target = resolveSuggestedResponseTarget({ stages, itemStatuses, slotsFilled: {}, transcriptions: [] });
  assert.equal(target?.item.id, "i1", "confirm the suggested slot before finalizing");
  assert.equal(target?.mode, "confirm_slot");
});

test("a non-closing follow-up after the last slot is NOT deferred (continue the workflow)", () => {
  // Seeded workflows put normal follow-up work after the last slot (e.g. an
  // 'Ask clarifying questions' step). Even with the last slot a low-confidence
  // suggestion and nothing else open, that follow-up must run — it is not a
  // read-back/submit/close item, so no confirmation deferral.
  const stages = [
    stage("s1", "Issue", 0, [slot("i1", "issue_category", 0)]),
    stage("s2", "Resolution", 1, [action("q", "Ask clarifying questions", 0, "question")]),
  ];
  const itemStatuses = { i1: { status: "suggested", extracted_value: "Billing" } };
  const target = resolveSuggestedResponseTarget({ stages, itemStatuses, slotsFilled: {}, transcriptions: [] });
  assert.equal(target?.item.id, "q", "continue to the follow-up, not confirm the slot");
  assert.notEqual(target?.mode, "confirm_slot");
});

test("does NOT defer the opening greeting: a non-slot item runs while empty slots remain", () => {
  const stages = [
    stage("s1", "Intent", 0, [
      action("g", "Ask how to assist today", 0, "question"),
      slot("i1", "intent", 1),
    ]),
  ];
  // Nothing captured yet → empty slots still exist → the greeting is NOT deferred.
  const target = resolveSuggestedResponseTarget({ stages, itemStatuses: {}, slotsFilled: {}, transcriptions: [] });
  assert.equal(target?.item.id, "g", "greeting proceeds while empty slots remain");
  assert.notEqual(target?.mode, "confirm_slot");
});

test("a pending opening greeting is NOT deferred even when all slots are pre-filled (AI handoff)", () => {
  // The greeting sits BEFORE the slots. After an AI prefill/handoff, every slot
  // can already have a value (one low-confidence) while the greeting is still
  // pending. The greeting must still run — it is not a finalization item, so the
  // deferral must not fire.
  const stages = [
    stage("s0", "Intent", 0, [action("greet", "Greet the caller", 0, "question")]),
    stage("s1", "Data", 1, [slot("i1", "patient_name", 0), slot("i2", "patient_dob", 1)]),
  ];
  const itemStatuses = {
    i1: { status: "suggested", extracted_value: "Jane Doe" },
    i2: { status: "completed", extracted_value: "1988-03-04" },
  };
  const target = resolveSuggestedResponseTarget({ stages, itemStatuses, slotsFilled: {}, transcriptions: [] });
  assert.equal(target?.item.id, "greet", "opening greeting runs; not deferred to slot confirmation");
  assert.notEqual(target?.mode, "confirm_slot");
});

test("an OPENING item with a closing-ish keyword (before the slots) is NOT finalization", () => {
  // "Thank the customer for calling" / "verify account" contain closing/confirm
  // keywords but sit BEFORE the slots. With an AI prefill (all slots valued, one
  // suggested) and the opening item still pending, it must run — not be treated
  // as a closing step. Guards against keyword-only classification.
  const stages = [
    stage("s0", "Greeting", 0, [
      action("thank", "Thank the customer for calling", 0, "action"),
      action("perm", "Request permission to verify account", 1, "question"),
    ]),
    stage("s1", "Data", 1, [slot("i1", "patient_name", 0)]),
  ];
  const itemStatuses = { i1: { status: "suggested", extracted_value: "Jane Doe" } };
  const target = resolveSuggestedResponseTarget({ stages, itemStatuses, slotsFilled: {}, transcriptions: [] });
  assert.equal(target?.item.id, "thank", "opening thank/verify item runs; not deferred to slot confirmation");
  assert.notEqual(target?.mode, "confirm_slot");
});

test("a non-slot finalization action proceeds once no suggested slots remain", () => {
  const stages = [
    stage("s1", "Clinical", 0, [slot("i1", "iv_count", 0)]),
    stage("s2", "Confirmation", 1, [action("i2", "Thank caller and close", 0)]),
  ];
  // Slot is completed (not a suggestion) → nothing to confirm → run the action.
  const itemStatuses = { i1: { status: "completed", extracted_value: "2" } };
  const target = resolveSuggestedResponseTarget({ stages, itemStatuses, slotsFilled: {}, transcriptions: [] });
  assert.equal(target?.item.id, "i2");
  assert.equal(target?.mode, "continue_workflow");
});

test("slotsFilled value also closes an item for advancement", () => {
  const stages = [
    stage("s1", "Pickup Location", 0, [
      slot("i1", "pickup_department", 0),
      slot("i2", "pickup_room", 1),
    ]),
  ];
  // Value present via slotsFilled map (trusted), no status row.
  const target = resolveSuggestedResponseTarget({
    stages,
    itemStatuses: {},
    slotsFilled: { pickup_department: "ICU" },
    transcriptions: [],
  });
  assert.equal(target?.item.id, "i2");
});
