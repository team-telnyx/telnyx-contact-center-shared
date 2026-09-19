import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDICAL_TRANSPORT_INTAKE_WORKFLOW,
  DEMO_CLID_PREFILL,
} from "../lib/medical-transport-intake-workflow.mjs";

test("the reference workflow workflow has six stages: Caller ID, Pickup, Destination, Patient, Transport Details, Confirmation", () => {
  assert.equal(MEDICAL_TRANSPORT_INTAKE_WORKFLOW.stages.length, 6);
  assert.equal(MEDICAL_TRANSPORT_INTAKE_WORKFLOW.name, "Healthcare Intake (Air Ambulance)");
  assert.deepEqual(
    MEDICAL_TRANSPORT_INTAKE_WORKFLOW.stages.map((s) => s.name),
    [
      "Caller Identification",
      "Pickup Information",
      "Destination Information",
      "Patient Information",
      "Transport Details",
      "Confirmation",
    ]
  );
});

test("the reference workflow workflow includes the granular pickup/destination location fields and physicians", () => {
  const slotNames = MEDICAL_TRANSPORT_INTAKE_WORKFLOW.stages.flatMap((stage) =>
    stage.items.filter((i) => i.type === "slot").map((i) => i.slot_name),
  );
  for (const name of [
    "intent",
    "caller_first_name",
    "caller_last_name",
    "caller_facility",
    "callback_number",
    "pickup_same_as_requesting_facility",
    "pickup_facility",
    "pickup_address",
    "pickup_department",
    "pickup_room",
    "pickup_bed",
    "sending_physician",
    "destination_facility",
    "destination_address",
    "destination_department",
    "destination_room",
    "destination_bed",
    "receiving_physician",
    "transport_timing",
    "patient_name",
    "patient_dob",
    "patient_weight",
    "transport_reason",
    "iv_count",
    "special_equipment",
    "accompanying",
    "trip_notes",
    "weather_declined",
    "other_aircraft",
  ]) {
    assert.ok(slotNames.includes(name), `missing slot ${name}`);
  }
  // The old combined "pickup department or room" catch-all slot is gone,
  // replaced by the separate pickup_department/pickup_room/pickup_bed slots.
  assert.ok(!slotNames.includes("pickup_location"));
});

test("the reference workflow workflow asks call intent before caller name, facility, and callback number", () => {
  const openingSlots = MEDICAL_TRANSPORT_INTAKE_WORKFLOW.stages[0].items
    .filter((item) => item.type === "slot")
    .sort((a, b) => a.order_index - b.order_index)
    .map((item) => item.slot_name);

  assert.deepEqual(openingSlots, [
    "intent",
    "caller_first_name",
    "caller_last_name",
    "caller_facility",
    "callback_number",
  ]);
});

test("Pickup Information stage asks same-as-requesting-facility, then facility, address, department, room, bed, then sending physician", () => {
  const pickupSlots = MEDICAL_TRANSPORT_INTAKE_WORKFLOW.stages[1].items
    .filter((item) => item.type === "slot")
    .sort((a, b) => a.order_index - b.order_index)
    .map((item) => item.slot_name);

  assert.deepEqual(pickupSlots, [
    "pickup_same_as_requesting_facility",
    "pickup_facility",
    "pickup_address",
    "pickup_department",
    "pickup_room",
    "pickup_bed",
    "sending_physician",
  ]);
});

test("Destination Information stage collects facility, address, department, room, bed, receiving physician, then timing", () => {
  const destinationSlots = MEDICAL_TRANSPORT_INTAKE_WORKFLOW.stages[2].items
    .filter((item) => item.type === "slot")
    .sort((a, b) => a.order_index - b.order_index)
    .map((item) => item.slot_name);

  assert.deepEqual(destinationSlots, [
    "destination_facility",
    "destination_address",
    "destination_department",
    "destination_room",
    "destination_bed",
    "receiving_physician",
    "transport_timing",
  ]);
});

test("the confirm-all read-back item requires the customer's own affirmative (completion_trigger: customer)", () => {
  // The customer's own sign-off — not the agent's recitation — is what must
  // gate correction-targeting and unlock the reference/closing steps (see
  // readBackAlreadyConfirmed in suggestion-target-resolver.mjs).
  const confirmationStage = MEDICAL_TRANSPORT_INTAKE_WORKFLOW.stages.find((s) => s.name === "Confirmation");
  const confirmAllItem = confirmationStage.items.find((i) => i.label === "Confirm all information is correct");
  assert.equal(confirmAllItem.completion_trigger, "customer");

  const readBackItem = confirmationStage.items.find((i) => i.label === "Read back transport details");
  assert.equal(readBackItem.completion_trigger, "agent");
});

test("llm_model uses the provider-prefixed id convention used everywhere else in the codebase", () => {
  // The analyze/generate-suggestion routes pass workflow.llm_model straight
  // through to the Telnyx /ai/chat/completions model field. Every other
  // default in the codebase is provider-prefixed ("openai/gpt-4o"); a bare
  // "gpt-4o-mini" (no prefix) can be rejected or silently fall back.
  assert.equal(MEDICAL_TRANSPORT_INTAKE_WORKFLOW.llm_model, "openai/gpt-4o-mini");
});

test("option slots use slot_type 'select' (the only option-bearing type the admin editor supports) with slot_options as a plain array", () => {
  // workflow-prompts.js only emits the "Allowed options" line for
  // Array.isArray(item.slot_options) — slot_type doesn't matter there. But
  // the admin editor (app/(portal)/admin/workflows/[id]/page.jsx) only
  // recognizes "select" as an option-bearing type; its save handler sends
  // slot_options: null whenever form.slot_type !== "select". Seeding these
  // as slot_type: "enum" meant ANY admin edit+save of one of these items
  // (even just the label) would silently wipe out its configured options.
  const enumItems = MEDICAL_TRANSPORT_INTAKE_WORKFLOW.stages
    .flatMap((s) => s.items)
    .filter((i) => i.slot_type === "select");
  assert.ok(enumItems.length >= 3, "expected at least intent/transport_timing/transport_reason");
  assert.ok(
    !MEDICAL_TRANSPORT_INTAKE_WORKFLOW.stages.flatMap((s) => s.items).some((i) => i.slot_type === "enum"),
    "no item should use slot_type 'enum' — the admin editor doesn't preserve its options"
  );
  for (const item of enumItems) {
    assert.ok(Array.isArray(item.slot_options), `${item.slot_name} slot_options must be an array`);
    assert.ok(item.slot_options.length > 0);
  }
});

test("the reference workflow demo CLID prefill includes Appendix A sample numbers", () => {
  assert.ok(DEMO_CLID_PREFILL["5555550142"]?.caller_first_name);
  assert.ok(DEMO_CLID_PREFILL["5555550143"]?.caller_facility);
});
